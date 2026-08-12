import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockResolve = vi.fn();
const mockTrusted = vi.fn();

vi.mock('@/lib/api/trusted-request', () => ({
  isTrustedMutationRequest: (...args: unknown[]) => mockTrusted(...args),
}));

vi.mock('@/lib/sync/retention-resolution', () => ({
  resolveRetainedItems: (...args: unknown[]) => mockResolve(...args),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { POST } from '@/app/api/sync/retained/resolve/route';

function request(body: unknown) {
  return new Request('http://localhost/api/sync/retained/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('retained sync resolution API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrusted.mockReturnValue(true);
  });

  it('rejects untrusted mutations', async () => {
    mockTrusted.mockReturnValue(false);
    const response = await POST(request({ items: [] }));
    expect(response.status).toBe(401);
  });

  it('validates the bulk request shape', async () => {
    const response = await POST(request({ items: [] }));
    expect(response.status).toBe(422);
  });

  it('returns multi-status for a partial bulk resolution', async () => {
    mockResolve.mockResolvedValue([
      { success: true, message: 'Resolved', syncStatus: 'deleted' },
      { success: false, message: 'Failed' },
    ]);
    const response = await POST(request({
      items: [
        { syncLogId: 'log-1', detailIndex: 0, resolution: 'keep_local', confirmed: true },
        { syncLogId: 'log-1', detailIndex: 1, resolution: 'keep_local', confirmed: true },
      ],
    }));
    const body = await response.json();

    expect(response.status).toBe(207);
    expect(body).toMatchObject({ succeeded: 1, failed: 1 });
    expect(body.results[0]).toMatchObject({ success: true, syncStatus: 'deleted' });
  });
});
