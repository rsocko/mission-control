/**
 * Bulk import route tests — Reddit/Instagram/Facebook browser extension
 * import batches.
 *
 * Covers:
 *  - Auth: rejects requests missing/mismatching x-triage-capture-key
 *  - Validation: empty items array, oversized batch, missing required fields
 *  - Happy path: aggregates imported/skipped counts across mixed results
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockIngest = vi.fn();

vi.mock('@/lib/triage/import-capture', () => ({
  ingestTriageImports: mockIngest,
}));

vi.mock('@/lib/triage/query', () => ({
  isValidTriageSource: (value: string | null) =>
    !!value && ['all', 'reddit', 'youtube', 'instagram', 'facebook', 'github', 'ios_share', 'android_share', 'browser_extension', 'web'].includes(value),
}));

vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost/api/triage/import/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/triage/import/bulk', () => {
  const originalKey = process.env.MC_TRIAGE_CAPTURE_KEY;

  beforeEach(() => {
    mockIngest.mockReset();
    process.env.MC_TRIAGE_CAPTURE_KEY = 'test-capture-key';
  });

  afterEach(() => {
    process.env.MC_TRIAGE_CAPTURE_KEY = originalKey;
  });

  it('rejects requests without a valid capture key', async () => {
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest({ items: [{ sourcePlatform: 'reddit', sourceId: 'reddit:1', sourceUrl: 'https://reddit.com/1', title: 'x' }] });

    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('accepts requests with a matching x-triage-capture-key header', async () => {
    mockIngest.mockResolvedValue([{ status: 'imported' }]);
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest(
      { items: [{ sourcePlatform: 'reddit', sourceId: 'reddit:1', sourceUrl: 'https://reddit.com/1', title: 'x' }] },
      { 'x-triage-capture-key': 'test-capture-key' },
    );

    const res = await POST(req);
    expect(res.status).toBe(200);
  });

  it('rejects an empty items array', async () => {
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest({ items: [] }, { 'x-triage-capture-key': 'test-capture-key' });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('rejects batches larger than the max size', async () => {
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const items = Array.from({ length: 101 }, (_, i) => ({
      sourcePlatform: 'reddit',
      sourceId: `reddit:${i}`,
      sourceUrl: `https://reddit.com/${i}`,
      title: `Item ${i}`,
    }));
    const req = makeRequest({ items }, { 'x-triage-capture-key': 'test-capture-key' });

    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('skips items with an invalid sourcePlatform or missing required fields', async () => {
    mockIngest.mockResolvedValue([{ status: 'imported' }]);
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest(
      {
        items: [
          { sourcePlatform: 'not-a-real-platform', sourceId: 'x:1', sourceUrl: 'https://example.com/1', title: 'ok' },
          { sourcePlatform: 'reddit', sourceUrl: 'https://reddit.com/2', title: 'missing source id' },
          { sourcePlatform: 'reddit', sourceId: 'reddit:3', sourceUrl: 'https://reddit.com/3', title: 'valid' },
        ],
      },
      { 'x-triage-capture-key': 'test-capture-key' },
    );

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mockIngest).toHaveBeenCalledTimes(1);
    expect(mockIngest.mock.calls[0][0]).toHaveLength(1);
    expect(data.imported).toBe(1);
    expect(data.skipped).toBe(2);
    expect(data.errors.length).toBe(2);
  });

  it('aggregates imported/skipped counts across a mixed batch', async () => {
    mockIngest.mockResolvedValueOnce([
      { status: 'imported' },
      { status: 'skipped', reason: 'Already ingested for this source item' },
      { status: 'imported' },
    ]);

    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest(
      {
        items: [
          { sourcePlatform: 'reddit', sourceId: 'reddit:1', sourceUrl: 'https://reddit.com/1', title: 'a' },
          { sourcePlatform: 'instagram', sourceId: 'instagram:2', sourceUrl: 'https://instagram.com/p/2/', title: 'b' },
          { sourcePlatform: 'facebook', sourceId: 'facebook:3', sourceUrl: 'https://facebook.com/3', title: 'c' },
        ],
      },
      { 'x-triage-capture-key': 'test-capture-key' },
    );

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.imported).toBe(2);
    expect(data.skipped).toBe(1);
    expect(data.total).toBe(3);
  });

  it('fails the request without ambiguous item-by-item retry when the batch fails', async () => {
    mockIngest.mockRejectedValueOnce(new Error('boom'));
    const { POST } = await import('@/app/api/triage/import/bulk/route');
    const req = makeRequest(
      {
        items: [
          { sourcePlatform: 'reddit', sourceId: 'reddit:1', sourceUrl: 'https://reddit.com/1', title: 'a' },
          { sourcePlatform: 'reddit', sourceId: 'reddit:2', sourceUrl: 'https://reddit.com/2', title: 'b' },
        ],
      },
      { 'x-triage-capture-key': 'test-capture-key' },
    );

    const res = await POST(req);
    expect(res.status).toBe(500);
    expect(mockIngest).toHaveBeenCalledTimes(1);
  });
});
