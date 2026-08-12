import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { and, eq, isNull, ne } from 'drizzle-orm';
import db, { runTransaction } from '@/db';
import {
  apnsRegistrations,
  nativeInstallationCredentials,
  nativePushRequests,
  nativeShareCredentials,
} from '@/db/schema';
import {
  apnsRegistrationRequestSchema,
  apnsUnregistrationRequestSchema,
  nativeLogoutRequestSchema,
  type ApnsRegistrationRequest,
  type ApnsUnregistrationRequest,
  type NativeLogoutRequest,
} from './contract';
import {
  authenticateNativeInstallationCredential,
  type InstallationCredentialScope,
} from './installation-auth';
import { getApnsConfiguration } from '@/lib/push/apns-config';

type NativeApiCode =
  | 'INVALID_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'TOKEN_EXPIRED'
  | 'REPLAY_DETECTED'
  | 'INTERNAL_ERROR';

export interface NativeApiResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestIdFrom(value: unknown): string {
  if (
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).requestId === 'string'
    && UUID_PATTERN.test((value as Record<string, unknown>).requestId as string)
  ) {
    return (value as Record<string, unknown>).requestId as string;
  }
  return randomUUID();
}

function failure(
  requestId: string,
  status: number,
  code: NativeApiCode,
  message: string,
  retryable = false,
): NativeApiResult {
  return {
    status,
    body: {
      version: 1,
      requestId,
      ok: false,
      error: { code, message, retryable },
    },
  };
}

function canonicalHash(operation: string, payload: object): string {
  return createHash('sha256')
    .update(`${operation}\n${JSON.stringify(payload)}`, 'utf8')
    .digest('hex');
}

export function hashApnsDeviceToken(deviceToken: string): string {
  return createHash('sha256').update(deviceToken.toLowerCase(), 'ascii').digest('hex');
}

export function encryptApnsDeviceToken(deviceToken: string): string {
  const { tokenEncryptionKey } = getApnsConfiguration();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', tokenEncryptionKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(deviceToken.toLowerCase(), 'ascii'),
    cipher.final(),
  ]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

export function decryptApnsDeviceToken(value: string): string {
  const [version, ivValue, ciphertextValue, tagValue, ...extra] = value.split('.');
  if (version !== 'v1' || !ivValue || !ciphertextValue || !tagValue || extra.length > 0) {
    throw new Error('Stored APNs token is invalid');
  }
  const { tokenEncryptionKey } = getApnsConfiguration();
  const decipher = createDecipheriv(
    'aes-256-gcm',
    tokenEncryptionKey,
    Buffer.from(ivValue, 'base64url'),
  );
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final(),
  ]).toString('ascii');
}

async function authenticate(
  request: Request,
  requestId: string,
  requiredScope: InstallationCredentialScope,
  installationId: string,
): Promise<
  | { credentialId: string; installationId: string }
  | NativeApiResult
> {
  const authentication = await authenticateNativeInstallationCredential(
    request.headers.get('authorization'),
    requiredScope,
  );
  if (authentication.status === 'expired') {
    return failure(requestId, 401, 'TOKEN_EXPIRED', 'The installation credential has expired');
  }
  if (authentication.status === 'forbidden') {
    return failure(requestId, 403, 'FORBIDDEN', 'The credential does not allow this operation');
  }
  if (authentication.status !== 'authenticated') {
    return failure(requestId, 401, 'UNAUTHORIZED', 'Authentication is required');
  }
  if (authentication.installationId !== installationId) {
    return failure(requestId, 403, 'FORBIDDEN', 'The installation does not match the credential');
  }
  return {
    credentialId: authentication.credentialId,
    installationId: authentication.installationId,
  };
}

function validateIdempotencyKey(request: Request, requestId: string): NativeApiResult | null {
  if (request.headers.get('idempotency-key') !== requestId) {
    return failure(
      requestId,
      400,
      'INVALID_REQUEST',
      'Idempotency-Key must match requestId',
    );
  }
  return null;
}

function replayResult(
  credentialId: string,
  requestId: string,
  operation: string,
  payloadHash: string,
): NativeApiResult | null {
  const prior = db.select().from(nativePushRequests).where(and(
    eq(nativePushRequests.credentialId, credentialId),
    eq(nativePushRequests.requestId, requestId),
  )).get();
  if (!prior) return null;
  if (prior.operation !== operation || prior.payloadHash !== payloadHash) {
    return failure(
      requestId,
      409,
      'REPLAY_DETECTED',
      'The request ID was already used for different content',
    );
  }
  return {
    status: prior.responseStatus,
    body: prior.responseBody as Record<string, unknown>,
  };
}

function storeResult(
  credentialId: string,
  requestId: string,
  operation: string,
  payloadHash: string,
  result: NativeApiResult,
  nowIso: string,
): void {
  db.insert(nativePushRequests).values({
    credentialId,
    requestId,
    operation,
    payloadHash,
    responseStatus: result.status,
    responseBody: result.body,
    createdAt: nowIso,
  }).run();
}

export async function processApnsRegistration(
  request: Request,
  rawBody: unknown,
  now: Date = new Date(),
): Promise<NativeApiResult> {
  const requestId = requestIdFrom(rawBody);
  const parsed = apnsRegistrationRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return failure(requestId, 400, 'INVALID_REQUEST', 'The APNs registration request is invalid');
  }
  const body = parsed.data;
  const idempotencyFailure = validateIdempotencyKey(request, body.requestId);
  if (idempotencyFailure) return idempotencyFailure;
  const authentication = await authenticate(
    request,
    body.requestId,
    'push:register',
    body.installationId,
  );
  if ('body' in authentication) return authentication;

  let configuration;
  try {
    configuration = getApnsConfiguration();
  } catch {
    return failure(
      body.requestId,
      503,
      'INTERNAL_ERROR',
      'APNs registration is not configured',
      true,
    );
  }
  if (body.topic !== configuration.topic || body.environment !== configuration.environment) {
    return failure(
      body.requestId,
      400,
      'INVALID_REQUEST',
      'The APNs topic or environment is not allowed',
    );
  }

  const operation = 'register';
  const payloadHash = canonicalHash(operation, body);
  const prior = replayResult(
    authentication.credentialId,
    body.requestId,
    operation,
    payloadHash,
  );
  if (prior) return prior;

  try {
    return runTransaction(() => {
      const repeated = replayResult(
        authentication.credentialId,
        body.requestId,
        operation,
        payloadHash,
      );
      if (repeated) return repeated;
      const nowIso = now.toISOString();
      const tokenHash = hashApnsDeviceToken(body.deviceToken);
      const existing = db.select().from(apnsRegistrations).where(and(
        eq(apnsRegistrations.installationId, body.installationId),
        eq(apnsRegistrations.environment, body.environment),
        eq(apnsRegistrations.topic, body.topic),
      )).get();

      db.update(apnsRegistrations).set({
        invalidatedAt: nowIso,
        invalidationReason: 'token_reassigned',
        updatedAt: nowIso,
      }).where(and(
        eq(apnsRegistrations.tokenHash, tokenHash),
        eq(apnsRegistrations.environment, body.environment),
        eq(apnsRegistrations.topic, body.topic),
        isNull(apnsRegistrations.invalidatedAt),
        ne(apnsRegistrations.id, existing?.id ?? ''),
      )).run();
      db.update(apnsRegistrations).set({
        invalidatedAt: nowIso,
        invalidationReason: 'target_changed',
        updatedAt: nowIso,
      }).where(and(
        eq(apnsRegistrations.installationId, body.installationId),
        isNull(apnsRegistrations.invalidatedAt),
        ne(apnsRegistrations.id, existing?.id ?? ''),
      )).run();

      const state = existing && !existing.invalidatedAt && existing.tokenHash !== tokenHash
        ? 'rotated'
        : 'registered';
      const registrationId = existing?.id ?? randomUUID();
      if (existing) {
        db.update(apnsRegistrations).set({
          tokenCiphertext: existing.tokenHash === tokenHash
            ? existing.tokenCiphertext
            : encryptApnsDeviceToken(body.deviceToken),
          tokenHash,
          appVersion: body.appVersion,
          buildNumber: body.buildNumber,
          locale: body.locale,
          timeZone: body.timeZone,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
          invalidatedAt: null,
          invalidationReason: null,
        }).where(eq(apnsRegistrations.id, registrationId)).run();
      } else {
        db.insert(apnsRegistrations).values({
          id: registrationId,
          installationId: body.installationId,
          tokenCiphertext: encryptApnsDeviceToken(body.deviceToken),
          tokenHash,
          environment: body.environment,
          topic: body.topic,
          appVersion: body.appVersion,
          buildNumber: body.buildNumber,
          locale: body.locale,
          timeZone: body.timeZone,
          createdAt: nowIso,
          updatedAt: nowIso,
          lastSeenAt: nowIso,
          invalidatedAt: null,
          invalidationReason: null,
        }).run();
      }

      const result: NativeApiResult = {
        status: existing ? 200 : 201,
        body: {
          version: 1,
          requestId: body.requestId,
          ok: true,
          data: { registrationId, state, updatedAt: nowIso },
        },
      };
      storeResult(
        authentication.credentialId,
        body.requestId,
        operation,
        payloadHash,
        result,
        nowIso,
      );
      return result;
    });
  } catch {
    const concurrent = replayResult(
      authentication.credentialId,
      body.requestId,
      operation,
      payloadHash,
    );
    if (concurrent) return concurrent;
    return failure(
      body.requestId,
      500,
      'INTERNAL_ERROR',
      'The APNs registration could not be stored',
      true,
    );
  }
}

export async function processApnsUnregistration(
  request: Request,
  rawBody: unknown,
  pathRegistrationId: string,
  now: Date = new Date(),
): Promise<NativeApiResult> {
  const requestId = requestIdFrom(rawBody);
  const parsed = apnsUnregistrationRequestSchema.safeParse(rawBody);
  if (!parsed.success || parsed.data.registrationId !== pathRegistrationId) {
    return failure(requestId, 400, 'INVALID_REQUEST', 'The APNs unregistration request is invalid');
  }
  const body = parsed.data;
  const idempotencyFailure = validateIdempotencyKey(request, body.requestId);
  if (idempotencyFailure) return idempotencyFailure;
  const authentication = await authenticate(
    request,
    body.requestId,
    'push:unregister',
    body.installationId,
  );
  if ('body' in authentication) return authentication;
  return retireRegistration(authentication.credentialId, body, now);
}

function retireRegistration(
  credentialId: string,
  body: ApnsUnregistrationRequest,
  now: Date,
): NativeApiResult {
  const operation = `unregister:${body.registrationId}`;
  const payloadHash = canonicalHash(operation, body);
  const prior = replayResult(credentialId, body.requestId, operation, payloadHash);
  if (prior) return prior;
  try {
    return runTransaction(() => {
      const repeated = replayResult(credentialId, body.requestId, operation, payloadHash);
      if (repeated) return repeated;
      const registration = db.select().from(apnsRegistrations).where(and(
        eq(apnsRegistrations.id, body.registrationId),
        eq(apnsRegistrations.installationId, body.installationId),
      )).get();
      if (!registration) {
        return failure(body.requestId, 403, 'FORBIDDEN', 'The registration is not owned by this installation');
      }
      const nowIso = now.toISOString();
      db.update(apnsRegistrations).set({
        invalidatedAt: registration.invalidatedAt ?? nowIso,
        invalidationReason: registration.invalidationReason ?? 'user_unregistered',
        updatedAt: nowIso,
      }).where(eq(apnsRegistrations.id, registration.id)).run();
      const result: NativeApiResult = {
        status: 200,
        body: {
          version: 1,
          requestId: body.requestId,
          ok: true,
          data: {
            registrationId: body.registrationId,
            state: 'unregistered',
            updatedAt: nowIso,
          },
        },
      };
      storeResult(credentialId, body.requestId, operation, payloadHash, result, nowIso);
      return result;
    });
  } catch {
    const concurrent = replayResult(credentialId, body.requestId, operation, payloadHash);
    if (concurrent) return concurrent;
    return failure(
      body.requestId,
      500,
      'INTERNAL_ERROR',
      'The APNs registration could not be retired',
      true,
    );
  }
}

export async function processNativeLogout(
  request: Request,
  rawBody: unknown,
  now: Date = new Date(),
): Promise<NativeApiResult> {
  const requestId = requestIdFrom(rawBody);
  const parsed = nativeLogoutRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return failure(requestId, 400, 'INVALID_REQUEST', 'The native logout request is invalid');
  }
  const body: NativeLogoutRequest = parsed.data;
  const idempotencyFailure = validateIdempotencyKey(request, body.requestId);
  if (idempotencyFailure) return idempotencyFailure;
  const authentication = await authenticate(
    request,
    body.requestId,
    'credentials:revoke',
    body.installationId,
  );
  if ('body' in authentication) return authentication;

  try {
    const nowIso = now.toISOString();
    const result = runTransaction(() => {
      const credentialsRevoked = db.update(nativeInstallationCredentials).set({
        revokedAt: nowIso,
      }).where(and(
        eq(nativeInstallationCredentials.installationId, body.installationId),
        isNull(nativeInstallationCredentials.revokedAt),
      )).run().changes + db.update(nativeShareCredentials).set({
        revokedAt: nowIso,
      }).where(and(
        eq(nativeShareCredentials.installationId, body.installationId),
        isNull(nativeShareCredentials.revokedAt),
      )).run().changes;
      const registrationsRetired = db.update(apnsRegistrations).set({
        invalidatedAt: nowIso,
        invalidationReason: 'logout',
        updatedAt: nowIso,
      }).where(and(
        eq(apnsRegistrations.installationId, body.installationId),
        isNull(apnsRegistrations.invalidatedAt),
      )).run().changes;
      return { credentialsRevoked, registrationsRetired };
    });
    return {
      status: 200,
      body: {
        version: 1,
        requestId: body.requestId,
        ok: true,
        data: result,
      },
    };
  } catch {
    return failure(
      body.requestId,
      500,
      'INTERNAL_ERROR',
      'Native logout could not be completed',
      true,
    );
  }
}

export type { ApnsRegistrationRequest };
