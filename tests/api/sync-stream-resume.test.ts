import { describe, expect, it, vi } from 'vitest';

const getEvents = vi.fn(() => Promise.resolve([{
  id: 5,
  jobId: 'job-1',
  connectorId: 'github-1',
  event: {
    type: 'sync:complete' as const,
    connectorId: 'github-1',
    queueRemaining: 0,
    result: {
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      tasksPushed: 0,
      localOnlyProtected: 0,
      totalLists: 0,
      durationMs: 1,
    },
  },
  createdAt: '2026-08-03T00:00:00.000Z',
}]));
const getLatestEventId = vi.fn(() => Promise.resolve(99));

vi.mock('@/lib/sync/job-queue', () => ({
  getSyncJobRepository: () => ({
    getLatestEventId,
    getEventsAfter: getEvents,
  }),
  isDurableSyncMode: vi.fn(() => true),
}));
vi.mock('@/lib/sync/events', () => ({
  syncEventBus: {
    onSyncEvent: vi.fn(),
    offSyncEvent: vi.fn(),
  },
}));

describe('sync stream resume', () => {
  it('replays from Last-Event-ID and emits durable SSE IDs', async () => {
    const controller = new AbortController();
    const { GET } = await import('@/app/api/sync/stream/route');
    const response = await GET(new Request('http://localhost/api/sync/stream', {
      headers: { 'Last-Event-ID': '4' },
      signal: controller.signal,
    }));
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const connected = decoder.decode((await reader.read()).value);
    expect(connected).toContain('"cursor":4');

    const event = decoder.decode((await reader.read()).value);
    expect(getEvents).toHaveBeenCalledWith(4);
    expect(event).toContain('id: 5');
    expect(event).toContain('event: sync:complete');

    controller.abort();
    await reader.cancel();
  });
});
