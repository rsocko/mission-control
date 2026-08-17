import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import db from '@/db';
import { nativeShareCaptureRequests } from '@/db/schema';
import {
  nativeApiErrorEnvelopeSchema,
  shareSheetCaptureRequestSchema,
  type NativeApiErrorEnvelope,
  type ShareSheetCaptureRequest,
  type ShareSheetCaptureResponse,
} from '@/lib/native/contract';
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

type CaptureClaim =
  | { status: 'acquired'; reservationId: string }
  | { status: 'duplicate'; itemId: string }
  | { status: 'pending' }
  | { status: 'rateLimited' }
  | { status: 'replay' };

export interface IOSShareCaptureDependencies {
  authenticate(authorization: string | null): Promise<NativeShareAuthentication>;
  claim(
    credentialId: string,
    requestId: string,
    payloadHash: string,
  ): Promise<CaptureClaim>;
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
    await db.delete(nativeShareCaptureRequests).where(
      lt(
        nativeShareCaptureRequests.createdAt,
        new Date(now.getTime() - idempotencyRetentionMilliseconds).toISOString(),
      ),
    );
    const [existing] = await db.select().from(nativeShareCaptureRequests).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
      ),
    ).limit(1);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        return { status: 'replay' };
      }
      if (existing.itemId) {
        return { status: 'duplicate', itemId: existing.itemId };
      }
      return { status: 'pending' };
    }

    const [recent] = await db.select({
      count: sql<number>`count(*)`,
    }).from(nativeShareCaptureRequests).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        gte(
          nativeShareCaptureRequests.createdAt,
          new Date(now.getTime() - 60_000).toISOString(),
        ),
      ),
    );
    if (Number(recent?.count ?? 0) >= maximumCapturesPerMinute) {
      return { status: 'rateLimited' };
    }

    const reservationId = randomUUID();
    const insertion = db.insert(nativeShareCaptureRequests).values({
      credentialId,
      requestId,
      payloadHash,
      reservationId,
      createdAt: now.toISOString(),
    }).onConflictDoNothing().run();
    if (insertion.changes === 1) {
      return { status: 'acquired', reservationId };
    }

    const [racedExisting] = await db.select().from(nativeShareCaptureRequests).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
      ),
    ).limit(1);
    if (!racedExisting || racedExisting.payloadHash !== payloadHash) {
      return { status: 'replay' };
    }
    if (racedExisting.itemId) {
      return { status: 'duplicate', itemId: racedExisting.itemId };
    }
    return { status: 'pending' };
  },
  async complete(credentialId, requestId, reservationId, payloadHash, itemId) {
    const completedAt = new Date().toISOString();
    let result = db.update(nativeShareCaptureRequests).set({
      itemId,
      completedAt,
    }).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
        eq(nativeShareCaptureRequests.reservationId, reservationId),
        eq(nativeShareCaptureRequests.payloadHash, payloadHash),
        isNull(nativeShareCaptureRequests.itemId),
      ),
    ).run();
    if (result.changes === 1) {
      return true;
    }

    result = db.update(nativeShareCaptureRequests).set({
      itemId,
      completedAt,
    }).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
        eq(nativeShareCaptureRequests.payloadHash, payloadHash),
        isNull(nativeShareCaptureRequests.itemId),
      ),
    ).run();
    if (result.changes === 1) {
      return true;
    }

    const insertion = db.insert(nativeShareCaptureRequests).values({
      credentialId,
      requestId,
      payloadHash,
      reservationId,
      itemId,
      createdAt: completedAt,
      completedAt,
    }).onConflictDoNothing().run();
    if (insertion.changes === 1) {
      return true;
    }

    const [existing] = await db.select().from(nativeShareCaptureRequests).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
      ),
    ).limit(1);
    return existing?.payloadHash === payloadHash && existing.itemId === itemId;
  },
  async release(credentialId, requestId, reservationId) {
    await db.delete(nativeShareCaptureRequests).where(
      and(
        eq(nativeShareCaptureRequests.credentialId, credentialId),
        eq(nativeShareCaptureRequests.requestId, requestId),
        eq(nativeShareCaptureRequests.reservationId, reservationId),
      ),
    );
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
