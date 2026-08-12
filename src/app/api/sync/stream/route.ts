import { syncEventBus } from '@/lib/sync/events';
import type { SyncStreamEvent } from '@/lib/sync/events';
import {
  getLatestSyncJobEventId,
  getSyncJobEventsAfter,
  isDurableSyncMode,
} from '@/lib/sync/job-queue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request) {
  const encoder = new TextEncoder();
  const suppliedCursor = request.headers.get('last-event-id')
    ?? new URL(request.url).searchParams.get('cursor');
  const parsedCursor = suppliedCursor === null ? Number.NaN : Number(suppliedCursor);

  const stream = new ReadableStream({
    start(controller) {
      let persistedCursor = isDurableSyncMode()
        ? Number.isSafeInteger(parsedCursor) && parsedCursor >= 0
          ? parsedCursor
          : getLatestSyncJobEventId()
        : 0;
      const send = (event: SyncStreamEvent, eventId?: number) => {
        const id = eventId === undefined ? '' : `id: ${eventId}\n`;
        const data = `${id}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        try {
          controller.enqueue(encoder.encode(data));
        } catch {
          // Stream closed
          cleanup();
        }
      };

      // Send keepalive every 30s to prevent timeout
      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'));
        } catch {
          cleanup();
        }
      }, 30_000);

      const persistedEvents = isDurableSyncMode()
        ? setInterval(() => {
            for (const item of getSyncJobEventsAfter(persistedCursor)) {
              persistedCursor = item.id;
              send(item.event, item.id);
            }
          }, 500)
        : null;

      const cleanup = () => {
        clearInterval(keepalive);
        if (persistedEvents) clearInterval(persistedEvents);
        syncEventBus.offSyncEvent(send);
        request.signal.removeEventListener('abort', cleanup);
      };

      syncEventBus.onSyncEvent(send);
      request.signal.addEventListener('abort', cleanup, { once: true });

      // Send initial connected event
      const connected = `event: connected\ndata: ${JSON.stringify({
        ts: Date.now(),
        cursor: persistedCursor,
      })}\n\n`;
      controller.enqueue(encoder.encode(connected));
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
