import { describe, expect, it, vi } from 'vitest';
import {
  CopilotLifecycleError,
  InMemoryCopilotRunStore,
  type CopilotRunRecord,
} from '@/lib/ai/copilot-lifecycle-contracts';
import {
  CopilotLeaseManager,
  type CopilotLifecycleClock,
} from '@/lib/ai/copilot-lease-manager';
import { CopilotLifecycleTelemetryBridge } from '@/lib/ai/copilot-lifecycle-telemetry';
import { CopilotRunReaper } from '@/lib/ai/copilot-run-reaper';
import { CopilotRunStateMachine } from '@/lib/ai/copilot-run-state-machine';

const TRACE_CONTEXT = {
  traceparent:
    '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
};

function run(
  overrides: Partial<CopilotRunRecord> = {},
): CopilotRunRecord {
  return {
    runId: 'run-1',
    featureId: 'houston-chat',
    sensitivity: 'standard',
    correlationId: 'correlation-1',
    model: 'gpt-5-mini',
    state: 'creating',
    connection: 'attached',
    traceContext: TRACE_CONTEXT,
    ownerId: 'worker-1',
    leaseExpiresAt: 2_000,
    revision: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe('CopilotRunStateMachine', () => {
  it('commits deterministic CAS transitions without telemetry infrastructure', async () => {
    const store = new InMemoryCopilotRunStore();
    const transitions: CopilotRunRecord[] = [];
    const machine = new CopilotRunStateMachine(
      store,
      'worker-2',
      5_000,
      () => 1_500,
      (record) => transitions.push(record),
    );
    const initial = run();

    await machine.create(initial);
    const idle = await machine.transition(initial, 'idle', {
      providerSessionId: 'session-1',
    });

    expect(idle).toMatchObject({
      state: 'idle',
      ownerId: 'worker-2',
      leaseExpiresAt: 6_500,
      revision: 1,
      updatedAt: 1_500,
      providerSessionId: 'session-1',
    });
    expect(await store.get(initial.runId)).toEqual(idle);
    expect(transitions).toEqual([idle]);
  });

  it('rejects stale revisions without emitting a transition', async () => {
    const store = new InMemoryCopilotRunStore();
    const listener = vi.fn();
    const machine = new CopilotRunStateMachine(
      store,
      'worker-1',
      5_000,
      () => 1_500,
      listener,
    );
    const initial = run();
    await machine.create(initial);
    await machine.transition(initial, 'idle');

    await expect(machine.transition(initial, 'failed')).rejects.toMatchObject({
      code: 'lifecycle_conflict',
    });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('CopilotLeaseManager', () => {
  it('serializes reservations and releases capacity deterministically', async () => {
    const store = new InMemoryCopilotRunStore();
    const leases = new CopilotLeaseManager(store, 1, 100, {
      now: () => 1_000,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });

    await leases.reserve('run-1');
    await expect(leases.reserve('run-2')).rejects.toEqual(
      new CopilotLifecycleError('concurrency_saturated'),
    );
    leases.release('run-1');
    await expect(leases.reserve('run-2')).resolves.toBeUndefined();
  });

  it('selects idle and lease expirations from an injected clock', async () => {
    const store = new InMemoryCopilotRunStore();
    await store.create(
      run({
        state: 'idle',
        connection: 'detached',
        providerSessionId: 'session-1',
        leaseExpiresAt: 900,
        updatedAt: 800,
      }),
    );
    await store.create(
      run({
        runId: 'run-2',
        state: 'active',
        leaseExpiresAt: 999,
        updatedAt: 990,
      }),
    );
    await store.create(
      run({
        runId: 'run-3',
        state: 'resuming',
        connection: 'detached',
        providerSessionId: 'session-3',
        leaseExpiresAt: 999,
        updatedAt: 990,
      }),
    );
    await store.create(
      run({
        runId: 'run-4',
        state: 'resuming',
        connection: 'detached',
        providerSessionId: 'session-4',
        leaseExpiresAt: 1_001,
        updatedAt: 990,
      }),
    );
    await store.create(
      run({
        runId: 'run-5',
        state: 'completed',
        connection: 'detached',
        terminalState: 'completed',
        providerSessionId: 'session-5',
        leaseExpiresAt: 999,
        updatedAt: 990,
      }),
    );
    await store.create(
      run({
        runId: 'run-6',
        state: 'failed',
        connection: 'detached',
        terminalState: 'failed',
        cleanupPending: true,
        providerSessionId: 'session-6',
        leaseExpiresAt: 999,
        updatedAt: 990,
      }),
    );
    const clock: CopilotLifecycleClock = {
      now: () => 1_000,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    };
    const leases = new CopilotLeaseManager(store, 3, 100, clock);

    expect(
      (await leases.expiredDisconnectedRuns()).map(({ runId }) => runId),
    ).toEqual(['run-1']);
    expect(
      (await leases.expiredAttachedLeases()).map(({ runId }) => runId),
    ).toEqual(['run-2', 'run-3']);
  });

  it('owns idle timer replacement and cancellation', () => {
    const callbacks = new Map<number, () => void>();
    const cleared: number[] = [];
    let nextHandle = 0;
    const leases = new CopilotLeaseManager(
      new InMemoryCopilotRunStore(),
      1,
      100,
      {
        now: () => 1_000,
        setTimeout: (callback) => {
          const handle = ++nextHandle;
          callbacks.set(handle, callback);
          return handle;
        },
        clearTimeout: (handle) => cleared.push(handle as number),
      },
    );
    const expired = vi.fn();

    leases.scheduleIdleExpiration('run-1', expired);
    leases.scheduleIdleExpiration('run-1', expired);
    callbacks.get(2)?.();

    expect(cleared).toEqual([1]);
    expect(expired).toHaveBeenCalledOnce();
  });
});

describe('CopilotRunReaper', () => {
  it('reaps detached sessions without telemetry dependencies', async () => {
    const store = new InMemoryCopilotRunStore();
    const initial = run({
      state: 'idle',
      connection: 'detached',
      providerSessionId: 'session-1',
      updatedAt: 800,
    });
    await store.create(initial);
    const machine = new CopilotRunStateMachine(
      store,
      'worker-2',
      5_000,
      () => 1_000,
    );
    const leases = new CopilotLeaseManager(store, 1, 100, {
      now: () => 1_000,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    const deleteSession = vi.fn(async () => undefined);
    const reaper = new CopilotRunReaper(machine, leases, { deleteSession });

    const [reaped] = await reaper.reapExpiredDisconnectedRuns();

    expect(deleteSession).toHaveBeenCalledWith('run-1', 'session-1');
    expect(reaped).toMatchObject({
      state: 'cleaned_up',
      terminalState: 'timed_out',
      providerSessionId: undefined,
      cleanupPending: undefined,
    });
  });

  it('records cleanup failure without reporting a successful reap', async () => {
    const store = new InMemoryCopilotRunStore();
    await store.create(
      run({
        state: 'idle',
        connection: 'detached',
        providerSessionId: 'session-1',
        updatedAt: 800,
      }),
    );
    const machine = new CopilotRunStateMachine(
      store,
      'worker-2',
      5_000,
      () => 1_000,
    );
    const leases = new CopilotLeaseManager(store, 1, 100, {
      now: () => 1_000,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
    });
    const reportError = vi.fn();
    const reaper = new CopilotRunReaper(machine, leases, {
      deleteSession: async () => {
        throw new Error('delete failed');
      },
      reportError,
    });

    await expect(reaper.reapExpiredDisconnectedRuns()).resolves.toEqual([]);
    expect(await store.get('run-1')).toMatchObject({
      state: 'failed',
      terminalState: 'timed_out',
      cleanupPending: true,
      cleanupFailure: true,
      providerSessionId: 'session-1',
    });
    expect(reportError).toHaveBeenCalledWith(
      'detached-session-reaper',
      expect.objectContaining({ code: 'cleanup_failed' }),
    );
  });
});

describe('CopilotLifecycleTelemetryBridge', () => {
  it('contains sink and reporter failures without mutating lifecycle state', () => {
    const record = run();
    const before = structuredClone(record);
    const bridge = new CopilotLifecycleTelemetryBridge({
      eventSink: {
        emit: () => {
          throw new Error('sink unavailable');
        },
      },
      reportError: () => {
        throw new Error('reporter unavailable');
      },
    });

    expect(() => bridge.emitLifecycle(record)).not.toThrow();
    expect(record).toEqual(before);
  });

  it('contains asynchronous sink failures', async () => {
    const reportError = vi.fn();
    const bridge = new CopilotLifecycleTelemetryBridge({
      eventSink: {
        emit: async () => {
          throw new Error('sink unavailable');
        },
      },
      reportError,
    });

    bridge.emitLifecycle(run());
    await Promise.resolve();

    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'lifecycle_conflict' }),
      'run-event-sink',
    );
  });
});
