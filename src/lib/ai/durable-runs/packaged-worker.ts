import { CopilotClient } from '@github/copilot-sdk';
import type { CopilotClientOptions } from '@github/copilot-sdk';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import {
  createTracedCopilotSessionLifecycleManager,
} from '@/lib/ai/copilot-session-lifecycle';
import type { CopilotLifecycleClient } from '@/lib/ai/copilot-lifecycle-contracts';
import {
  createDurableAiExecutorRegistry,
  DURABLE_AI_ENQUEUEABLE_ROUTES,
  shutdownDurableAiExecutorRegistry,
} from './executor-registry';
import { ProviderSessionProtector } from './provider-session-crypto';
import { notifyDurableAiRunCompletion } from './completion-notifier';
import type { DurableAiRunRepository } from './repository';
import { DurableAiRunWorker } from './worker';

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed)
    ? Math.min(Math.max(parsed, min), max)
    : fallback;
}

export interface PackagedDurableAiRuntime {
  worker: DurableAiRunWorker;
  executorRoutes: readonly string[];
  stop(): Promise<void>;
}

export interface PackagedDurableAiRuntimeDependencies {
  createCopilotClient?: (options: CopilotClientOptions) => CopilotLifecycleClient;
}

const REQUIRED_DURABLE_REPOSITORY_METHODS: readonly (
  keyof DurableAiRunRepository
)[] = [
  'createRun',
  'getRun',
  'getInternalRun',
  'listInternalRunsByRoute',
  'listRuns',
  'getEventsAfter',
  'getEventIdempotencyKeys',
  'appendEvent',
  'appendEventForClaim',
  'appendEventForExecutionOwner',
  'claimNextRun',
  'renewLease',
  'isCancellationRequested',
  'requestCancellation',
  'retryRun',
  'completeRun',
  'cancelRun',
  'timeOutRun',
  'failRun',
  'expireTimedOutQueuedRuns',
  'recoverExpiredRuns',
  'setProviderSession',
  'setProviderSessionForClaim',
  'getProviderSession',
  'getProviderSessionForClaim',
  'revokeProviderSession',
  'revokeProviderSessionForClaim',
  'claimCleanup',
  'renewCleanupLease',
  'finishCleanup',
  'initializeExecutionState',
  'compareAndSetExecutionState',
  'pruneExpired',
];

function assertDurableRepositoryComplete(
  repository: DurableAiRunRepository,
): void {
  const missing = REQUIRED_DURABLE_REPOSITORY_METHODS.filter(
    (method) => typeof repository[method] !== 'function',
  );
  if (missing.length > 0) {
    throw new Error(
      `PostgreSQL durable AI repository is incomplete: ${missing.join(', ')}`,
    );
  }
}

export function createPackagedDurableAiRuntime(
  repository: DurableAiRunRepository,
  logger: Logger,
  isEnabled: () => boolean,
  dependencies: PackagedDurableAiRuntimeDependencies = {},
): PackagedDurableAiRuntime {
  assertDurableRepositoryComplete(repository);
  // Validate required encryption configuration before any worker starts.
  ProviderSessionProtector.fromEnvironment();
  const ownerId = `packaged-ai:${process.pid}:${randomUUID()}`;
  const cleanupTimeoutMs = boundedInteger(
    process.env.MC_COPILOT_CLEANUP_TIMEOUT_MS,
    30_000,
    1_000,
    300_000,
  );
  const requestTimeoutMs = boundedInteger(
    process.env.MC_COPILOT_REQUEST_TIMEOUT_MS,
    120_000,
    1_000,
    900_000,
  );
  const idleTimeoutMs = boundedInteger(
    process.env.MC_COPILOT_IDLE_TIMEOUT_MS,
    60_000,
    1_000,
    900_000,
  );
  const sessionOperationTimeoutMs = boundedInteger(
    process.env.MC_COPILOT_SESSION_OPERATION_TIMEOUT_MS,
    30_000,
    1_000,
    300_000,
  );
  const minimumLeaseMs = Math.max(
    requestTimeoutMs,
    idleTimeoutMs,
    sessionOperationTimeoutMs,
    cleanupTimeoutMs * 3,
  ) + 1;
  const leaseDurationMs = boundedInteger(
    process.env.MC_COPILOT_LEASE_MS,
    Math.max(180_000, minimumLeaseMs),
    minimumLeaseMs,
    3_600_000,
  );
  const executors = createDurableAiExecutorRegistry({
    ownerId,
    durableRuns: repository,
    createCopilotLifecycle: (persistence) =>
      createTracedCopilotSessionLifecycleManager(
        dependencies.createCopilotClient
          ?? ((options) => new CopilotClient(options) as CopilotLifecycleClient),
        persistence.store,
        {
          maxConcurrentSessions: boundedInteger(
            process.env.MC_COPILOT_MAX_CONCURRENT_SESSIONS,
            1,
            1,
            16,
          ),
          requestTimeoutMs,
          idleTimeoutMs,
          cleanupTimeoutMs,
          sessionOperationTimeoutMs,
          leaseDurationMs,
          workerId: ownerId,
          eventSink: persistence.eventSink,
          eventCursor: persistence.eventCursor,
          reportError: (error, operation) => {
            logger.error(
              { err: error, operation },
              'Durable AI Copilot lifecycle operation failed',
            );
          },
        },
      ),
  });
  const worker = new DurableAiRunWorker(repository, executors, {
    ownerId,
    isEnabled,
    onTerminal: (run) => notifyDurableAiRunCompletion(run, repository),
    reportError: (error, operation, runId) => {
      logger.error(
        { err: error, operation, runId },
        'Durable AI worker operation failed',
      );
    },
  });
  let stopPromise: Promise<void> | null = null;
  return {
    worker,
    executorRoutes: DURABLE_AI_ENQUEUEABLE_ROUTES,
    stop() {
      stopPromise ??= (async () => {
        await worker.stop();
        await shutdownDurableAiExecutorRegistry(executors);
      })();
      return stopPromise;
    },
  };
}
