import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionConfig, SessionEvent } from '@github/copilot-sdk';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
} from '@/lib/ai/copilot-run-events';
import {
  createDurableAiExecutorRegistry,
  shutdownDurableAiExecutorRegistry,
  validateDurableAiExecutorRegistry,
  type DirectCopilotExecutorLifecycle,
  type DurableAiExecutorRegistryDependencies,
} from '@/lib/ai/durable-runs/executor-registry';
import type { DurableAiRunRepository } from '@/lib/ai/durable-runs/repository';
import {
  CopilotSessionLifecycleManager,
  type CopilotLifecycleClient,
} from '@/lib/ai/copilot-session-lifecycle';
import type {
  DurableAiRunCleanupContext,
  DurableAiRunExecutionContext,
} from '@/lib/ai/durable-runs/worker';
import type {
  ClaimedDurableAiRun,
  DurableAiRunRouteOutcome,
} from '@/lib/ai/durable-runs/types';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-durable-executors-'));
process.env.MC_DB_PATH = join(testDirectory, 'runs.db');
process.env.MC_AI_PROVIDER_SESSION_KEY = Buffer.alloc(32, 11).toString('base64');

let database: typeof import('@/db');
let durableRuns: DurableAiRunRepository;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeAll(async () => {
  database = await import('@/db');
  const { SqliteDurableAiRunRepository, SqliteDurableAiRunStore } =
    await import('@/lib/ai/durable-runs/sqlite-adapter');
  durableRuns = new SqliteDurableAiRunRepository(new SqliteDurableAiRunStore());
});

beforeEach(async () => {
  database.sqlite.prepare('DELETE FROM ai_run_events').run();
  database.sqlite.prepare('DELETE FROM ai_provider_sessions').run();
  database.sqlite.prepare('DELETE FROM ai_runs').run();
  await durableRuns.createRun({
    id: 'run-a',
    idempotencyKey: 'registry:run-a',
    featureId: 'houston-chat',
    sensitivity: 'standard',
    executionRoute: COPILOT_EXECUTION_ROUTE,
    requestedProvider: COPILOT_PROVIDER,
    requestedModel: 'gpt-5-mini',
    correlationId: 'correlation-a',
    traceparent:
      '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
  });
  await durableRuns.claimNextRun('worker-a', [COPILOT_EXECUTION_ROUTE], 60_000);
});

afterAll(() => {
  database.sqlite.close();
  rmSync(testDirectory, { recursive: true, force: true });
});

function claimed(owner = 'worker-a'): ClaimedDurableAiRun {
  return {
    id: 'run-a',
    featureId: 'houston-chat',
    sensitivity: 'standard',
    status: 'running',
    executionRoute: COPILOT_EXECUTION_ROUTE,
    requestedProvider: COPILOT_PROVIDER,
    requestedModel: 'gpt-5-mini',
    provider: null,
    model: null,
    fallbackState: 'not_requested',
    correlationId: 'correlation-a',
    attempt: 1,
    maxAttempts: 3,
    availableAt: '2026-09-02T12:00:00.000Z',
    timeoutAt: '2026-09-02T13:00:00.000Z',
    cancelRequestedAt: null,
    startedAt: '2026-09-02T12:00:00.000Z',
    completedAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    notifyOnCompletion: false,
    cleanupStatus: 'none',
    revision: 1,
    createdAt: '2026-09-02T12:00:00.000Z',
    updatedAt: '2026-09-02T12:00:00.000Z',
    expiresAt: '2026-10-02T12:00:00.000Z',
    leaseOwner: owner,
    leaseExpiresAt: '2026-09-02T12:02:00.000Z',
    traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    tracestate: null,
  };
}

function lifecycleRecord(overrides: Record<string, unknown> = {}) {
  return {
    runId: 'run-a',
    featureId: 'houston-chat',
    sensitivity: 'standard' as const,
    correlationId: 'correlation-a',
    model: 'gpt-5-mini',
    state: 'idle' as const,
    connection: 'attached' as const,
    providerSessionId: 'provider-session-a',
    traceContext: {
      traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
    },
    ownerId: 'worker-a',
    leaseExpiresAt: Date.parse('2026-09-02T12:02:00.000Z'),
    revision: 1,
    createdAt: Date.parse('2026-09-02T12:00:00.000Z'),
    updatedAt: Date.parse('2026-09-02T12:00:00.000Z'),
    ...overrides,
  };
}

function lifecycle(initial = lifecycleRecord()): DirectCopilotExecutorLifecycle {
  let current = initial;
  return {
    getRun: vi.fn(async () => current),
    createRun: vi.fn(async () => {
      current = lifecycleRecord();
      return current;
    }),
    resumeRun: vi.fn(async () => {
      current = lifecycleRecord();
      return current;
    }),
    completeRun: vi.fn(async () => {
      current = lifecycleRecord({
        state: 'cleaned_up',
        connection: 'detached',
        terminalState: 'completed',
        providerSessionId: undefined,
      });
      return current;
    }),
    cancelRun: vi.fn(async () => {
      current = lifecycleRecord({
        state: 'cleaned_up',
        connection: 'detached',
        terminalState: 'cancelled',
        providerSessionId: undefined,
      });
      return current;
    }),
    retryCleanup: vi.fn(async () => {
      current = lifecycleRecord({
        state: 'cleaned_up',
        connection: 'detached',
        terminalState: 'failed',
        providerSessionId: undefined,
      });
      return current;
    }),
    recoverExpiredWorkerLeases: vi.fn(async () => []),
    shutdownForRestart: vi.fn(async () => undefined),
  };
}

function dependencies(
  manager: DirectCopilotExecutorLifecycle,
): DurableAiExecutorRegistryDependencies {
  return {
    ownerId: 'worker-a',
    durableRuns,
    createCopilotLifecycle: () => manager,
  };
}

function realLifecycleClient() {
  let sessionCount = 0;
  const client: CopilotLifecycleClient & {
    createSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  } = {
    createSession: vi.fn(async (config: SessionConfig) => {
      const sessionId = `sdk-${++sessionCount}`;
      const handlers = new Set<(event: SessionEvent) => void>();
      const session = {
        sessionId,
        sendAndWait: vi.fn(),
        on: vi.fn((handler: (event: SessionEvent) => void) => {
          handlers.add(handler);
          return () => handlers.delete(handler);
        }),
        abort: vi.fn(async () => undefined),
        disconnect: vi.fn(async () => undefined),
      };
      if (config.onEvent) session.on(config.onEvent);
      return session;
    }),
    resumeSession: vi.fn(),
    deleteSession: vi.fn(async () => undefined),
  };
  return client;
}

function executionContext(
  run = claimed(),
): DurableAiRunExecutionContext {
  return {
    run,
    signal: new AbortController().signal,
    routingHeaders: {},
    emit: vi.fn(async () => undefined),
    setRouteOutcome: vi.fn<(outcome: DurableAiRunRouteOutcome) => void>(),
    getProviderSession: vi.fn(async () => null),
    setProviderSession: vi.fn(),
    revokeProviderSession: vi.fn(async () => false),
  };
}

describe('durable AI executor registry', () => {
  it('is exhaustive and rejects empty, missing, extra, or incomplete coverage', () => {
    expect(() => validateDurableAiExecutorRegistry(new Map())).toThrow(/must not be empty/);
    expect(() => validateDurableAiExecutorRegistry(
      new Map([['unexpected', { async execute() {} }]]),
    )).toThrow(/Unexpected/);
    expect(() => validateDurableAiExecutorRegistry(
      new Map([[COPILOT_EXECUTION_ROUTE, { async execute() {} }]]),
    )).toThrow(/missing required capabilities/);
  });

  it('creates and resumes the direct Copilot route without replacing its provider session', async () => {
    const freshLifecycle = lifecycle(undefined);
    vi.mocked(freshLifecycle.getRun).mockResolvedValueOnce(undefined);
    const createCopilotLifecycle = vi.fn(() => freshLifecycle);
    const fresh = createDurableAiExecutorRegistry({
      ownerId: 'worker-a',
      durableRuns,
      createCopilotLifecycle,
    }).get(COPILOT_EXECUTION_ROUTE)!;

    await expect(fresh.execute(executionContext())).resolves.toEqual({
      provider: COPILOT_PROVIDER,
      model: 'gpt-5-mini',
      fallbackState: 'not_used',
    });
    expect(freshLifecycle.createRun).toHaveBeenCalledOnce();
    await fresh.cancel!(executionContext());
    expect(createCopilotLifecycle).toHaveBeenCalledTimes(2);

    const detachedLifecycle = lifecycle(lifecycleRecord({
      connection: 'detached',
    }));
    const detached = createDurableAiExecutorRegistry(dependencies(detachedLifecycle))
      .get(COPILOT_EXECUTION_ROUTE)!;
    await detached.execute(executionContext());
    expect(detachedLifecycle.resumeRun).toHaveBeenCalledWith('run-a');
    expect(detachedLifecycle.createRun).not.toHaveBeenCalled();
  });

  it('fences stale cancellation before touching the Copilot lifecycle', async () => {
    const manager = lifecycle();
    const executor = createDurableAiExecutorRegistry(dependencies(manager))
      .get(COPILOT_EXECUTION_ROUTE)!;

    await expect(executor.cancel!(executionContext(claimed('worker-b')))).rejects.toThrow(
      /different executor owner/,
    );
    expect(manager.cancelRun).not.toHaveBeenCalled();

    await expect(executor.cancel!(executionContext({
      ...claimed(),
      attempt: 0,
    }))).rejects.toThrow(/ownership was lost/);
    expect(manager.cancelRun).not.toHaveBeenCalled();
  });

  it('retires a lifecycle only after overlapping operations release it', async () => {
    const manager = lifecycle();
    const completion = deferred<ReturnType<typeof lifecycleRecord>>();
    vi.mocked(manager.completeRun).mockImplementation(async () => completion.promise);
    const createCopilotLifecycle = vi.fn(() => manager);
    const executor = createDurableAiExecutorRegistry({
      ownerId: 'worker-a',
      durableRuns,
      createCopilotLifecycle,
    }).get(COPILOT_EXECUTION_ROUTE)!;

    const execution = executor.execute(executionContext());
    await vi.waitFor(() => expect(manager.completeRun).toHaveBeenCalledOnce());
    await executor.cancel!(executionContext());

    expect(createCopilotLifecycle).toHaveBeenCalledOnce();
    expect(manager.shutdownForRestart).not.toHaveBeenCalled();

    completion.resolve(lifecycleRecord({
      state: 'cleaned_up',
      connection: 'detached',
      terminalState: 'completed',
      providerSessionId: undefined,
    }));
    await execution;

    expect(manager.shutdownForRestart).toHaveBeenCalledOnce();
    await executor.cancel!(executionContext());
    expect(createCopilotLifecycle).toHaveBeenCalledTimes(2);
  });

  it('surfaces terminal lifecycle shutdown failures for durable retry handling', async () => {
    const manager = lifecycle();
    vi.mocked(manager.shutdownForRestart).mockRejectedValue(
      new Error('lifecycle shutdown failed'),
    );
    const executor = createDurableAiExecutorRegistry(dependencies(manager))
      .get(COPILOT_EXECUTION_ROUTE)!;

    await expect(executor.execute(executionContext())).rejects.toThrow(
      'lifecycle shutdown failed',
    );
  });

  it('uses persisted cleanup state and shuts the lifecycle down for restart', async () => {
    const manager = lifecycle(lifecycleRecord({
      state: 'failed',
      connection: 'detached',
      terminalState: 'failed',
      cleanupPending: true,
    }));
    const registry = createDurableAiExecutorRegistry(dependencies(manager));
    const executor = registry
      .get(COPILOT_EXECUTION_ROUTE)!;
    const context: DurableAiRunCleanupContext = {
      run: claimed(),
      providerSession: {
        provider: COPILOT_PROVIDER,
        reference: 'provider-session-a',
        expiresAt: '2026-09-03T12:00:00.000Z',
      },
      signal: new AbortController().signal,
    };

    await executor.cleanup!(context);
    expect(manager.retryCleanup).toHaveBeenCalledWith('run-a');
    expect(manager.completeRun).not.toHaveBeenCalled();
    await shutdownDurableAiExecutorRegistry(registry);
    expect(manager.shutdownForRestart).toHaveBeenCalledOnce();
  });

  it('keeps the worker authoritative for terminal state and restart-safe cleanup', async () => {
    const { SqliteDurableAiRunRepository, SqliteDurableAiRunStore } =
      await import('@/lib/ai/durable-runs/sqlite-adapter');
    const { DurableAiRunWorker } = await import('@/lib/ai/durable-runs/worker');
    const repository = new SqliteDurableAiRunRepository(
      new SqliteDurableAiRunStore(),
    );
    const client = realLifecycleClient();
    const onTerminal = vi.fn();
    await repository.createRun({
      id: 'run-authority',
      idempotencyKey: 'authority:run',
      featureId: 'houston-chat',
      sensitivity: 'standard',
      executionRoute: COPILOT_EXECUTION_ROUTE,
      requestedProvider: COPILOT_PROVIDER,
      requestedModel: 'gpt-5-mini',
      correlationId: 'authority-correlation',
      traceparent:
        '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      notifyOnCompletion: true,
    });
    const registry = createDurableAiExecutorRegistry({
      ownerId: 'worker-a',
      durableRuns: repository,
      createCopilotLifecycle: (persistence) =>
        new CopilotSessionLifecycleManager(client, persistence.store, {
          maxConcurrentSessions: 1,
          requestTimeoutMs: 1_000,
          idleTimeoutMs: 10_000,
          cleanupTimeoutMs: 1_000,
          sessionOperationTimeoutMs: 1_000,
          leaseDurationMs: 60_000,
          workerId: 'worker-a',
          reportError: vi.fn(),
          eventSink: persistence.eventSink,
          eventCursor: persistence.eventCursor,
        }),
    });
    const reportError = vi.fn();
    const worker = new DurableAiRunWorker(repository, registry, {
      ownerId: 'worker-a',
      leaseMs: 60_000,
      onTerminal,
      reportError,
    });

    expect(await worker.runOnce()).toBe(true);
    expect(reportError).not.toHaveBeenCalled();
    expect(await repository.getRun('run-authority')).toMatchObject({
      status: 'succeeded',
      cleanupStatus: 'pending',
    });
    expect((await repository.getInternalRun('run-authority'))?.leaseOwner).toBeNull();
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(
      (await repository.getEventsAfter('run-authority'))
        .filter((event) => event.kind === 'run.succeeded'),
    ).toHaveLength(1);

    expect(await worker.runOnce()).toBe(true);
    expect(await repository.getRun('run-authority')).toMatchObject({
      status: 'succeeded',
      cleanupStatus: 'completed',
    });
    expect(await repository.getProviderSession('run-authority')).toBeNull();
    expect(await worker.runOnce()).toBe(false);
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledOnce();
    expect(onTerminal).toHaveBeenCalledOnce();
    await shutdownDurableAiExecutorRegistry(registry);
  });
});
