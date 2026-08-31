import 'server-only';

import {
  connect,
  constants,
  type ClientHttp2Session,
} from 'node:http2';
import { importPKCS8, SignJWT } from 'jose';
import type {
  ApnsRegistrationRecord,
  NotificationDeliveryRepository,
} from '@/db/persistence/notification-delivery';
import {
  classifyNativeNavigation,
  normalizeNativeTrustedOrigin,
} from '@/lib/native/contract';
import { decryptApnsDeviceToken } from '@/lib/native/apns-token-crypto';
import type { MissionControlPushPayload } from '@/lib/notifications/push-payload';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import logger from '@/lib/logger';
import {
  apnsEndpoint,
  getApnsConfiguration,
  type ApnsConfiguration,
} from './apns-config';
import type { PushSendResult } from './web-push-sender';

interface ApnsProviderResponse {
  status: number;
  reason: string | null;
}

export interface ApnsResponseClassification {
  outcome: 'sent' | 'transient' | 'invalid_token' | 'permanent';
  reason: string | null;
}

export interface ApnsSenderDependencies {
  send?: (
    configuration: ApnsConfiguration,
    registration: ApnsRegistrationRecord,
    deviceToken: string,
    payload: Record<string, unknown>,
    providerToken: string,
  ) => Promise<ApnsProviderResponse>;
  now?: () => Date;
  repository?: NotificationDeliveryRepository;
}

const INVALID_TOKEN_REASONS = new Set([
  'BadDeviceToken',
  'DeviceTokenNotForTopic',
  'Unregistered',
]);
const TRANSIENT_REASONS = new Set([
  'ExpiredProviderToken',
  'IdleTimeout',
  'InternalServerError',
  'MissingProviderToken',
  'ServiceUnavailable',
  'Shutdown',
  'TooManyProviderTokenUpdates',
  'TooManyRequests',
]);
const providerTokenCache = new Map<string, { token: string; issuedAt: number }>();
const providerSessions = new Map<string, ClientHttp2Session>();
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function classifyApnsResponse(
  status: number,
  reason: string | null,
): ApnsResponseClassification {
  if (status === 200) return { outcome: 'sent', reason };
  if (status === 410 || (reason !== null && INVALID_TOKEN_REASONS.has(reason))) {
    return { outcome: 'invalid_token', reason };
  }
  if (
    status === 0
    || status === 408
    || status === 425
    || status === 429
    || status >= 500
    || (reason !== null && TRANSIENT_REASONS.has(reason))
  ) {
    return { outcome: 'transient', reason };
  }
  return { outcome: 'permanent', reason };
}

function configuredNativeOrigin(): string | null {
  const value = process.env.MC_PUBLIC_URL
    || process.env.NEXTAUTH_URL
    || process.env.NEXT_PUBLIC_BASE_URL;
  if (!value) return null;
  try {
    return normalizeNativeTrustedOrigin(value);
  } catch {
    return null;
  }
}

export function resolveApnsDeepLink(target: string): string | null {
  let relative: URL;
  try {
    relative = new URL(target, 'https://mission-control.invalid');
  } catch {
    return null;
  }
  if (relative.origin !== 'https://mission-control.invalid') return null;

  const customRoutes = new Map([
    ['/today', 'mc://view/today'],
    ['/triage', 'mc://view/triage'],
    ['/capture', 'mc://view/capture'],
    ['/quick-sort', 'mc://view/quick-sort'],
    ['/ai', 'mc://view/houston'],
  ]);
  const custom = customRoutes.get(relative.pathname);
  if (custom) {
    return `${custom}${relative.search}`;
  }

  const origin = configuredNativeOrigin();
  if (!origin) return null;
  const destination = new URL(
    `${relative.pathname}${relative.search}${relative.hash}`,
    origin,
  ).toString();
  const decision = classifyNativeNavigation(destination, origin);
  return decision.disposition === 'allow' ? decision.url : null;
}

export function buildApnsPayload(
  payload: MissionControlPushPayload,
): Record<string, unknown> {
  const deepLink = resolveApnsDeepLink(payload.url);
  const nativeMetadata: Record<string, unknown> = {
    version: 1,
    notificationId: payload.notificationId,
  };
  if (deepLink) nativeMetadata.deepLink = deepLink;
  return {
    aps: {
      alert: {
        title: payload.title,
        ...(payload.body ? { body: payload.body } : {}),
      },
      sound: 'default',
      'thread-id': payload.tag,
    },
    mc: nativeMetadata,
  };
}

export function buildApnsRequestHeaders(
  registration: ApnsRegistrationRecord,
  deviceToken: string,
  payload: Record<string, unknown>,
  providerToken: string,
): Record<string, string> {
  const notificationId = payload.mc && typeof payload.mc === 'object'
    ? String((payload.mc as Record<string, unknown>).notificationId)
    : '';
  const headers: Record<string, string> = {
    [constants.HTTP2_HEADER_METHOD]: 'POST',
    [constants.HTTP2_HEADER_PATH]: `/3/device/${deviceToken}`,
    authorization: `bearer ${providerToken}`,
    'apns-topic': registration.topic,
    'apns-push-type': 'alert',
    'apns-priority': '10',
  };
  if (UUID_PATTERN.test(notificationId)) headers['apns-id'] = notificationId;
  return headers;
}

function providerSession(endpoint: string): ClientHttp2Session {
  const existing = providerSessions.get(endpoint);
  if (existing && !existing.closed && !existing.destroyed) return existing;

  const session = connect(endpoint);
  providerSessions.set(endpoint, session);
  session.unref();
  const discard = () => {
    if (providerSessions.get(endpoint) === session) providerSessions.delete(endpoint);
  };
  session.once('close', discard);
  session.on('error', discard);
  session.once('goaway', () => {
    discard();
    session.close();
  });
  return session;
}

async function providerToken(
  configuration: ApnsConfiguration,
  now: Date,
): Promise<string> {
  const cacheKey = `${configuration.teamId}:${configuration.keyId}`;
  const cached = providerTokenCache.get(cacheKey);
  if (cached && now.getTime() - cached.issuedAt < 50 * 60 * 1_000) {
    return cached.token;
  }
  const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
  const key = await importPKCS8(configuration.privateKey, 'ES256');
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: configuration.keyId })
    .setIssuer(configuration.teamId)
    .setIssuedAt(issuedAtSeconds)
    .sign(key);
  providerTokenCache.set(cacheKey, { token, issuedAt: now.getTime() });
  return token;
}

async function sendApnsRequest(
  configuration: ApnsConfiguration,
  registration: ApnsRegistrationRecord,
  deviceToken: string,
  payload: Record<string, unknown>,
  token: string,
): Promise<ApnsProviderResponse> {
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized, 'utf8') > 4_096) {
    return { status: 400, reason: 'PayloadTooLarge' };
  }

  const session = providerSession(
    apnsEndpoint(registration.environment as 'development' | 'production'),
  );
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      action: () => void,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      request.close(constants.NGHTTP2_CANCEL);
      finish(() => reject(new Error('APNs request timed out')));
    }, 15_000);
    const request = session.request(
      buildApnsRequestHeaders(registration, deviceToken, payload, token),
    );
    let status = 0;
    let responseBody = '';
    request.setEncoding('utf8');
    request.on('response', headers => {
      const rawStatus = headers[constants.HTTP2_HEADER_STATUS];
      status = typeof rawStatus === 'number' ? rawStatus : Number(rawStatus ?? 0);
    });
    request.on('data', chunk => {
      if (responseBody.length < 8_192) responseBody += String(chunk);
    });
    request.on('end', () => {
      let reason: string | null = null;
      try {
        const parsed = JSON.parse(responseBody) as { reason?: unknown };
        reason = typeof parsed.reason === 'string' ? parsed.reason : null;
      } catch {
        reason = null;
      }
      finish(() => resolve({ status, reason }));
    });
    request.on('error', error => {
      finish(() => reject(error));
    });
    request.end(serialized);
  });
}

export async function sendApnsPayload(
  payload: MissionControlPushPayload,
  dependencies: ApnsSenderDependencies = {},
): Promise<PushSendResult> {
  let configuration: ApnsConfiguration;
  try {
    configuration = getApnsConfiguration();
  } catch {
    return {
      classification: 'channel_unconfigured',
      attempted: 0,
      sent: 0,
      failed: 0,
      transientFailures: 0,
      permanentFailures: 0,
      expiredSubscriptions: 0,
    };
  }
  const repository = dependencies.repository
    ?? (await getWorkerPersistenceRepositories()).notificationDelivery;
  const registrations = await repository.listApnsRegistrations({
    environment: configuration.environment,
    topic: configuration.topic,
  });
  if (registrations.length === 0) {
    return {
      classification: 'no_subscription',
      attempted: 0,
      sent: 0,
      failed: 0,
      transientFailures: 0,
      permanentFailures: 0,
      expiredSubscriptions: 0,
    };
  }

  const now = dependencies.now?.() ?? new Date();
  const token = await providerToken(configuration, now);
  const nativePayload = buildApnsPayload(payload);
  const request = dependencies.send ?? sendApnsRequest;
  let sent = 0;
  let transientFailures = 0;
  let permanentFailures = 0;
  let expiredSubscriptions = 0;

  await Promise.all(registrations.map(async registration => {
    let deviceToken: string;
    try {
      deviceToken = decryptApnsDeviceToken(registration.tokenCiphertext);
    } catch {
      permanentFailures += 1;
      await repository.invalidateApnsRegistration({
        id: registration.id,
        invalidatedAt: now.toISOString(),
        reason: 'token_decryption_failed',
      });
      logger.error(
        { registrationId: registration.id },
        'Retired APNs registration with unreadable token material',
      );
      return;
    }

    try {
      const response = await request(
        configuration,
        registration,
        deviceToken,
        nativePayload,
        token,
      );
      const classification = classifyApnsResponse(response.status, response.reason);
      if (response.reason === 'ExpiredProviderToken') {
        providerTokenCache.delete(`${configuration.teamId}:${configuration.keyId}`);
      }
      if (classification.outcome === 'sent') {
        sent += 1;
        return;
      }
      if (classification.outcome === 'transient') {
        transientFailures += 1;
        logger.warn(
          {
            registrationId: registration.id,
            status: response.status,
            reason: response.reason,
          },
          'Transient APNs delivery failure',
        );
        return;
      }
      permanentFailures += 1;
      if (classification.outcome === 'invalid_token') {
        expiredSubscriptions += 1;
        await repository.invalidateApnsRegistration({
          id: registration.id,
          invalidatedAt: now.toISOString(),
          reason: response.reason ?? 'invalid_token',
        });
        logger.info(
          {
            registrationId: registration.id,
            status: response.status,
            reason: response.reason,
          },
          'Retired invalid APNs registration',
        );
      } else {
        logger.error(
          {
            registrationId: registration.id,
            status: response.status,
            reason: response.reason,
          },
          'Permanent APNs delivery failure',
        );
      }
    } catch (error) {
      transientFailures += 1;
      logger.warn(
        {
          registrationId: registration.id,
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'APNs transport failed transiently',
      );
    }
  }));

  const failed = transientFailures + permanentFailures;
  return {
    classification: failed === 0 ? 'delivered' : 'delivery_failure',
    attempted: registrations.length,
    sent,
    failed,
    transientFailures,
    permanentFailures,
    expiredSubscriptions,
  };
}
