import { describe, expect, it } from 'vitest';
import type { WorkerPersistenceRepositories } from '@/db/persistence/worker-repositories';
import {
  POSTGRES_PACKAGED_WORKFLOW_FAMILIES,
  composePostgresPackagedWorkflowCapability,
  isPostgresBackendWorkflowSupported,
  PostgresWorkerProcessingLatch,
  type PostgresPackagedWorkflowCapability,
} from '@/lib/runtime/postgres-workflow-capability';
import { DURABLE_AI_ENQUEUEABLE_ROUTES } from '@/lib/ai/durable-runs/route-contract';
import { SEMANTIC_SOURCE_ENTITY_TYPES } from '@/lib/semantic-index/source/contracts';

function persistence(): WorkerPersistenceRepositories {
  const noOp = async () => undefined;
  return {
    planningSignals: {
      append: async () => true,
      finalize: async () => ({
        commitmentsBackfilled: 0,
        myDayMisses: 0,
        focusMisses: 0,
        elapsedBlocks: 0,
        overdueTransitions: 0,
      }),
      finalizeIfDue: async () => null,
    },
    projectAutomation: {
      evaluateAll: async () => [],
      evaluateProject: async () => ({ added: 0, matched: 0, matches: [] }),
      previewProject: async () => [],
      evaluateTasks: noOp,
    },
    eventDelivery: {
      outbox: {
        enqueue: async () => ({ created: true, sequence: 1, deliveryCount: 0 }),
        claimNext: async () => null,
        heartbeat: async () => true,
        markDelivered: async () => true,
        scheduleRetry: async () => true,
        deadLetter: async () => true,
        recoverStaleLeases: async () => 0,
        getNextWakeAt: async () => null,
      },
      subscriptions: {
        listMatching: async () => [],
        recordDeliveryOutcome: noOp,
      },
    },
    notificationEnrichment: {
      claimNext: async () => null,
      heartbeat: async () => true,
      complete: async () => 'completed',
      scheduleRetry: async () => true,
      deadLetter: async () => true,
      recoverStaleLeases: async () => 0,
      getNextWakeAt: async () => null,
    },
  } as WorkerPersistenceRepositories;
}

function compose(
  overrides: Partial<Parameters<
    typeof composePostgresPackagedWorkflowCapability
  >[0]> = {},
): PostgresPackagedWorkflowCapability {
  return composePostgresPackagedWorkflowCapability({
    persistence: persistence(),
    durableExecutorRoutes: DURABLE_AI_ENQUEUEABLE_ROUTES,
    semanticEntityTypes: SEMANTIC_SOURCE_ENTITY_TYPES,
    semanticIntentKinds: ['upsert', 'delete'],
    lifecycleStops: Object.fromEntries(
      POSTGRES_PACKAGED_WORKFLOW_FAMILIES.map((family) => [family, () => {}]),
    ) as Record<(typeof POSTGRES_PACKAGED_WORKFLOW_FAMILIES)[number], () => void>,
    ...overrides,
  });
}

describe('PostgreSQL packaged workflow capability', () => {
  it('exposes immutable all-six backend support to producer processes', () => {
    for (const workflow of POSTGRES_PACKAGED_WORKFLOW_FAMILIES) {
      expect(isPostgresBackendWorkflowSupported(workflow)).toBe(true);
    }
  });

  it('opens and revokes the worker-local processing latch as one edge', () => {
    const latch = new PostgresWorkerProcessingLatch();
    const capability = compose();
    let wakes = 0;
    latch.onActivate(() => {
      wakes += 1;
    });
    expect(latch.isActive()).toBe(false);
    latch.activate(capability);
    expect(latch.isActive()).toBe(true);
    expect(wakes).toBe(1);
    expect(() => latch.activate(capability)).toThrow(/activation is invalid/);
    expect(wakes).toBe(1);
    latch.deactivate(capability);
    expect(latch.isActive()).toBe(false);
    latch.deactivate(capability);
    expect(latch.isActive()).toBe(false);
  });

  it('does not expose one latch instance to another process composition', () => {
    const workerA = new PostgresWorkerProcessingLatch();
    const workerB = new PostgresWorkerProcessingLatch();
    const capability = compose();
    workerA.activate(capability);
    expect(workerA.isActive()).toBe(true);
    expect(workerB.isActive()).toBe(false);
    workerA.deactivate(capability);
    for (const workflow of POSTGRES_PACKAGED_WORKFLOW_FAMILIES) {
      expect(isPostgresBackendWorkflowSupported(workflow)).toBe(true);
    }
  });

  it.each([
    ['repository methods', {
      persistence: {
        ...persistence(),
        planningSignals: {},
      } as WorkerPersistenceRepositories,
    }],
    ['executor routes', { durableExecutorRoutes: [] }],
    ['semantic entities', { semanticEntityTypes: ['task'] }],
    ['semantic intents', { semanticIntentKinds: ['upsert'] }],
    ['lifecycle stops', {
      lifecycleStops: {} as Parameters<
        typeof composePostgresPackagedWorkflowCapability
      >[0]['lifecycleStops'],
    }],
  ] as const)('fails closed for incomplete %s', (_label, overrides) => {
    expect(() => compose(overrides)).toThrow(/incomplete/);
  });
});
