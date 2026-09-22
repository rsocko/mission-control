import type { EventDeliveryRepositories } from '@/db/persistence/event-outbox';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/**
 * Resolves the durable event-delivery ports from the selected persistence
 * backend. A backend that has not registered them is a wiring fault and throws
 * rather than degrading to a silent no-op.
 */
export async function resolveEventDeliveryRepositories(
  repositories?: EventDeliveryRepositories,
): Promise<EventDeliveryRepositories> {
  if (repositories) return repositories;
  const worker = await getWorkerPersistenceRepositories();
  if (!worker.eventDelivery?.outbox || !worker.eventDelivery.subscriptions) {
    throw new Error('Event delivery repositories are not registered for the selected backend');
  }
  return worker.eventDelivery;
}
