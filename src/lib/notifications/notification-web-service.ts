import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

let primedWeb: NotificationWebPersistence | null = null;

export function primeNotificationWebPersistence(
  web: NotificationWebPersistence,
): void {
  primedWeb = web;
}

export async function getNotificationWebPersistence(): Promise<NotificationWebPersistence> {
  if (primedWeb) return primedWeb;
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.notificationDelivery.web;
}
