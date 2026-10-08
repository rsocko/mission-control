import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionActionClient } from '@/lib/connectors/rymessage/companion-action-client';

const leaseV2Mutations = vi.hoisted(() => vi.fn());
const settleV2Mutation = vi.hoisted(() => vi.fn());

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectorState: {
      rymessageActions: {
        leaseV2Mutations,
        settleV2Mutation,
      },
    },
  }),
}));

import { flushRyMessageV2MutationOutbox } from '@/lib/connectors/rymessage/durable-v2-mutations';

const request = {
  contractVersion: '2.0' as const,
  operationId: '00000000-0000-4000-8000-000000000001',
  actionId: '00000000-0000-4000-8000-000000000002',
  baseRevision: 1,
  mutation: {
    kind: 'action.lifecycle' as const,
    state: 'handled' as const,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  leaseV2Mutations.mockResolvedValue({
    leaseId: 'lease-1',
    items: [
      { operationId: request.operationId, request },
      {
        operationId: '00000000-0000-4000-8000-000000000003',
        request: {
          ...request,
          operationId: '00000000-0000-4000-8000-000000000003',
        },
      },
    ],
  });
  settleV2Mutation.mockResolvedValue(true);
});

describe('RyMessage durable mutation cancellation', () => {
  it('does not lease outbox work after the sync is already aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('Sync duration budget exceeded');
    controller.abort(reason);
    const client = {
      fetchPageV2: vi.fn(),
      validateMutationV2: vi.fn(() => true),
      submitMutationV2: vi.fn(),
    } satisfies CompanionActionClient;

    await expect(
      flushRyMessageV2MutationOutbox('rymessage-1', client, controller.signal),
    ).rejects.toBe(reason);
    expect(leaseV2Mutations).not.toHaveBeenCalled();
    expect(client.submitMutationV2).not.toHaveBeenCalled();
  });

  it('settles the active mutation and stops the batch when an in-flight call is aborted', async () => {
    const controller = new AbortController();
    const reason = new Error('Sync duration budget exceeded');
    const client = {
      fetchPageV2: vi.fn(),
      validateMutationV2: vi.fn(() => true),
      submitMutationV2: vi.fn(async () => {
        controller.abort(reason);
        throw reason;
      }),
    } satisfies CompanionActionClient;

    await expect(
      flushRyMessageV2MutationOutbox('rymessage-1', client, controller.signal),
    ).rejects.toBe(reason);
    expect(client.submitMutationV2).toHaveBeenCalledOnce();
    expect(settleV2Mutation).toHaveBeenCalledWith(expect.objectContaining({
      connectorId: 'rymessage-1',
      operationId: request.operationId,
      leaseId: 'lease-1',
      retryable: true,
    }));
  });
});
