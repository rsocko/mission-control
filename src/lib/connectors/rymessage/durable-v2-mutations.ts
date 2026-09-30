import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  CompanionActionMutationReceiptV2,
  CompanionActionMutationRequestV2,
} from './action-contract-v2';
import type { CompanionActionClient } from './companion-action-client';

export async function flushRyMessageV2MutationOutbox(
  connectorId: string,
  client: CompanionActionClient,
  signal?: AbortSignal,
): Promise<Map<string, CompanionActionMutationReceiptV2>> {
  const repository = (await getWorkerPersistenceRepositories())
    .connectorState.rymessageActions;
  const now = new Date().toISOString();
  const lease = await repository.leaseV2Mutations({
    connectorId,
    now,
    limit: 100,
  });
  const receipts = new Map<string, CompanionActionMutationReceiptV2>();
  for (const item of lease.items) {
    try {
      const receipt = await client.submitMutationV2(item.request, signal);
      await repository.settleV2Mutation({
        connectorId,
        operationId: item.operationId,
        leaseId: lease.leaseId,
        receipt,
        now: new Date().toISOString(),
      });
      receipts.set(item.operationId, receipt);
    } catch (error) {
      const retryable = !(
        error
        && typeof error === 'object'
        && 'retryable' in error
        && error.retryable === false
      );
      await repository.settleV2Mutation({
        connectorId,
        operationId: item.operationId,
        leaseId: lease.leaseId,
        retryable,
        errorCode: error instanceof Error ? error.message.slice(0, 128) : 'mutation_failed',
        now: new Date().toISOString(),
      });
      if (!retryable) throw error;
    }
  }
  return receipts;
}

export async function submitDurableRyMessageV2Mutation(
  connectorId: string,
  client: CompanionActionClient,
  request: CompanionActionMutationRequestV2,
  signal?: AbortSignal,
): Promise<CompanionActionMutationReceiptV2> {
  const repository = (await getWorkerPersistenceRepositories())
    .connectorState.rymessageActions;
  await repository.enqueueV2Mutation({
    connectorId,
    request,
    now: new Date().toISOString(),
  });
  const receipts = await flushRyMessageV2MutationOutbox(connectorId, client, signal);
  const receipt = receipts.get(request.operationId);
  if (receipt) return receipt;

  // Another worker may hold the durable lease. Companion idempotency makes this
  // bounded response-recovery probe safe without creating a second operation.
  return client.submitMutationV2(request, signal);
}
