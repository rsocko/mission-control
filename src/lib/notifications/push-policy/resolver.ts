import 'server-only';

import {
  getWorkerPersistenceRepositories,
} from '@/lib/persistence/worker-runtime';
import type {
  ResolveStoredNotificationPushPolicyInput,
} from '@/db/persistence/notification-delivery';

export type { ResolveStoredNotificationPushPolicyInput };

export async function resolveStoredNotificationPushPolicy(
  input: ResolveStoredNotificationPushPolicyInput,
) {
  return (await getWorkerPersistenceRepositories()).notificationDelivery.policy.resolve(input);
}
