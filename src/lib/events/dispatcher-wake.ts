import logger from '@/lib/logger';

const DISPATCH_RETRY_DELAY_MS = 30_000;
let dispatcherWakeScheduled = false;
let dispatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;
let registeredDrain: (() => Promise<unknown>) | null = null;

/**
 * Lets a long-lived dispatcher (the sync worker runtime) claim wake-ups so its
 * drains are tracked by that instance and awaited on shutdown. Without a
 * registration, wake-ups fall back to a one-shot drain, which is what the web
 * process does.
 */
export function registerEventOutboxDrain(drain: (() => Promise<unknown>) | null): void {
  registeredDrain = drain;
}

/**
 * Nudges the durable event outbox dispatcher after an enqueue. Coalesced to a
 * single microtask so a burst of enqueues produces one drain, and safe to call
 * from any process because delivery claims are owner/token fenced.
 */
export function wakeEventOutboxDispatcher(): void {
  if (dispatcherWakeScheduled) return;
  if (dispatcherRetryTimer) {
    clearTimeout(dispatcherRetryTimer);
    dispatcherRetryTimer = null;
  }
  dispatcherWakeScheduled = true;
  queueMicrotask(async () => {
    dispatcherWakeScheduled = false;
    try {
      if (registeredDrain) {
        await registeredDrain();
        return;
      }
      const { dispatchEventDeliveries } = await import('@/lib/events/dispatcher');
      await dispatchEventDeliveries();
    } catch (error) {
      // A background wake must never surface as an unhandled rejection, even if
      // reporting itself fails, so the retry timer is always armed.
      try {
        logger.error({ err: error }, 'Event outbox dispatcher failed');
      } catch {
        // Intentionally ignored: logging is best-effort here.
      }
      dispatcherRetryTimer = setTimeout(() => {
        dispatcherRetryTimer = null;
        wakeEventOutboxDispatcher();
      }, DISPATCH_RETRY_DELAY_MS);
      dispatcherRetryTimer.unref?.();
    }
  });
}

/** Test/shutdown helper: cancels a pending retry wake. */
export function clearEventOutboxWakeRetry(): void {
  if (dispatcherRetryTimer) {
    clearTimeout(dispatcherRetryTimer);
    dispatcherRetryTimer = null;
  }
}
