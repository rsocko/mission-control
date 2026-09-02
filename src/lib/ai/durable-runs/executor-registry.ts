import 'server-only';

import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
} from '../copilot-run-events';
import type {
  CopilotRunSnapshot,
  CreateCopilotRunInput,
} from '../copilot-session-lifecycle';
import {
  copilotRunInputFromDurableRun,
  createDurableCopilotPersistence,
} from './copilot-adapter';
import type { DurableAiRunRepository } from './repository';
import type { ClaimedDurableAiRun } from './types';
import type {
  DurableAiRunCleanupContext,
  DurableAiRunExecutionContext,
  DurableAiRunExecutor,
} from './worker';

export const DURABLE_AI_ENQUEUEABLE_ROUTES = [
  COPILOT_EXECUTION_ROUTE,
] as const;

export type DurableAiEnqueueableRoute =
  (typeof DURABLE_AI_ENQUEUEABLE_ROUTES)[number];

export interface DirectCopilotExecutorLifecycle {
  getRun(runId: string): Promise<CopilotRunSnapshot | undefined>;
  createRun(input: CreateCopilotRunInput): Promise<CopilotRunSnapshot>;
  resumeRun(runId: string): Promise<CopilotRunSnapshot>;
  completeRun(runId: string): Promise<CopilotRunSnapshot>;
  cancelRun(runId: string): Promise<CopilotRunSnapshot>;
  retryCleanup(runId: string): Promise<CopilotRunSnapshot>;
  recoverExpiredWorkerLeases(): Promise<CopilotRunSnapshot[]>;
  shutdownForRestart(): Promise<void>;
}

export interface DurableAiExecutorRegistryDependencies {
  ownerId: string;
  durableRuns: DurableAiRunRepository;
  createCopilotLifecycle(
    persistence: Awaited<ReturnType<typeof createDurableCopilotPersistence>>,
    run: ClaimedDurableAiRun,
  ): DirectCopilotExecutorLifecycle;
}

interface ExecutorCapabilities {
  execute: true;
  cancel: true;
  cleanup: true;
}

const REQUIRED_CAPABILITIES = {
  [COPILOT_EXECUTION_ROUTE]: {
    execute: true,
    cancel: true,
    cleanup: true,
  },
} satisfies Record<DurableAiEnqueueableRoute, ExecutorCapabilities>;

const COPILOT_RECOVERABLE_STATES = new Set([
  'creating',
  'active',
  'resuming',
  'cancelling',
]);

function assertClaimOwner(
  context: DurableAiRunExecutionContext,
  ownerId: string,
): void {
  if (context.run.leaseOwner !== ownerId) {
    throw new Error(
      `Durable AI run ${context.run.id} is claimed by a different executor owner.`,
    );
  }
}

async function assertPersistedClaim(
  dependencies: DurableAiExecutorRegistryDependencies,
  run: ClaimedDurableAiRun,
): Promise<void> {
  const current = await dependencies.durableRuns.getInternalRun(run.id);
  if (
    !current
    || current.leaseOwner !== dependencies.ownerId
    || current.attempt !== run.attempt
    || !current.leaseExpiresAt
    || current.leaseExpiresAt <= new Date().toISOString()
  ) {
    throw new Error(`Durable AI run ${run.id} ownership was lost.`);
  }
}

async function recoverCopilotRun(
  lifecycle: DirectCopilotExecutorLifecycle,
  runId: string,
): Promise<CopilotRunSnapshot | undefined> {
  let record = await lifecycle.getRun(runId);
  if (
    record
    && COPILOT_RECOVERABLE_STATES.has(record.state)
    && record.leaseExpiresAt <= Date.now()
  ) {
    await lifecycle.recoverExpiredWorkerLeases();
    record = await lifecycle.getRun(runId);
  }
  return record;
}

const registryShutdowns = new WeakMap<
  ReadonlyMap<string, DurableAiRunExecutor>,
  () => Promise<void>
>();

function createDirectCopilotExecutor(
  dependencies: DurableAiExecutorRegistryDependencies,
): { executor: DurableAiRunExecutor; shutdown(): Promise<void> } {
  const { ownerId } = dependencies;
  const lifecycles = new Map<string, Promise<DirectCopilotExecutorLifecycle>>();
  const lifecycleFor = (run: ClaimedDurableAiRun) => {
    const key = `${run.id}:${run.attempt}`;
    let lifecycle = lifecycles.get(key);
    if (!lifecycle) {
      lifecycle = (async () => {
        const persistence = await createDurableCopilotPersistence(
          ownerId,
          dependencies.durableRuns,
          { runId: run.id, ownerId, attempt: run.attempt },
        );
        await persistence.primeEventCursor(run.id);
        return dependencies.createCopilotLifecycle(persistence, run);
      })();
      lifecycles.set(key, lifecycle);
    }
    return lifecycle;
  };
  const releaseLifecycle = async (
    run: ClaimedDurableAiRun,
    lifecycle: DirectCopilotExecutorLifecycle,
  ) => {
    const key = `${run.id}:${run.attempt}`;
    await lifecycle.shutdownForRestart();
    lifecycles.delete(key);
  };
  const assertNotAborted = (context: DurableAiRunExecutionContext) => {
    context.signal.throwIfAborted();
  };

  const executor: DurableAiRunExecutor = {
    async execute(context) {
      assertClaimOwner(context, ownerId);
      await assertPersistedClaim(dependencies, context.run);
      assertNotAborted(context);
      const copilot = await lifecycleFor(context.run);
      let record = await recoverCopilotRun(copilot, context.run.id);
      assertNotAborted(context);
      if (!record) {
        record = await copilot.createRun(copilotRunInputFromDurableRun(context.run));
      } else if (record.state === 'idle' && record.connection === 'detached') {
        record = await copilot.resumeRun(context.run.id);
      }

      if (record.runId !== context.run.id) {
        throw new Error('Copilot lifecycle returned a mismatched durable run ID.');
      }
      if (record.ownerId !== ownerId) {
        throw new Error(
          `Durable AI run ${context.run.id} lifecycle ownership was not acquired.`,
        );
      }
      if (record.cleanupPending) {
        record = await copilot.retryCleanup(context.run.id);
      } else if (record.state === 'idle' && record.connection === 'attached') {
        assertNotAborted(context);
        record = await copilot.completeRun(context.run.id);
      }
      if (
        record.state !== 'cleaned_up'
        && !(
          ['completed', 'failed', 'timed_out'].includes(record.state)
          && record.cleanupPending
        )
      ) {
        throw new Error(
          `Durable AI run ${context.run.id} is not executable from Copilot state ${record.state}.`,
        );
      }
      if (record.state === 'cleaned_up') {
        await releaseLifecycle(context.run, copilot);
      }

      return {
        provider: COPILOT_PROVIDER,
        model: record.model,
        fallbackState: 'not_used',
      };
    },

    async cancel(context) {
      assertClaimOwner(context, ownerId);
      await assertPersistedClaim(dependencies, context.run);
      const copilot = await lifecycleFor(context.run);
      let record = await copilot.getRun(context.run.id);
      if (!record) {
        await releaseLifecycle(context.run, copilot);
        return;
      }
      if (record.state === 'cleaned_up') {
        await releaseLifecycle(context.run, copilot);
        return;
      }
      if (record.ownerId !== ownerId) {
        throw new Error(
          `Durable AI run ${context.run.id} cancellation ownership was lost.`,
        );
      }
      if (record.state === 'idle' && record.connection === 'detached') {
        record = await copilot.resumeRun(context.run.id);
      }
      if (
        record.state === 'completed'
        || record.state === 'failed'
        || record.state === 'timed_out'
        || record.state === 'cleaned_up'
      ) {
        return;
      }
      record = await copilot.cancelRun(context.run.id);
      if (record.state === 'cleaned_up') {
        await releaseLifecycle(context.run, copilot);
      }
    },

    async cleanup(context: DurableAiRunCleanupContext) {
      if (context.run.leaseOwner !== ownerId) {
        throw new Error(
          `Durable AI run ${context.run.id} cleanup is claimed by a different executor owner.`,
        );
      }
      await assertPersistedClaim(dependencies, context.run);
      const copilot = await lifecycleFor(context.run);
      let record = await copilot.getRun(context.run.id);
      if (!record) {
        await releaseLifecycle(context.run, copilot);
        return;
      }
      if (record.state === 'cleaned_up') {
        await releaseLifecycle(context.run, copilot);
        return;
      }
      if (record.ownerId !== ownerId) {
        throw new Error(
          `Durable AI run ${context.run.id} cleanup ownership was lost.`,
        );
      }
      if (record.cleanupPending) {
        record = await copilot.retryCleanup(context.run.id);
        if (record.state === 'cleaned_up') {
          await releaseLifecycle(context.run, copilot);
        }
        return;
      }
      if (record.state === 'idle' && record.connection === 'detached') {
        record = await copilot.resumeRun(context.run.id);
      }
      if (record.state === 'idle' && record.connection === 'attached') {
        record = await copilot.completeRun(context.run.id);
        if (record.state === 'cleaned_up') {
          await releaseLifecycle(context.run, copilot);
        }
        return;
      }
      throw new Error(
        `Durable AI run ${context.run.id} cannot clean up Copilot state ${record.state}.`,
      );
    },
  };
  return {
    executor,
    async shutdown() {
      const active = await Promise.all(lifecycles.values());
      await Promise.all(active.map((lifecycle) => lifecycle.shutdownForRestart()));
      lifecycles.clear();
    },
  };
}

export function validateDurableAiExecutorRegistry(
  registry: ReadonlyMap<string, DurableAiRunExecutor>,
  configuredRoutes: readonly DurableAiEnqueueableRoute[] =
    DURABLE_AI_ENQUEUEABLE_ROUTES,
): void {
  if (registry.size === 0 || configuredRoutes.length === 0) {
    throw new Error('Durable AI executor registry must not be empty.');
  }
  const configured = new Set(configuredRoutes);
  for (const route of DURABLE_AI_ENQUEUEABLE_ROUTES) {
    if (!configured.has(route)) {
      throw new Error(`Durable AI enqueueable route ${route} is not configured.`);
    }
  }
  for (const route of registry.keys()) {
    if (!configured.has(route as DurableAiEnqueueableRoute)) {
      throw new Error(`Unexpected durable AI executor route ${route}.`);
    }
  }
  for (const route of configured) {
    const executor = registry.get(route);
    if (!executor) {
      throw new Error(`No durable AI executor is registered for ${route}.`);
    }
    const capabilities = REQUIRED_CAPABILITIES[route];
    if (
      (capabilities.execute && typeof executor.execute !== 'function')
      || (capabilities.cancel && typeof executor.cancel !== 'function')
      || (capabilities.cleanup && typeof executor.cleanup !== 'function')
    ) {
      throw new Error(`Durable AI executor ${route} is missing required capabilities.`);
    }
  }
}

export function createDurableAiExecutorRegistry(
  dependencies: DurableAiExecutorRegistryDependencies,
): ReadonlyMap<DurableAiEnqueueableRoute, DurableAiRunExecutor> {
  if (!dependencies.ownerId.trim()) {
    throw new TypeError('Durable AI executor owner ID is required.');
  }
  const copilot = createDirectCopilotExecutor(dependencies);
  const executors = {
    [COPILOT_EXECUTION_ROUTE]: copilot.executor,
  } satisfies Record<DurableAiEnqueueableRoute, DurableAiRunExecutor>;
  const registry = new Map(Object.entries(executors)) as Map<
    DurableAiEnqueueableRoute,
    DurableAiRunExecutor
  >;
  validateDurableAiExecutorRegistry(registry);
  registryShutdowns.set(registry, copilot.shutdown);
  return registry;
}

export async function shutdownDurableAiExecutorRegistry(
  registry: ReadonlyMap<string, DurableAiRunExecutor>,
): Promise<void> {
  await registryShutdowns.get(registry)?.();
}
