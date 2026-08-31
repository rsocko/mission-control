import logger from '@/lib/logger';

const DISPATCH_RETRY_DELAY_MS = 30_000;
let dispatcherWakeScheduled = false;
let dispatcherRetryTimer: ReturnType<typeof setTimeout> | null = null;

export function wakeNotificationDeliveryDispatcher(): void {
  if (dispatcherWakeScheduled) return;
  if (dispatcherRetryTimer) {
    clearTimeout(dispatcherRetryTimer);
    dispatcherRetryTimer = null;
  }
  dispatcherWakeScheduled = true;
  queueMicrotask(async () => {
    dispatcherWakeScheduled = false;
    try {
      const { dispatchNotificationDeliveries } = await import('@/lib/push/dispatcher');
      await dispatchNotificationDeliveries();
    } catch (error) {
      logger.error({ err: error }, 'Push delivery dispatcher failed');
      dispatcherRetryTimer = setTimeout(() => {
        dispatcherRetryTimer = null;
        wakeNotificationDeliveryDispatcher();
      }, DISPATCH_RETRY_DELAY_MS);
      dispatcherRetryTimer.unref?.();
    }
  });
}
