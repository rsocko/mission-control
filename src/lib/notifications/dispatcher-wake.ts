import logger from '@/lib/logger';

let dispatcherWakeScheduled = false;

export function wakeNotificationDeliveryDispatcher(): void {
  if (dispatcherWakeScheduled) return;
  dispatcherWakeScheduled = true;
  queueMicrotask(async () => {
    dispatcherWakeScheduled = false;
    try {
      const { dispatchNotificationDeliveries } = await import('@/lib/push/dispatcher');
      await dispatchNotificationDeliveries();
    } catch (error) {
      logger.error({ err: error }, 'Push delivery dispatcher failed');
    }
  });
}
