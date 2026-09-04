import { createHash, randomUUID } from 'node:crypto';
import type { NativeShareCaptureClaim } from '@/db/persistence/triage-repositories';
import {
  nativeApiErrorEnvelopeSchema,
  shareSheetCaptureRequestSchema,
  type NativeApiErrorEnvelope,
  type ShareSheetCaptureRequest,
  type ShareSheetCaptureResponse,
} from '@/lib/native/contract';
import { getTriagePersistenceRepositories } from '@/lib/triage/persistence';
import {
  authenticateNativeShareCredential,
  type NativeShareAuthentication,
} from './share-capture-auth';
import {
  createTriageCapture,
  createTriageTextCapture,
  detectSourcePlatform,
} from '@/lib/triage/capture';

const idempotencyRetentionMilliseconds = 24 * 60 * 60 * 1_000;
const maximumCapturesPerMinute = 30;

export interface IOSShareCaptureDependencies {
  authenticate(authorization: string | null): Promise<NativeShareAuthentication>;
  claim(
    credentialId: string,
    requestId: string,
    payloadHash: string,
  ): Promise<NativeShareCaptureClaim>;
  complete(
    credentialId: string,
    requestId: string,
    reservationId: string,
    payloadHash: string,
    itemId: string,
  ): Promise<boolean>;
  release(
    credentialId: string,
    requestId: string,
    reservationId: string,
  ): Promise<void>;
  createCapture(payload: ShareSheetCaptureRequest): Promise<string>;
}

export interface IOSShareCaptureHTTPResult {
  status: number;
  body: ShareSheetCaptureResponse | NativeApiErrorEnvelope;
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJSON).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashIOSShareCapturePayload(payload: ShareSheetCaptureRequest): string {
  return createHash('sha256').update(canonicalJSON(payload), 'utf8').digest('hex');
}

function errorResult(
  requestId: string,
  status: number,
  code: NativeApiErrorEnvelope['error']['code'],
  message: string,
  retryable: boolean,
): IOSShareCaptureHTTPResult {
  const body = {
    version: 1 as const,
    requestId,
    ok: false as const,
    error: { code, message, retryable },
  };
  return {
    status,
    body: nativeApiErrorEnvelopeSchema.parse(body),
  };
}

function requestIdForError(body: unknown): string {
  if (body && typeof body === 'object') {
    const value = (body as Record<string, unknown>).requestId;
    if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
      return value;
    }
  }
  return randomUUID();
}

function requestsUnavailableImage(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const record = body as Record<string, unknown>;
  return record.contentType === 'image'
    || ['image', 'imageData', 'screenshot', 'file', 'base64', 'ocr'].some(
      (key) => Object.hasOwn(record, key),
    );
}

export async function processIOSShareCapture(
  request: Request,
  body: unknown,
  dependencies: IOSShareCaptureDependencies = defaultDependencies,
): Promise<IOSShareCaptureHTTPResult> {
  const errorRequestId = requestIdForError(body);
  if (requestsUnavailableImage(body)) {
    return errorResult(
      errorRequestId,
      422,
      'IMAGE_CAPTURE_UNAVAILABLE',
      'Image capture is not available.',
      false,
    );
  }

  const parsed = shareSheetCaptureRequestSchema.safeParse(body);
  if (!parsed.success) {
    return errorResult(
      errorRequestId,
      400,
      'INVALID_REQUEST',
      'The Share Sheet capture request is invalid.',
      false,
    );
  }
  const payload = parsed.data;
  if (request.headers.get('idempotency-key')?.toLowerCase() !== payload.requestId.toLowerCase()) {
    return errorResult(
      payload.requestId,
      400,
      'INVALID_REQUEST',
      'Idempotency-Key must match requestId.',
      false,
    );
  }

  const authentication = await dependencies.authenticate(request.headers.get('authorization'));
  if (authentication.status === 'expired') {
    return errorResult(
      payload.requestId,
      401,
      'TOKEN_EXPIRED',
      'Open Mission Control to renew Share Sheet access.',
      false,
    );
  }
  if (authentication.status === 'forbidden') {
    return errorResult(
      payload.requestId,
      403,
      'FORBIDDEN',
      'This credential cannot create Share Sheet captures.',
      false,
    );
  }
  if (authentication.status !== 'authenticated') {
    return errorResult(
      payload.requestId,
      401,
      'UNAUTHORIZED',
      'Open Mission Control to restore Share Sheet access.',
      false,
    );
  }

  const payloadHash = hashIOSShareCapturePayload(payload);
  const claim = await dependencies.claim(
    authentication.credentialId,
    payload.requestId,
    payloadHash,
  );
  if (claim.status === 'duplicate') {
    return {
      status: 200,
      body: {
        version: 1,
        requestId: payload.requestId,
        ok: true,
        data: { itemId: claim.itemId, status: 'duplicate' },
      },
    };
  }
  if (claim.status === 'replay') {
    return errorResult(
      payload.requestId,
      409,
      'REPLAY_DETECTED',
      'The request ID was already used for different content.',
      false,
    );
  }
  if (claim.status === 'pending') {
    return errorResult(
      payload.requestId,
      409,
      'INTERNAL_ERROR',
      'The capture is still processing. Try again shortly.',
      true,
    );
  }
  if (claim.status === 'rateLimited') {
    return errorResult(
      payload.requestId,
      429,
      'RATE_LIMITED',
      'Too many Share Sheet captures. Try again shortly.',
      true,
    );
  }

  let createdItemId: string | undefined;
  try {
    const itemId = await dependencies.createCapture(payload);
    createdItemId = itemId;
    const completed = await dependencies.complete(
      authentication.credentialId,
      payload.requestId,
      claim.reservationId,
      payloadHash,
      itemId,
    );
    if (!completed) {
      throw new Error('Capture reservation was not completed');
    }
    return {
      status: 201,
      body: {
        version: 1,
        requestId: payload.requestId,
        ok: true,
        data: { itemId, status: 'created' },
      },
    };
  } catch {
    if (!createdItemId) {
      await dependencies.release(
        authentication.credentialId,
        payload.requestId,
        claim.reservationId,
      );
    }
    return errorResult(
      payload.requestId,
      500,
      'INTERNAL_ERROR',
      'Mission Control could not save this capture.',
      true,
    );
  }
}

const defaultDependencies: IOSShareCaptureDependencies = {
  authenticate: authenticateNativeShareCredential,
  async claim(credentialId, requestId, payloadHash) {
    const now = new Date();
    const reservationId = randomUUID();
    return getTriagePersistenceRepositories().native.shareCapture.claim({
      credentialId,
      requestId,
      payloadHash,
      reservationId,
      now: now.toISOString(),
      retentionCutoff: new Date(
        now.getTime() - idempotencyRetentionMilliseconds,
      ).toISOString(),
      rateWindowStart: new Date(now.getTime() - 60_000).toISOString(),
      maximumCaptures: maximumCapturesPerMinute,
    });
  },
  async complete(credentialId, requestId, reservationId, payloadHash, itemId) {
    return getTriagePersistenceRepositories().native.shareCapture.complete({
      credentialId,
      requestId,
      reservationId,
      payloadHash,
      itemId,
      completedAt: new Date().toISOString(),
    });
  },
  async release(credentialId, requestId, reservationId) {
    await getTriagePersistenceRepositories().native.shareCapture.release({
      credentialId,
      requestId,
      reservationId,
    });
  },
  async createCapture(payload) {
    if (payload.contentType === 'text') {
      const item = await createTriageTextCapture({
        requestId: payload.requestId,
        text: payload.text,
        title: payload.title,
        capturedAt: payload.capturedAt,
      });
      return item.id;
    }
    const detectedPlatform = detectIOSSourcePlatform(payload.url);
    const item = await createTriageCapture({
      url: payload.url,
      title: payload.title,
      sharedText: payload.sharedText,
      sourcePlatform: detectedPlatform,
      sourceId: `ios_share:${payload.requestId}`,
      capturedAt: payload.capturedAt,
    });
    return item.id;
  },
};

function detectIOSSourcePlatform(url: string) {
  const platform = detectSourcePlatform(url);
  return platform === 'web' ? 'ios_share' as const : platform;
}
