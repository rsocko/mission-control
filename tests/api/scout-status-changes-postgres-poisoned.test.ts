import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScoutStatusChangeRepository } from '@/lib/connectors/scout/status-change-repository';

const runtime = vi.hoisted(() => ({
  repository: {
    getAcknowledgedCursor: vi.fn(async () => '2026-09-08T10:00:00.000Z'),
    listChanges: vi.fn(async () => ({
      changes: [{
        mcTaskId: 'scout-poison',
        sourceId: 'scout:email:poison',
        sourceType: 'email',
        title: 'Poison proof',
        status: 'done',
        statusReason: 'handled',
        updatedAt: '2026-09-08T11:00:00.000Z',
        completedAt: '2026-09-08T11:00:00.000Z',
        snoozedUntil: null,
      }],
      hasMore: false,
    })),
    acknowledge: vi.fn(async ({ acknowledgedAt, updatedAt }: {
      acknowledgedAt: string;
      updatedAt: string;
    }) => ({ cursor: acknowledgedAt, updatedAt, advanced: true })),
  } satisfies ScoutStatusChangeRepository,
  sqliteTouch: vi.fn(),
}));

vi.mock('@/db', () => {
  runtime.sqliteTouch();
  throw new Error('SQLite was evaluated');
});
vi.mock('@/db/schema', () => {
  runtime.sqliteTouch();
  throw new Error('SQLite schema was evaluated');
});
vi.mock('@/lib/connectors/scout/status-change-runtime', () => ({
  getScoutStatusChangeRepository: () => runtime.repository,
}));

describe('PostgreSQL Scout status-change routes with SQLite poisoned', () => {
  beforeEach(() => {
    runtime.sqliteTouch.mockClear();
    runtime.repository.listChanges.mockClear();
    runtime.repository.acknowledge.mockClear();
    delete process.env.MC_API_KEY;
  });

  it('serves status reads without evaluating SQLite', async () => {
    const { GET } = await import('@/app/api/scout/status-changes/route');
    const response = await GET(new Request(
      'http://localhost/api/scout/status-changes?sourceTypes=email&limit=5',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      count: 1,
      since: '2026-09-08T10:00:00.000Z',
      cursorSource: 'write_back_cursor',
      changes: [{ mcTaskId: 'scout-poison', suppressRepush: true }],
    });
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });

  it('acknowledges cursors without evaluating SQLite', async () => {
    const { POST } = await import('@/app/api/scout/status-changes/ack/route');
    const response = await POST(new Request(
      'http://localhost/api/scout/status-changes/ack',
      {
        method: 'POST',
        body: JSON.stringify({ acknowledgedAt: '2026-09-08T11:00:00Z' }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      cursor: '2026-09-08T11:00:00.000Z',
    });
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });
});
