import { describe, expect, it, vi } from 'vitest';
import {
  hashIOSShareCapturePayload,
  processIOSShareCapture,
  type IOSShareCaptureDependencies,
} from '@/lib/native/share-capture-service';
import type { ShareSheetCaptureRequest } from '@/lib/native/contract';

const requestId = '8cf177a0-e46a-46fa-824c-4c34004e2423';
const credentialId = '83c45840-a47f-4269-aae9-5a3f4fbd220b';

function urlPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    requestId,
    client: 'ios',
    contentType: 'url',
    url: 'https://example.com/article',
    capturedAt: '2026-07-31T12:00:00.000Z',
    ...overrides,
  };
}

function request(payload: { requestId?: unknown } = urlPayload()) {
  return new Request('https://mc.example.com/api/triage/capture', {
    method: 'POST',
    headers: {
      authorization: 'Bearer redacted-test-token',
      'idempotency-key': String(payload.requestId),
    },
  });
}

function dependencies(
  overrides: Partial<IOSShareCaptureDependencies> = {},
): IOSShareCaptureDependencies {
  return {
    authenticate: vi.fn(async () => ({
      status: 'authenticated' as const,
      credentialId,
    })),
    claim: vi.fn(async () => ({
      status: 'acquired' as const,
      reservationId: 'reservation',
    })),
    complete: vi.fn(async () => true),
    release: vi.fn(async () => undefined),
    createCapture: vi.fn(async () => 'triage-item-id'),
    ...overrides,
  };
}

describe('iOS Share Sheet capture service', () => {
  it('maps canonical URL and text payloads and completes the reservation', async () => {
    const deps = dependencies();
    const urlResult = await processIOSShareCapture(request(), urlPayload(), deps);
    const textPayload: ShareSheetCaptureRequest = {
      version: 1,
      requestId,
      client: 'ios',
      contentType: 'text',
      text: 'Draft Q4 priorities',
    };
    const textResult = await processIOSShareCapture(request(textPayload), textPayload, deps);

    expect(urlResult).toEqual({
      status: 201,
      body: {
        version: 1,
        requestId,
        ok: true,
        data: { itemId: 'triage-item-id', status: 'created' },
      },
    });
    expect(textResult.status).toBe(201);
    expect(deps.createCapture).toHaveBeenNthCalledWith(1, urlPayload());
    expect(deps.createCapture).toHaveBeenNthCalledWith(2, textPayload);
    expect(deps.complete).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate for an exact retry without creating another item', async () => {
    const deps = dependencies({
      claim: vi.fn(async () => ({
        status: 'duplicate' as const,
        itemId: 'existing-id',
      })),
    });

    const result = await processIOSShareCapture(request(), urlPayload(), deps);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      data: { itemId: 'existing-id', status: 'duplicate' },
    });
    expect(deps.createCapture).not.toHaveBeenCalled();
  });

  it('rejects request ID reuse with different content', async () => {
    const deps = dependencies({
      claim: vi.fn(async () => ({ status: 'replay' as const })),
    });

    const result = await processIOSShareCapture(request(), urlPayload(), deps);

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      ok: false,
      error: { code: 'REPLAY_DETECTED', retryable: false },
    });
  });

  it('rejects image and unknown fields without authenticating', async () => {
    const deps = dependencies();
    const image = urlPayload({ contentType: 'image', imageData: 'private-content' });
    const imageResult = await processIOSShareCapture(request(image), image, deps);
    const extended = urlPayload({ credential: 'must-not-be-accepted' });
    const extendedResult = await processIOSShareCapture(request(extended), extended, deps);

    expect(imageResult.body).toMatchObject({
      error: { code: 'IMAGE_CAPTURE_UNAVAILABLE', retryable: false },
    });
    expect(extendedResult.body).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
    expect(deps.authenticate).not.toHaveBeenCalled();
  });

  it('requires matching idempotency and maps expired auth explicitly', async () => {
    const mismatched = new Request('https://mc.example.com/api/triage/capture', {
      headers: {
        authorization: 'Bearer redacted-test-token',
        'idempotency-key': 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    });
    const mismatchResult = await processIOSShareCapture(
      mismatched,
      urlPayload(),
      dependencies(),
    );
    const expiredResult = await processIOSShareCapture(
      request(),
      urlPayload(),
      dependencies({
        authenticate: vi.fn(async () => ({ status: 'expired' as const })),
      }),
    );

    expect(mismatchResult.body).toMatchObject({
      error: { code: 'INVALID_REQUEST', retryable: false },
    });
    expect(expiredResult.body).toMatchObject({
      error: { code: 'TOKEN_EXPIRED', retryable: false },
    });
  });

  it('maps per-credential rate limits as retryable', async () => {
    const result = await processIOSShareCapture(
      request(),
      urlPayload(),
      dependencies({
        claim: vi.fn(async () => ({ status: 'rateLimited' as const })),
      }),
    );

    expect(result.status).toBe(429);
    expect(result.body).toMatchObject({
      error: { code: 'RATE_LIMITED', retryable: true },
    });
  });

  it('releases failed reservations and returns a retryable redacted error', async () => {
    const deps = dependencies({
      createCapture: vi.fn(async () => {
        throw new Error('private capture content and token');
      }),
    });

    const result = await processIOSShareCapture(request(), urlPayload(), deps);
    const serialized = JSON.stringify(result);

    expect(result.body).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: true },
    });
    expect(deps.release).toHaveBeenCalledWith(
      credentialId,
      requestId,
      'reservation',
    );
    expect(serialized).not.toContain('private capture content');
    expect(serialized).not.toContain('redacted-test-token');
  });

  it('never acknowledges success when idempotency completion is lost', async () => {
    const deps = dependencies({
      complete: vi.fn(async () => false),
    });

    const result = await processIOSShareCapture(request(), urlPayload(), deps);

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({
      error: { code: 'INTERNAL_ERROR', retryable: true },
    });
    expect(deps.release).not.toHaveBeenCalled();
  });

  it('hashes payloads canonically for stable retry binding', () => {
    const first = urlPayload() as ShareSheetCaptureRequest;
    const second = {
      capturedAt: first.capturedAt,
      url: 'https://example.com/article',
      contentType: 'url' as const,
      client: 'ios' as const,
      requestId,
      version: 1 as const,
    };

    expect(hashIOSShareCapturePayload(first)).toBe(hashIOSShareCapturePayload(second));
    expect(hashIOSShareCapturePayload(first)).not.toBe(
      hashIOSShareCapturePayload({ ...second, url: 'https://example.com/other' }),
    );
  });
});
