import 'server-only';

import {
  createHash,
  randomUUID,
} from 'node:crypto';
import type {
  NativeApnsRegistrationStoredResponse,
  NativeApnsUnregistrationStoredResponse,
  NativeStoredRequest,
} from '@/db/persistence/triage-repositories';
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
import { getTriagePersistenceRepositories } from '@/lib/triage/persistence';
import {
  encryptApnsDeviceToken,
  hashApnsDeviceToken,
} from './apns-token-crypto';

export {
  decryptApnsDeviceToken,
  encryptApnsDeviceToken,
  hashApnsDeviceToken,
} from './apns-token-crypto';

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

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(
      key => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function canonicalHash(operation: string, payload: object): string {
  return createHash('sha256')
    .update(`${operation}\n${canonicalJSON(payload)}`, 'utf8')
    .digest('hex');
}

function legacyHash(operation: string, payload: object): string {
  return createHash('sha256')
    .update(`${operation}\n${JSON.stringify(payload)}`, 'utf8')
    .digest('hex');
}

async function authenticate(
  request: Request,
  requestId: string,
  requiredScope: InstallationCredentialScope,
  installationId: string,
  now: Date,
): Promise<
  | { credentialId: string; installationId: string }
  | NativeApiResult
> {
  const authentication = await authenticateNativeInstallationCredential(
    request.headers.get('authorization'),
    requiredScope,
    now,
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

function isRegistrationResponse(
  value: unknown,
): value is NativeApnsRegistrationStoredResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'registration'
    && typeof record.registrationId === 'string'
    && (record.state === 'registered' || record.state === 'rotated')
    && typeof record.updatedAt === 'string';
}

function isUnregistrationResponse(
  value: unknown,
): value is NativeApnsUnregistrationStoredResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'unregistration'
    && typeof record.registrationId === 'string'
    && record.state === 'unregistered'
    && typeof record.updatedAt === 'string';
}

function registrationResult(
  requestId: string,
  response: NativeStoredRequest,
): NativeApiResult {
  if (
    (response.responseStatus === 200 || response.responseStatus === 201)
    && response.responseBody
    && typeof response.responseBody === 'object'
    && !Array.isArray(response.responseBody)
  ) {
    const envelope = response.responseBody as Record<string, unknown>;
    if (
      envelope.version === 1
      && envelope.requestId === requestId
      && envelope.ok === true
      && envelope.data
      && isRegistrationResponse({
        kind: 'registration',
        ...(envelope.data as Record<string, unknown>),
      })
    ) {
      return { status: response.responseStatus, body: envelope };
    }
  }
  if (
    (response.responseStatus !== 200 && response.responseStatus !== 201)
    || !isRegistrationResponse(response.responseBody)
  ) {
    throw new Error('Stored APNs registration response is invalid');
  }
  return {
    status: response.responseStatus,
    body: {
      version: 1,
      requestId,
      ok: true,
      data: {
        registrationId: response.responseBody.registrationId,
        state: response.responseBody.state,
        updatedAt: response.responseBody.updatedAt,
      },
    },
  };
}

function unregistrationResult(
  requestId: string,
  response: NativeStoredRequest,
): NativeApiResult {
  if (
    response.responseStatus === 200
    && response.responseBody
    && typeof response.responseBody === 'object'
    && !Array.isArray(response.responseBody)
  ) {
    const envelope = response.responseBody as Record<string, unknown>;
    if (
      envelope.version === 1
      && envelope.requestId === requestId
      && envelope.ok === true
      && envelope.data
      && isUnregistrationResponse({
        kind: 'unregistration',
        ...(envelope.data as Record<string, unknown>),
      })
    ) {
      return { status: 200, body: envelope };
    }
  }
  if (response.responseStatus !== 200 || !isUnregistrationResponse(response.responseBody)) {
    throw new Error('Stored APNs unregistration response is invalid');
  }
  return {
    status: 200,
    body: {
      version: 1,
      requestId,
      ok: true,
      data: {
        registrationId: response.responseBody.registrationId,
        state: response.responseBody.state,
        updatedAt: response.responseBody.updatedAt,
      },
    },
  };
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
    now,
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

  try {
    const outcome = await getTriagePersistenceRepositories().native.apns.register({
      credentialId: authentication.credentialId,
      requestId: body.requestId,
      payloadHash: canonicalHash('register', body),
      legacyPayloadHash: legacyHash('register', body),
      registrationId: randomUUID(),
      installationId: body.installationId,
      tokenCiphertext: encryptApnsDeviceToken(body.deviceToken),
      tokenHash: hashApnsDeviceToken(body.deviceToken),
      environment: body.environment,
      topic: body.topic,
      appVersion: body.appVersion,
      buildNumber: body.buildNumber,
      locale: body.locale,
      timeZone: body.timeZone,
      now: now.toISOString(),
    });
    if (outcome.status === 'mismatch') {
      return failure(
        body.requestId,
        409,
        'REPLAY_DETECTED',
        'The request ID was already used for different content',
      );
    }
    if (outcome.status === 'credentialRevoked') {
      return failure(
        body.requestId,
        401,
        'UNAUTHORIZED',
        'Authentication is required',
      );
    }
    return registrationResult(body.requestId, outcome.response);
  } catch {
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
    now,
  );
  if ('body' in authentication) return authentication;
  return retireRegistration(authentication.credentialId, body, now);
}

async function retireRegistration(
  credentialId: string,
  body: ApnsUnregistrationRequest,
  now: Date,
): Promise<NativeApiResult> {
  const operation = `unregister:${body.registrationId}`;
  const payloadHash = canonicalHash(operation, body);
  try {
    const outcome = await getTriagePersistenceRepositories().native.apns.unregister({
      credentialId,
      requestId: body.requestId,
      payloadHash,
      legacyPayloadHash: legacyHash(operation, body),
      registrationId: body.registrationId,
      installationId: body.installationId,
      now: now.toISOString(),
    });
    if (outcome.status === 'mismatch') {
      return failure(
        body.requestId,
        409,
        'REPLAY_DETECTED',
        'The request ID was already used for different content',
      );
    }
    if (outcome.status === 'notOwned') {
      return failure(
        body.requestId,
        403,
        'FORBIDDEN',
        'The registration is not owned by this installation',
      );
    }
    return unregistrationResult(body.requestId, outcome.response);
  } catch {
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
    now,
  );
  if ('body' in authentication) return authentication;

  try {
    const nowIso = now.toISOString();
    const result = await getTriagePersistenceRepositories().native.apns.logout({
      installationId: body.installationId,
      now: nowIso,
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
