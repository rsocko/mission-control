import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

export async function getNotificationWebPersistence(): Promise<NotificationWebPersistence> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.notificationDelivery.web;
}
