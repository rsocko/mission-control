import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoutStatusChangeRepository } from '@/lib/connectors/scout/status-change-repository';

const runtime = vi.hoisted(() => ({
  repository: {
    getAcknowledgedCursor:
      vi.fn<ScoutStatusChangeRepository['getAcknowledgedCursor']>(async () => null),
    listChanges:
      vi.fn<ScoutStatusChangeRepository['listChanges']>(
        async () => ({ changes: [], hasMore: false }),
      ),
    acknowledge: vi.fn<ScoutStatusChangeRepository['acknowledge']>(),
  } satisfies ScoutStatusChangeRepository,
}));

vi.mock('@/lib/connectors/scout/status-change-runtime', () => ({
  getScoutStatusChangeRepository: () => runtime.repository,
}));
vi.mock('@/lib/logger', () => ({
  default: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

function request(
  params: Record<string, string> = {},
  headers: Record<string, string> = {},
): Request {
  const url = new URL('http://localhost/api/scout/status-changes');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return new Request(url, { headers });
}

describe('GET /api/scout/status-changes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.MC_API_KEY;
    runtime.repository.getAcknowledgedCursor.mockResolvedValue(null);
    runtime.repository.listChanges.mockResolvedValue({ changes: [], hasMore: false });
  });

  it('enforces the configured API key', async () => {
    process.env.MC_API_KEY = 'secret';
    const { GET } = await import('@/app/api/scout/status-changes/route');

    expect((await GET(request())).status).toBe(401);
    expect((await GET(request({}, { authorization: 'Bearer secret' }))).status).toBe(200);
  });

  it('uses the acknowledgement cursor and returns the stable response shape', async () => {
    runtime.repository.getAcknowledgedCursor.mockResolvedValue(
      '2026-09-08T10:00:00.000Z',
    );
    runtime.repository.listChanges.mockResolvedValue({
      changes: [{
        mcTaskId: 'scout-1',
        sourceId: 'scout:email:1',
        sourceType: 'email',
        title: 'Handled',
        status: 'done',
        statusReason: 'handled',
        updatedAt: '2026-09-08T11:00:00.000Z',
        completedAt: '2026-09-08T11:00:00.000Z',
        snoozedUntil: null,
      }],
      hasMore: true,
    });
    const { GET } = await import('@/app/api/scout/status-changes/route');
    const response = await GET(request({ sourceTypes: 'email, teams', limit: '1' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      count: 1,
      hasMore: true,
      since: '2026-09-08T10:00:00.000Z',
      cursorSource: 'write_back_cursor',
      changes: [{ mcTaskId: 'scout-1', suppressRepush: true }],
    });
    expect(runtime.repository.listChanges).toHaveBeenCalledWith(expect.objectContaining({
      since: '2026-09-08T10:00:00.000Z',
      sourceTypes: ['email', 'teams'],
      limit: 1,
    }));
  });

  it('prefers an explicit cursor and validates malformed timestamps', async () => {
    const { GET } = await import('@/app/api/scout/status-changes/route');
    const explicit = await GET(request({ since: '2026-09-08T09:00:00Z' }));
    const invalid = await GET(request({ since: 'not-a-date' }));

    expect(explicit.status).toBe(200);
    expect(await explicit.json()).toMatchObject({
      cursorSource: 'explicit',
      since: '2026-09-08T09:00:00.000Z',
    });
    expect(runtime.repository.getAcknowledgedCursor).not.toHaveBeenCalled();
    expect(invalid.status).toBe(400);
    expect(runtime.repository.listChanges).toHaveBeenCalledTimes(1);
  });

  it('does not expose metadata through malformed or unknown source records', async () => {
    runtime.repository.listChanges.mockResolvedValue({
      changes: [{
        mcTaskId: 'legacy',
        sourceId: 'scout:legacy:1',
        sourceType: 'unknown',
        title: 'Legacy',
        status: 'todo',
        statusReason: null,
        updatedAt: '2026-09-08T11:00:00.000Z',
        completedAt: null,
        snoozedUntil: null,
      }],
      hasMore: false,
    });
    const { GET } = await import('@/app/api/scout/status-changes/route');
    const body = await (await GET(request())).json();

    expect(body.changes[0]).toEqual({
      mcTaskId: 'legacy',
      sourceId: 'scout:legacy:1',
      sourceType: 'unknown',
      title: 'Legacy',
      status: 'todo',
      statusReason: null,
      updatedAt: '2026-09-08T11:00:00.000Z',
      completedAt: null,
      snoozedUntil: null,
      suppressRepush: false,
    });
  });
});
