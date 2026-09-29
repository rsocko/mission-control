import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RyMessageActionPersistence } from '@/db/persistence/rymessage-actions';
import type {
  CompanionActionFeedPage,
  CompanionActionMaterialization,
  CompanionActionV1,
} from '@/lib/connectors/rymessage/action-contract';

const NOW = '2026-09-29T23:00:00.000Z';
const CONNECTOR_ID = 'l11-rymessage-actions';
const FEED_ID = '00000000-0000-4000-8000-000000009001';

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`;
}

function materialization(): CompanionActionMaterialization {
  return {
    materializationId: uuid(9_100),
    revision: 1,
    provider: 'microsoft-todo',
    providerAccountId: 'opaque-account',
    providerListId: 'list-1',
    providerTaskId: 'task-1',
    state: 'materialized',
    updatedAt: NOW,
  };
}

function action(relation: CompanionActionMaterialization): CompanionActionV1 {
  return {
    contractVersion: 1,
    actionId: uuid(9_200),
    stableKey: `ak1:${'c'.repeat(64)}`,
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    lastSeenAt: NOW,
    source: {
      identity: {
        kind: 'provider_message',
        provider: 'microsoft',
        id: 'message-1',
      },
      sourceKind: 'message',
    },
    content: {
      title: 'Contract action',
      actionType: 'follow-up',
    },
    classification: {
      derivationMethod: 'deterministic',
      inputFingerprint: 'd'.repeat(64),
    },
    lifecycle: { state: 'visible' },
    fieldRevisions: {
      title: 1,
      lifecycle: 1,
      [`materialization:${relation.materializationId}`]: 1,
    },
    materializations: [relation],
  };
}

function page(source: CompanionActionV1): CompanionActionFeedPage {
  return {
    schemaVersion: '1.0',
    feedId: FEED_ID,
    mode: 'full',
    producedAt: NOW,
    nextCursor: 'cursor-1',
    complete: true,
    items: [{
      eventId: uuid(9_300),
      operationId: uuid(9_400),
      aggregateId: source.actionId,
      aggregateVersion: source.revision,
      sourceId: 'rymessage:contract-action',
      occurredAt: NOW,
      kind: 'upsert',
      action: source,
    }],
  };
}

export interface RyMessageActionRepositoryHarness {
  repository(): RyMessageActionPersistence;
  setup(): Promise<void>;
  reset(): Promise<void>;
  seedProviderTask(input: {
    sourceId: string;
    status: string;
    updatedAt: string;
  }): Promise<void>;
  queuedMutations(): Promise<Array<{
    operationId: string;
    mutation: unknown;
  }>>;
  mutationStatus(operationId: string): Promise<{
    status: string;
    errorCode: string | null;
  } | null>;
}

export function runRyMessageActionRepositoryContract(
  name: string,
  input: {
    enabled: boolean;
    harness: RyMessageActionRepositoryHarness;
  },
): void {
  const suite = input.enabled ? describe : describe.skip;
  suite(name, () => {
    beforeAll(() => input.harness.setup());
    beforeEach(() => input.harness.reset());

    it('reconciles exact provider identity and keeps repeated observations idempotent', async () => {
      const repository = input.harness.repository();
      const relation = materialization();
      const source = action(relation);
      await repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: page(source),
        requestedCursor: null,
        receivedAt: NOW,
      });
      await input.harness.seedProviderTask({
        sourceId: 'list-1:task-1',
        status: 'done',
        updatedAt: '2026-09-29T23:01:00.000Z',
      });

      const first = await repository.reconcileMaterializations({
        connectorId: CONNECTOR_ID,
        now: '2026-09-29T23:02:00.000Z',
      });
      const second = await repository.reconcileMaterializations({
        connectorId: CONNECTOR_ID,
        now: '2026-09-29T23:03:00.000Z',
      });
      expect(first).toMatchObject({ linked: 1, observationsQueued: 1 });
      expect(second).toMatchObject({ linked: 1, observationsQueued: 0 });
      const queued = await input.harness.queuedMutations();
      expect(queued).toHaveLength(1);
      expect(queued[0]?.mutation).toMatchObject({
        kind: 'materialization.observe',
        materializationId: relation.materializationId,
        providerTaskStatusSnapshot: 'completed',
        providerVersionSnapshot: '2026-09-29T23:01:00.000Z',
        observedAt: '2026-09-29T23:01:00.000Z',
      });
    });

    it('quarantines same-revision divergence until explicit recovery invalidation', async () => {
      const repository = input.harness.repository();
      const source = action(materialization());
      await repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: page(source),
        requestedCursor: null,
        receivedAt: NOW,
      });
      const divergentPage = page({
        ...source,
        content: { ...source.content, title: 'Divergent contract action' },
      });
      divergentPage.mode = 'incremental';
      divergentPage.nextCursor = 'cursor-conflict';
      divergentPage.items[0] = {
        ...divergentPage.items[0]!,
        eventId: uuid(9_301),
        operationId: uuid(9_401),
      };
      await expect(repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: divergentPage,
        requestedCursor: 'cursor-1',
        receivedAt: '2026-09-29T23:01:00.000Z',
      })).resolves.toMatchObject({ conflicts: 1, recoveryRequired: true });
      expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
        cursor: 'cursor-1',
        recoveryRequired: true,
        lastError: expect.stringContaining('REVISION_CONFLICT'),
      });
      await expect(repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: divergentPage,
        requestedCursor: 'cursor-1',
        receivedAt: '2026-09-29T23:02:00.000Z',
      })).rejects.toMatchObject({ code: 'RECOVERY_CONFLICT' });
      await repository.invalidateRecovery({
        connectorId: CONNECTOR_ID,
        reason: 'operator-reset',
        now: '2026-09-29T23:03:00.000Z',
      });
      expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
        cursor: null,
        recoveryGeneration: 1,
      });
      divergentPage.mode = 'full';
      divergentPage.nextCursor = 'cursor-resolved';
      await expect(repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: divergentPage,
        requestedCursor: null,
        receivedAt: '2026-09-29T23:04:00.000Z',
      })).resolves.toMatchObject({ applied: 1, recoveryCompleted: true });
      expect(await repository.readFeedState(CONNECTOR_ID)).toMatchObject({
        cursor: 'cursor-resolved',
        recoveryRequired: false,
        lastError: null,
      });
    });

    it('rejects future revision claims and accepts stale non-overlap', async () => {
      const repository = input.harness.repository();
      const source = {
        ...action(materialization()),
        revision: 5,
        fieldRevisions: { title: 5, details: 2, lifecycle: 4 },
      };
      await repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: page(source),
        requestedCursor: null,
        receivedAt: NOW,
      });
      await expect(repository.enqueueMutation({
        connectorId: CONNECTOR_ID,
        actionId: source.actionId,
        operationId: uuid(9_510),
        baseRevision: 999,
        expectedFieldRevisions: { title: 5 },
        mutation: { kind: 'action.user-edit', patch: { title: 'Future base' } },
        now: NOW,
      })).rejects.toMatchObject({ code: 'FUTURE_BASE_REVISION' });
      await expect(repository.enqueueMutation({
        connectorId: CONNECTOR_ID,
        actionId: source.actionId,
        operationId: uuid(9_511),
        baseRevision: 5,
        expectedFieldRevisions: { title: 999 },
        mutation: { kind: 'action.user-edit', patch: { title: 'Future field' } },
        now: NOW,
      })).rejects.toMatchObject({ code: 'FUTURE_FIELD_REVISION' });
      await expect(repository.enqueueMutation({
        connectorId: CONNECTOR_ID,
        actionId: source.actionId,
        operationId: uuid(9_512),
        baseRevision: 4,
        expectedFieldRevisions: { details: 2 },
        mutation: { kind: 'action.user-edit', patch: { details: 'Safe stale edit' } },
        now: NOW,
      })).resolves.toBe('queued');
    });

    it('does not settle a lease with an unrelated receipt', async () => {
      const repository = input.harness.repository();
      const source = action(materialization());
      await repository.applyFeedPage({
        connectorId: CONNECTOR_ID,
        page: page(source),
        requestedCursor: null,
        receivedAt: NOW,
      });
      const operationId = uuid(9_520);
      await repository.enqueueMutation({
        connectorId: CONNECTOR_ID,
        actionId: source.actionId,
        operationId,
        baseRevision: 1,
        expectedFieldRevisions: { title: 1 },
        mutation: { kind: 'action.user-edit', patch: { title: 'Changed' } },
        now: NOW,
      });
      const lease = await repository.leaseMutations({
        connectorId: CONNECTOR_ID,
        now: '2026-09-29T23:01:00.000Z',
      });
      await repository.completeMutation({
        connectorId: CONNECTOR_ID,
        operationId,
        leaseId: lease.leaseId,
        receipt: {
          operationId: uuid(9_521),
          actionId: uuid(9_522),
          outcome: 'applied',
          revision: 2,
        },
        retryable: false,
        now: '2026-09-29T23:02:00.000Z',
      });
      await expect(input.harness.mutationStatus(operationId)).resolves.toEqual({
        status: 'conflict',
        errorCode: 'RECEIPT_IDENTITY_MISMATCH',
      });
    });
  });
}

export const RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID = CONNECTOR_ID;
