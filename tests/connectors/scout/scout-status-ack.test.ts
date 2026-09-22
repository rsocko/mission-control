import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoutStatusChangeRepository } from '@/lib/connectors/scout/status-change-repository';

const runtime = vi.hoisted(() => ({
  repository: {
    getAcknowledgedCursor: vi.fn(),
    listChanges: vi.fn(),
    acknowledge: vi.fn(async ({ acknowledgedAt, updatedAt }: {
      acknowledgedAt: string;
      updatedAt: string;
    }) => ({ cursor: acknowledgedAt, updatedAt, advanced: true })),
  } satisfies ScoutStatusChangeRepository,
}));

vi.mock('@/lib/connectors/scout/status-change-runtime', () => ({
  getScoutStatusChangeRepository: () => runtime.repository,
}));
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/scout/status-changes/ack', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /api/scout/status-changes/ack', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MC_API_KEY;
  });

  it('enforces the configured API key', async () => {
    process.env.MC_API_KEY = 'secret';
    const { POST } = await import('@/app/api/scout/status-changes/ack/route');

    expect((await POST(request({ acknowledgedAt: '2026-09-08T11:00:00Z' }))).status)
      .toBe(401);
    expect((await POST(request(
      { acknowledgedAt: '2026-09-08T11:00:00Z' },
      { 'x-mc-api-key': 'secret' },
    ))).status).toBe(200);
  });

  it('normalizes and acknowledges a valid timestamp', async () => {
    const { POST } = await import('@/app/api/scout/status-changes/ack/route');
    const response = await POST(request({ acknowledgedAt: '2026-09-08T11:00:00Z' }));

    expect(response.status).toBe(200);
    expect(runtime.repository.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      acknowledgedAt: '2026-09-08T11:00:00.000Z',
    }));
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      cursor: '2026-09-08T11:00:00.000Z',
    });
  });

  it.each([
    [{}, 'acknowledgedAt is required'],
    [{ acknowledgedAt: 123 }, 'acknowledgedAt is required'],
    [{ acknowledgedAt: 'not-a-date' }, 'valid ISO timestamp'],
  ])('rejects invalid acknowledgement payloads', async (body, message) => {
    const { POST } = await import('@/app/api/scout/status-changes/ack/route');
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain(message);
    expect(runtime.repository.acknowledge).not.toHaveBeenCalled();
  });
});
