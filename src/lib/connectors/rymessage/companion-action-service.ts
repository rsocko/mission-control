import type { RyMessageActionPersistence } from '@/db/persistence/rymessage-actions';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  isActionIntegrationMutationRequestV2,
  type ActionIntegrationMutationRequestV2,
} from './action-contract';

export async function queueCompanionActionMutation(
  connectorId: string,
  request: ActionIntegrationMutationRequestV2,
  persistence?: RyMessageActionPersistence,
): Promise<{ operationId: string; queued: boolean }> {
  if (!isActionIntegrationMutationRequestV2(request)) {
    throw new Error('Invalid Companion ActionV2 mutation request');
  }
  const repository = persistence
    ?? (await getWorkerPersistenceRepositories()).connectorState.rymessageActions;
  const result = await repository.enqueueV2Mutation({
    connectorId,
    request,
    now: new Date().toISOString(),
  });
  return {
    operationId: request.operationId,
    queued: result === 'queued',
  };
}
