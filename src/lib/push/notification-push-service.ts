import type { NotificationPushPersistence } from '@/db/persistence/notification-push';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export async function getNotificationPushPersistence(): Promise<NotificationPushPersistence> {
  const repositories = await getWorkerPersistenceRepositories();
  return repositories.notificationDelivery.push;
}
