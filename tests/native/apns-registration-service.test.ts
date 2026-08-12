import { generateKeyPairSync } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';
process.env.APNS_TEAM_ID = 'ABCDEFGHIJ';
process.env.APNS_KEY_ID = 'KLMNOPQRST';
process.env.APNS_TOPIC = 'com.example.missioncontrol';
process.env.APNS_ENVIRONMENT = 'production';
process.env.APNS_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
process.env.MC_PUBLIC_URL = 'https://mc.example.com';
process.env.APNS_PRIVATE_KEY_P8_BASE64 = Buffer.from(
  generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({
    type: 'pkcs8',
    format: 'pem',
  }),
).toString('base64');

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let eq: typeof import('drizzle-orm').eq;
let service: typeof import('@/lib/native/apns-registration-service');
let installationAuth: typeof import('@/lib/native/installation-auth');
let sender: typeof import('@/lib/push/apns-sender');
let notificationService: typeof import('@/lib/notifications/service');
let dispatcher: typeof import('@/lib/push/dispatcher');

const credentialId = '83c45840-a47f-4269-aae9-5a3f4fbd220b';
const installationId = '570ce945-1433-40f3-92c6-af7c14343acd';
const token = `mc_install_v1.${credentialId}.${'a'.repeat(43)}`;
const deviceToken = 'ab'.repeat(32);
const baseTime = new Date('2026-08-02T12:00:00.000Z');

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  schema = await import('@/db/schema');
  ({ eq } = await import('drizzle-orm'));
  service = await import('@/lib/native/apns-registration-service');
  installationAuth = await import('@/lib/native/installation-auth');
  sender = await import('@/lib/push/apns-sender');
  notificationService = await import('@/lib/notifications/service');
  dispatcher = await import('@/lib/push/dispatcher');
});

beforeEach(() => {
  db.delete(schema.nativePushRequests).run();
  db.delete(schema.apnsRegistrations).run();
  db.delete(schema.nativeInstallationCredentials).run();
  db.delete(schema.nativeShareCredentials).run();
  db.delete(schema.notificationDeliveryEvents).run();
  db.delete(schema.notifications).run();
  db.delete(schema.pushSubscriptions).run();
  db.delete(schema.pushPreferences).run();
  db.delete(schema.appSettings).run();
  db.insert(schema.nativeInstallationCredentials).values({
    id: credentialId,
    installationId,
    tokenHash: installationAuth.hashNativeInstallationCredential(token),
    scopes: [
      'push:register',
      'push:unregister',
      'credentials:rotate',
      'credentials:revoke',
    ],
    issuedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:00:00.000Z',
    revokedAt: null,
  }).run();
});

function registrationBody(requestId = '8cf177a0-e46a-46fa-824c-4c34004e2423') {
  return {
    version: 1,
    requestId,
    installationId,
    deviceToken,
    environment: 'production',
    topic: 'com.example.missioncontrol',
    appVersion: '1.0.0',
    buildNumber: 42,
    locale: 'en-US',
    timeZone: 'America/New_York',
  } as const;
}

function request(requestId: string, method = 'POST') {
  return new Request('https://mc.example.com/api/native/push/registrations', {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': requestId,
    },
  });
}

describe('native APNs registration lifecycle', () => {
  it('authenticates, encrypts tokens, and returns an exact idempotent replay', async () => {
    const body = registrationBody();
    const first = await service.processApnsRegistration(
      request(body.requestId),
      body,
      baseTime,
    );
    const duplicate = await service.processApnsRegistration(
      request(body.requestId),
      body,
      new Date(baseTime.getTime() + 1_000),
    );
    const row = db.select().from(schema.apnsRegistrations).get()!;

    expect(first.status).toBe(201);
    expect(duplicate).toEqual(first);
    expect(row.tokenCiphertext).not.toContain(deviceToken);
    expect(service.decryptApnsDeviceToken(row.tokenCiphertext)).toBe(deviceToken);
    expect(JSON.stringify(row)).not.toContain(deviceToken);
  });

  it('rotates a changed token in place and rejects request ID content reuse', async () => {
    const firstBody = registrationBody();
    const first = await service.processApnsRegistration(
      request(firstBody.requestId),
      firstBody,
      baseTime,
    );
    const rotationBody = {
      ...registrationBody('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
      deviceToken: 'cd'.repeat(32),
    };
    const rotated = await service.processApnsRegistration(
      request(rotationBody.requestId),
      rotationBody,
      new Date(baseTime.getTime() + 1_000),
    );
    const replay = await service.processApnsRegistration(
      request(rotationBody.requestId),
      { ...rotationBody, locale: 'fr-FR' },
      new Date(baseTime.getTime() + 2_000),
    );

    expect(rotated.body).toMatchObject({
      data: {
        registrationId: (first.body.data as { registrationId: string }).registrationId,
        state: 'rotated',
      },
    });
    expect(replay).toMatchObject({
      status: 409,
      body: { error: { code: 'REPLAY_DETECTED' } },
    });
  });

    it('retires a token reassigned to a new installation after reinstall', async () => {
      const firstBody = registrationBody();
      await service.processApnsRegistration(request(firstBody.requestId), firstBody, baseTime);
      const secondCredentialId = '77777777-7777-4777-8777-777777777777';
      const secondInstallationId = '66666666-6666-4666-8666-666666666666';
      const secondToken = `mc_install_v1.${secondCredentialId}.${'c'.repeat(43)}`;
      db.insert(schema.nativeInstallationCredentials).values({
        id: secondCredentialId,
        installationId: secondInstallationId,
        tokenHash: installationAuth.hashNativeInstallationCredential(secondToken),
        scopes: [
          'push:register',
          'push:unregister',
          'credentials:rotate',
          'credentials:revoke',
        ],
        issuedAt: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-10-01T00:00:00.000Z',
        revokedAt: null,
      }).run();
      const secondBody = {
        ...registrationBody('99999999-9999-4999-8999-999999999999'),
        installationId: secondInstallationId,
      };
      const secondRequest = new Request(
        'https://mc.example.com/api/native/push/registrations',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${secondToken}`,
            'idempotency-key': secondBody.requestId,
          },
        },
      );

      await service.processApnsRegistration(
        secondRequest,
        secondBody,
        new Date(baseTime.getTime() + 1_000),
      );
      const rows = db.select().from(schema.apnsRegistrations).all();

      expect(rows).toHaveLength(2);
      expect(rows.find(row => row.installationId === installationId)).toMatchObject({
        invalidationReason: 'token_reassigned',
      });
      expect(rows.find(row => row.installationId === secondInstallationId)?.invalidatedAt)
        .toBeNull();
    });

  it('requires installation-bound scopes and unregisters idempotently', async () => {
    const body = registrationBody();
    const registered = await service.processApnsRegistration(
      request(body.requestId),
      body,
      baseTime,
    );
    const registrationId = (registered.body.data as { registrationId: string }).registrationId;
    const unregister = {
      version: 1,
      requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      installationId,
      registrationId,
    } as const;
    const first = await service.processApnsUnregistration(
      request(unregister.requestId, 'DELETE'),
      unregister,
      registrationId,
      new Date(baseTime.getTime() + 1_000),
    );
    const duplicate = await service.processApnsUnregistration(
      request(unregister.requestId, 'DELETE'),
      unregister,
      registrationId,
      new Date(baseTime.getTime() + 2_000),
    );

    expect(first).toEqual(duplicate);
    expect(db.select().from(schema.apnsRegistrations).get()).toMatchObject({
      invalidationReason: 'user_unregistered',
    });
  });

    it('rejects invalid bearer material and cross-installation registration', async () => {
      const body = registrationBody();
      const wrongTokenRequest = new Request(
        'https://mc.example.com/api/native/push/registrations',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer mc_install_v1.${credentialId}.${'b'.repeat(43)}`,
            'idempotency-key': body.requestId,
          },
        },
      );
      const unauthorized = await service.processApnsRegistration(
        wrongTokenRequest,
        body,
        baseTime,
      );
      const otherInstallation = {
        ...registrationBody('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
        installationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      };
      const forbidden = await service.processApnsRegistration(
        request(otherInstallation.requestId),
        otherInstallation,
        baseTime,
      );

      expect(unauthorized).toMatchObject({
        status: 401,
        body: { error: { code: 'UNAUTHORIZED' } },
      });
      expect(forbidden).toMatchObject({
        status: 403,
        body: { error: { code: 'FORBIDDEN' } },
      });
    });

  it('atomically retires registrations and credentials on logout', async () => {
    const body = registrationBody();
    await service.processApnsRegistration(request(body.requestId), body, baseTime);
    db.insert(schema.nativeShareCredentials).values({
      id: '99999999-9999-4999-8999-999999999999',
      installationId,
      tokenHash: 'share-token-hash',
      scope: 'triage:capture',
      issuedAt: baseTime.toISOString(),
      expiresAt: '2026-10-01T00:00:00.000Z',
      revokedAt: null,
    }).run();
    const logoutBody = {
      version: 1,
      requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      installationId,
    } as const;
    const result = await service.processNativeLogout(
      request(logoutBody.requestId),
      logoutBody,
      new Date(baseTime.getTime() + 1_000),
    );

    expect(result).toMatchObject({
      status: 200,
      body: { data: { credentialsRevoked: 2, registrationsRetired: 1 } },
    });
    expect(db.select().from(schema.apnsRegistrations).get()).toMatchObject({
      invalidationReason: 'logout',
    });
  });
});

describe('APNs durable delivery channel', () => {
  async function register() {
    const body = registrationBody();
    await service.processApnsRegistration(request(body.requestId), body, baseTime);
  }

  it('creates redacted Web Push and APNs intents through the central service', async () => {
    await register();
    db.insert(schema.pushSubscriptions).values({
      id: 'web-subscription',
      platform: 'web',
      endpoint: 'https://fcm.googleapis.com/fcm/send/example',
      keys: { p256dh: 'public', auth: 'secret' },
      userAgent: 'test',
      createdAt: baseTime.toISOString(),
    }).run();
    const scheduledTypes = [
      ['morning_start_day', '/today'],
      ['triage_nudge', '/triage'],
      ['carry_forward', '/today'],
    ] as const;

    for (const [templateKey, navigationTarget] of scheduledTypes) {
      const result = await notificationService.createNotification({
        sourceId: `${templateKey}:source`,
        connectorType: 'system',
        connectorInstanceId: 'push-triggers',
        title: `${templateKey} token=must-not-leak`,
        body: 'Bearer secret-value',
        level: templateKey === 'morning_start_day' ? 'fyi' : 'heads_up',
        templateKey,
        navigationTarget,
      }, {
        now: baseTime,
        timezone: 'UTC',
        channelConfigured: true,
        apnsConfigured: true,
        wakeDispatcher: false,
      });
      expect(result.deliveryEvents).toEqual(expect.arrayContaining([
        expect.objectContaining({ channel: 'web_push', status: 'pending' }),
        expect.objectContaining({ channel: 'apns', status: 'pending' }),
      ]));
      expect(JSON.stringify(result.deliveryEvents)).not.toContain('must-not-leak');
      expect(JSON.stringify(result.deliveryEvents)).not.toContain('secret-value');
    }
  });

  it('maps safe native links and omits unsafe destinations', () => {
    expect(sender.resolveApnsDeepLink('/today?focus=1')).toBe('mc://view/today?focus=1');
    expect(sender.resolveApnsDeepLink('/notifications?id=abc')).toBe(
      'https://mc.example.com/notifications?id=abc',
    );
    expect(sender.resolveApnsDeepLink('/api/private')).toBeNull();
    expect(sender.buildApnsPayload({
      notificationId: '12345678-1234-4123-8123-123456789012',
      title: 'Safe title',
      tag: 'mc:test',
      url: '/triage',
    })).toMatchObject({
      mc: { deepLink: 'mc://view/triage' },
    });
  });

  it('builds APNs HTTP/2 headers without leaking provider state into the payload', async () => {
    await register();
    const registration = db.select().from(schema.apnsRegistrations).get()!;
    const payload = sender.buildApnsPayload({
      notificationId: '12345678-1234-4123-8123-123456789012',
      title: 'Safe title',
      tag: 'mc:test',
      url: '/today',
    });

    expect(sender.buildApnsRequestHeaders(
      registration,
      deviceToken,
      payload,
      'provider-jwt',
    )).toEqual({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      authorization: 'bearer provider-jwt',
      'apns-topic': 'com.example.missioncontrol',
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'apns-id': '12345678-1234-4123-8123-123456789012',
    });
    expect(JSON.stringify(payload)).not.toContain('provider-jwt');
    expect(JSON.stringify(payload)).not.toContain(deviceToken);
  });

  it('retries transient failures and retires permanent invalid tokens', async () => {
    await register();
    const transient = await sender.sendApnsPayload({
      notificationId: '12345678-1234-4123-8123-123456789012',
      title: 'Test',
      tag: 'mc:test',
      url: '/today',
    }, {
      now: () => baseTime,
      send: vi.fn(async () => ({ status: 503, reason: 'ServiceUnavailable' })),
    });

    expect(transient).toMatchObject({
      transientFailures: 1,
      permanentFailures: 0,
    });
    expect(db.select().from(schema.apnsRegistrations).get()?.invalidatedAt).toBeNull();

    const invalid = await sender.sendApnsPayload({
      notificationId: '12345678-1234-4123-8123-123456789012',
      title: 'Test',
      tag: 'mc:test',
      url: '/today',
    }, {
      now: () => new Date(baseTime.getTime() + 1_000),
      send: vi.fn(async () => ({ status: 410, reason: 'Unregistered' })),
    });
    expect(invalid).toMatchObject({
      transientFailures: 0,
      permanentFailures: 1,
      expiredSubscriptions: 1,
    });
    expect(db.select().from(schema.apnsRegistrations).where(
      eq(schema.apnsRegistrations.installationId, installationId),
    ).get()).toMatchObject({
      invalidationReason: 'Unregistered',
    });
  });

  it('persists bounded APNs retries and final invalid-token outcomes in the outbox', async () => {
    await register();
    const result = await notificationService.createNotification({
      sourceId: 'apns:durable-outcome',
      connectorType: 'system',
      connectorInstanceId: 'push-triggers',
      title: 'Carry forward',
      level: 'heads_up',
      templateKey: 'carry_forward',
      navigationTarget: '/today',
    }, {
      now: baseTime,
      timezone: 'UTC',
      channelConfigured: false,
      apnsConfigured: true,
      wakeDispatcher: false,
    });
    const apnsEvent = result.deliveryEvents.find(event => event.channel === 'apns')!;
    const transientSender = (
      payload: import('@/lib/notifications/service').MissionControlPushPayload,
    ) => sender.sendApnsPayload(payload, {
      now: () => baseTime,
      send: vi.fn(async () => ({ status: 503, reason: 'ServiceUnavailable' })),
    });

    await dispatcher.dispatchNotificationDeliveries({
      now: () => baseTime,
      retryBaseMs: 1_000,
      apnsSender: transientSender,
    });
    expect(db.select().from(schema.notificationDeliveryEvents).where(
      eq(schema.notificationDeliveryEvents.id, apnsEvent.id),
    ).get()).toMatchObject({
      status: 'pending',
      attemptCount: 1,
      nextAttemptAt: '2026-08-02T12:00:01.000Z',
      lastError: 'transient_delivery_failure',
    });

    await dispatcher.dispatchNotificationDeliveries({
      now: () => new Date(baseTime.getTime() + 1_000),
      apnsSender: payload => sender.sendApnsPayload(payload, {
        now: () => new Date(baseTime.getTime() + 1_000),
        send: vi.fn(async () => ({ status: 410, reason: 'Unregistered' })),
      }),
    });
    expect(db.select().from(schema.notificationDeliveryEvents).where(
      eq(schema.notificationDeliveryEvents.id, apnsEvent.id),
    ).get()).toMatchObject({
      status: 'failed',
      attemptCount: 2,
      lastError: 'permanent_delivery_failure',
    });
    expect(db.select().from(schema.apnsRegistrations).get()).toMatchObject({
      invalidationReason: 'Unregistered',
    });
  });

  it.each([
    [200, null, 'sent'],
    [429, 'TooManyRequests', 'transient'],
    [400, 'BadDeviceToken', 'invalid_token'],
    [403, 'InvalidProviderToken', 'permanent'],
  ] as const)('classifies APNs %s %s as %s', (status, reason, outcome) => {
    expect(sender.classifyApnsResponse(status, reason).outcome).toBe(outcome);
  });
});
