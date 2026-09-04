import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

let cachedWeb: NotificationWebPersistence | null = null;

export async function getNotificationWebPersistence(): Promise<NotificationWebPersistence> {
  if (cachedWeb) return cachedWeb;
  const repositories = await getWorkerPersistenceRepositories();
  cachedWeb = repositories.notificationDelivery.web;
  return cachedWeb;
}

/** Reset the cached reference (for testing or lifecycle teardown). */
export function clearNotificationWebPersistenceCache(): void {
  cachedWeb = null;
}
