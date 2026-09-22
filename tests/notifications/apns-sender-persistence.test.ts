import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationDeliveryRepository } from '@/db/persistence/notification-delivery';

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(),
  list: vi.fn(),
}));

vi.mock('jose', () => ({
  importPKCS8: vi.fn(async () => ({})),
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }

    setIssuer() {
      return this;
    }

    setIssuedAt() {
      return this;
    }

    async sign() {
      return 'provider-token';
    }
  },
}));

vi.mock('@/lib/push/apns-config', () => ({
  apnsEndpoint: () => 'https://api.sandbox.push.apple.com',
  getApnsConfiguration: () => ({
    teamId: 'TEAMID1234',
    keyId: 'KEYID12345',
    privateKey: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----',
    topic: 'app.mission-control.test',
    environment: 'development',
    tokenEncryptionKey: Buffer.alloc(32, 7),
  }),
}));

const payload = {
  notificationId: 'notification-apns',
  title: 'Portable notification',
  tag: 'mc:notification-apns',
  url: '/notifications?id=notification-apns',
};

function repository(): NotificationDeliveryRepository {
  return {
    claimNext: vi.fn(),
    resolveSuppression: vi.fn(),
    finalize: vi.fn(),
    scheduleRetry: vi.fn(),
    getNextWakeAt: vi.fn(),
    listWebPushSubscriptions: vi.fn(),
    retireWebPushSubscription: vi.fn(),
    listApnsRegistrations: mocks.list,
    invalidateApnsRegistration: mocks.invalidate,
  } as NotificationDeliveryRepository;
}

beforeEach(() => {
  mocks.invalidate.mockReset().mockResolvedValue(true);
  mocks.list.mockReset();
});

describe('APNs sender portable persistence', () => {
  it('invalidates unreadable encrypted token material without contacting APNs', async () => {
    mocks.list.mockResolvedValue([{
      id: 'registration-unreadable',
      tokenCiphertext: 'invalid',
      environment: 'development',
      topic: 'app.mission-control.test',
    }]);
    const send = vi.fn();
    const { sendApnsPayload } = await import('@/lib/push/apns-sender');

    const result = await sendApnsPayload(payload, {
      repository: repository(),
      send,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    expect(send).not.toHaveBeenCalled();
    expect(mocks.invalidate).toHaveBeenCalledWith({
      id: 'registration-unreadable',
      invalidatedAt: '2026-08-31T12:00:00.000Z',
      reason: 'token_decryption_failed',
    });
    expect(result).toMatchObject({
      attempted: 1,
      failed: 1,
      permanentFailures: 1,
    });
  });

  it('invalidates provider-rejected device tokens through the repository', async () => {
    const { encryptApnsDeviceToken } = await import('@/lib/native/apns-token-crypto');
    mocks.list.mockResolvedValue([{
      id: 'registration-invalid',
      tokenCiphertext: encryptApnsDeviceToken('a'.repeat(64)),
      environment: 'development',
      topic: 'app.mission-control.test',
    }]);
    const { sendApnsPayload } = await import('@/lib/push/apns-sender');

    const result = await sendApnsPayload(payload, {
      repository: repository(),
      send: vi.fn(async () => ({ status: 410, reason: 'Unregistered' })),
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    expect(mocks.invalidate).toHaveBeenCalledWith({
      id: 'registration-invalid',
      invalidatedAt: '2026-08-31T12:00:00.000Z',
      reason: 'Unregistered',
    });
    expect(result).toMatchObject({
      attempted: 1,
      failed: 1,
      permanentFailures: 1,
      expiredSubscriptions: 1,
    });
  });
});
