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
  });
}

export const RYMESSAGE_ACTION_CONTRACT_CONNECTOR_ID = CONNECTOR_ID;
