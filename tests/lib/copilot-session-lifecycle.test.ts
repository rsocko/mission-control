import type {
  CopilotClientOptions,
  SessionConfig,
  SessionEvent,
  ToolHandler,
  ToolInvocation,
  ToolResultObject,
} from '@github/copilot-sdk';
import {
  InMemorySpanExporter,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it, vi } from 'vitest';
import {
  HOUSTON_TASK_SUMMARY_TOOL,
  ReadOnlyHoustonToolPolicy,
} from '@/lib/ai/copilot-houston-tools';
import {
  CopilotTraceContextCarrier,
  type HoustonRunEvent,
} from '@/lib/ai/copilot-run-events';
import {
  CopilotLifecycleError,
  CopilotSessionLifecycleManager,
  InMemoryCopilotRunStore,
  createTracedCopilotSessionLifecycleManager,
  type CopilotLifecycleClient,
  type CopilotRunRecord,
  type CopilotRunStore,
} from '@/lib/ai/copilot-session-lifecycle';
import { HoustonRunTracer } from '@/lib/ai/copilot-run-tracing';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeSession(sessionId: string) {
  const handlers = new Set<(event: SessionEvent) => void>();
  return {
    sessionId,
    sendAndWait: vi.fn().mockResolvedValue({
      data: { content: `response-${sessionId}` },
    }),
    on: vi.fn((handler: (event: SessionEvent) => void) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    }),
    emit: (event: SessionEvent) => {
      for (const handler of handlers) handler(event);
    },
    abort: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
}

function fakeClient() {
  let nextSession = 1;
  const sessions = new Map<string, ReturnType<typeof fakeSession>>();
  const client: CopilotLifecycleClient & {
    createSession: ReturnType<typeof vi.fn>;
    resumeSession: ReturnType<typeof vi.fn>;
    deleteSession: ReturnType<typeof vi.fn>;
  } = {
    createSession: vi.fn(async (config: SessionConfig) => {
      const session = fakeSession(`sdk-${nextSession++}`);
      if (config.onEvent) session.on(config.onEvent);
      sessions.set(session.sessionId, session);
      return session;
    }),
    resumeSession: vi.fn(
      async (sessionId: string, config: SessionConfig) => {
        const session = fakeSession(sessionId);
        if (config.onEvent) session.on(config.onEvent);
        sessions.set(sessionId, session);
        return session;
      },
    ),
    deleteSession: vi.fn(async (sessionId: string) => {
      sessions.delete(sessionId);
    }),
  };
  return { client, sessions };
}

class DelayedTransitionStore implements CopilotRunStore {
  private readonly store = new InMemoryCopilotRunStore();
  private gate:
    | {
        predicate: (record: CopilotRunRecord) => boolean;
        entered: ReturnType<typeof deferred<void>>;
        release: ReturnType<typeof deferred<void>>;
      }
    | undefined;

  delayNext(predicate: (record: CopilotRunRecord) => boolean) {
    this.gate = {
      predicate,
      entered: deferred<void>(),
      release: deferred<void>(),
    };
    return this.gate;
  }

  get(runId: string) {
    return this.store.get(runId);
  }

  list() {
    return this.store.list();
  }

  create(record: CopilotRunRecord) {
    return this.store.create(record);
  }

  async compareAndSet(expectedRevision: number, record: CopilotRunRecord) {
    const gate = this.gate;
    if (gate?.predicate(record)) {
      this.gate = undefined;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return this.store.compareAndSet(expectedRevision, record);
  }
}

class RejectingCreateStore extends InMemoryCopilotRunStore {
  private rejectNextCreate = true;

  override async create(record: CopilotRunRecord) {
    if (this.rejectNextCreate) {
      this.rejectNextCreate = false;
      throw new Error('store unavailable');
    }
    return super.create(record);
  }
}

const options = {
  maxConcurrentSessions: 2,
  requestTimeoutMs: 100,
  idleTimeoutMs: 10_000,
  cleanupTimeoutMs: 100,
  sessionOperationTimeoutMs: 100,
  leaseDurationMs: 60_000,
  workerId: 'worker-a',
  reportError: vi.fn(),
};

function input(runId: string) {
  return {
    runId,
    featureId: 'houston-chat',
    sensitivity: 'standard' as const,
    correlationId: `correlation-${runId}`,
    model: 'gpt-5-mini',
  };
}

describe('CopilotSessionLifecycleManager', () => {
  it('maps exactly one isolated SDK session to a Mission Control run', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );

    const created = await manager.createRun(input('run-a'));

    expect(created).toMatchObject({
      runId: 'run-a',
      state: 'idle',
      connection: 'attached',
      providerSessionId: 'sdk-1',
    });

    expect(client.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-mini',
        availableTools: [],
        tools: [],
        enableConfigDiscovery: false,
        enableSessionStore: false,
        enableSkills: false,
        remoteSession: 'off',
        sessionLimits: { maxAiCredits: 30 },
      }),
    );
    await expect(manager.createRun(input('run-a'))).rejects.toMatchObject({
      code: 'run_exists',
    });
  });

  it('captures create and resume events emitted before the SDK RPC resolves', async () => {
    const { client, sessions } = fakeClient();
    client.createSession = vi.fn(async (config: SessionConfig) => {
      const session = fakeSession('sdk-early');
      config.onEvent?.({
        id: 'early-start',
        type: 'session.start',
        timestamp: new Date().toISOString(),
        parentId: undefined,
        data: { sessionId: 'sdk-early' },
      });
      sessions.set(session.sessionId, session);
      return session;
    });
    const events: HoustonRunEvent[] = [];
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        eventSink: { emit: (event) => void events.push(event) },
      },
    );

    await manager.createRun(input('run-a'));
    await manager.disconnectRun('run-a');
    client.resumeSession = vi.fn(
      async (sessionId: string, config: SessionConfig) => {
        const session = fakeSession(sessionId);
        config.onEvent?.({
          id: 'early-resume',
          type: 'session.resume',
          timestamp: new Date().toISOString(),
          parentId: undefined,
          data: { sessionId },
        });
        sessions.set(sessionId, session);
        return session;
      },
    );
    await manager.resumeRun('run-a');

    expect(
      events
        .filter((event) => event.source.boundary === 'sdk')
        .map((event) => event.source.eventType),
    ).toEqual(['session.start', 'session.resume']);
    expect(sessions.get('sdk-early')!.on).not.toHaveBeenCalled();
    expect(JSON.stringify(events)).not.toContain('sdk-early');
  });

  it('injects only the exact read-only Houston tool and disables ambient surfaces', async () => {
      const { client } = fakeClient();
      const audit = vi.fn();
      const manager = new CopilotSessionLifecycleManager(
        client,
        new InMemoryCopilotRunStore(),
        {
          ...options,
          toolPolicy: new ReadOnlyHoustonToolPolicy({
            executionTimeoutMs: 100,
            readTaskSummary: vi.fn().mockResolvedValue({
              total: 2,
              open: 1,
              done: 1,
              overdue: 0,
              highPriority: 0,
            }),
            audit,
          }),
        },
      );
      await manager.createRun(input('run-a'));

      const config = client.createSession.mock.calls[0]?.[0] as SessionConfig;
      expect(config).toMatchObject({
        availableTools: [`custom:${HOUSTON_TASK_SUMMARY_TOOL}`],
        excludedTools: [],
        mcpServers: {},
        customAgents: [],
        skillDirectories: [],
        pluginDirectories: [],
        instructionDirectories: [],
        disabledSkills: [],
        customAgentsLocalOnly: true,
        coauthorEnabled: false,
        canvases: [],
        commands: [],
        memory: { enabled: false },
        toolSearch: { enabled: false },
        largeOutput: { enabled: false },
        streaming: false,
        includeSubAgentStreamingEvents: false,
        manageScheduleEnabled: false,
        enableCitations: false,
        enableMcpApps: false,
        enableManagedSettings: false,
        enableOnDemandInstructionDiscovery: false,
        enableFileHooks: false,
        enableHostGitOperations: false,
      });
      expect(config.tools).toEqual([
        expect.objectContaining({ name: HOUSTON_TASK_SUMMARY_TOOL }),
      ]);
      await expect(
        config.onPermissionRequest?.(
          {
            kind: 'custom-tool',
            toolName: HOUSTON_TASK_SUMMARY_TOOL,
            toolCallId: 'call-a',
            toolDescription:
              'Read a bounded Mission Control task summary for the current Houston run.',
            args: { includeOverdueItems: false },
          },
          { sessionId: 'sdk-1' },
        ),
      ).resolves.toEqual({ kind: 'approve-once' });
      const toolResult = (await config.tools?.[0]?.handler?.(
        { includeOverdueItems: false },
        {
          sessionId: 'sdk-1',
          toolCallId: 'call-a',
          toolName: HOUSTON_TASK_SUMMARY_TOOL,
          arguments: { includeOverdueItems: false },
        },
      )) as ToolResultObject;
      expect(toolResult).toMatchObject({ resultType: 'success' });
      expect(JSON.stringify(audit.mock.calls)).not.toContain('sdk-1');
    });

    it('prevents a Houston tool binding from crossing run-owned SDK sessions', async () => {
      const { client } = fakeClient();
      const manager = new CopilotSessionLifecycleManager(
        client,
        new InMemoryCopilotRunStore(),
        {
          ...options,
          toolPolicy: new ReadOnlyHoustonToolPolicy({
            executionTimeoutMs: 100,
            readTaskSummary: vi.fn().mockResolvedValue({
              total: 0,
              open: 0,
              done: 0,
              overdue: 0,
              highPriority: 0,
            }),
            audit: vi.fn(),
          }),
        },
      );
      await manager.createRun(input('run-a'));
      await manager.createRun(input('run-b'));
      const runAConfig = client.createSession.mock.calls[0]?.[0] as SessionConfig;
      const runATool = runAConfig.tools?.[0]?.handler as ToolHandler<unknown>;

      await expect(
        runATool(
          { includeOverdueItems: false },
          {
            sessionId: 'sdk-2',
            toolCallId: 'cross-run-call',
            toolName: HOUSTON_TASK_SUMMARY_TOOL,
            arguments: { includeOverdueItems: false },
          } satisfies ToolInvocation,
        ),
      ).resolves.toMatchObject({ resultType: 'denied', error: 'tool_denied' });
    });

    it('coordinates run cancellation and cleanup with active Houston tool calls', async () => {
      const { client } = fakeClient();
      let executionSignal: AbortSignal | undefined;
      const manager = new CopilotSessionLifecycleManager(
        client,
        new InMemoryCopilotRunStore(),
        {
          ...options,
          toolPolicy: new ReadOnlyHoustonToolPolicy({
            executionTimeoutMs: 100,
            readTaskSummary: vi.fn(async (_input, context) => {
              executionSignal = context.signal;
              return new Promise(() => undefined);
            }),
            audit: vi.fn(),
          }),
        },
      );
      await manager.createRun(input('run-a'));
      const config = client.createSession.mock.calls[0]?.[0] as SessionConfig;
      const runTool = config.tools?.[0]?.handler as ToolHandler<unknown>;
      const executing = runTool(
        { includeOverdueItems: false },
        {
          sessionId: 'sdk-1',
          toolCallId: 'active-call',
          toolName: HOUSTON_TASK_SUMMARY_TOOL,
          arguments: { includeOverdueItems: false },
        },
      );
      await vi.waitFor(() => expect(executionSignal).toBeDefined());

      await manager.cancelRun('run-a');

      await expect(executing).resolves.toMatchObject({
        resultType: 'denied',
        error: 'tool_cancelled',
      });
      expect(executionSignal?.aborted).toBe(true);
      await expect(
        runTool(
          { includeOverdueItems: false },
          {
            sessionId: 'sdk-1',
            toolCallId: 'after-cleanup',
            toolName: HOUSTON_TASK_SUMMARY_TOOL,
            arguments: { includeOverdueItems: false },
          },
        ),
      ).resolves.toMatchObject({ resultType: 'denied' });
  });

  it('denies tool permissions after the owning worker lease expires', async () => {
    let now = 1_000;
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        toolPolicy: new ReadOnlyHoustonToolPolicy({
          executionTimeoutMs: 100,
          readTaskSummary: vi.fn().mockResolvedValue({
            total: 0,
            open: 0,
            done: 0,
            overdue: 0,
            highPriority: 0,
          }),
          audit: vi.fn(),
          now: () => now,
        }),
      },
      () => now,
    );
    await manager.createRun(input('run-a'));
    const config = client.createSession.mock.calls[0]?.[0] as SessionConfig;
    now += options.leaseDurationMs;

    await expect(
      config.onPermissionRequest?.(
        {
          kind: 'custom-tool',
          toolName: HOUSTON_TASK_SUMMARY_TOOL,
          toolCallId: 'expired-lease-call',
          toolDescription:
            'Read a bounded Mission Control task summary for the current Houston run.',
          args: { includeOverdueItems: false },
        },
        { sessionId: 'sdk-1' },
      ),
    ).resolves.toMatchObject({ kind: 'reject' });
    now = 1_000;
    await manager.cancelRun('run-a');
  });

  it('fails closed before session creation for non-standard data', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );

    await expect(
      manager.createRun({ ...input('run-a'), sensitivity: 'restricted' }),
    ).rejects.toMatchObject({ code: 'policy_denied' });
    expect(client.createSession).not.toHaveBeenCalled();
  });

  it('does not retain a concurrency reservation for invalid trace input', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, maxConcurrentSessions: 1 },
    );

    await expect(
      manager.createRun({
        ...input('invalid-run'),
        traceContext: { traceparent: 'invalid' },
      }),
    ).rejects.toThrow('valid W3C traceparent');
    await expect(manager.createRun(input('valid-run'))).resolves.toMatchObject({
      state: 'idle',
    });
  });

  it('keeps responses and provider events scoped to the owning run', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    const runAEvents = vi.fn();
    const runBEvents = vi.fn();
    manager.subscribe('run-a', runAEvents);
    manager.subscribe('run-b', runBEvents);
    await manager.createRun(input('run-a'));
    await manager.createRun(input('run-b'));

    expect(await manager.send('run-a', 'secret-a')).toBe('response-sdk-1');
    sessions.get('sdk-1')?.emit({
      id: 'event-a',
      type: 'session.idle',
      timestamp: new Date().toISOString(),
      parentId: undefined,
      data: {},
    });

    expect(runAEvents).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-a',
        kind: 'run.idle',
        source: expect.objectContaining({
          boundary: 'sdk',
          eventType: 'session.idle',
        }),
      }),
    );
    expect(runBEvents).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'session.idle' }),
    );
    expect(JSON.stringify(runAEvents.mock.calls)).not.toContain('secret-a');
  });

  it('disconnects and resumes the same provider session after runtime restart', async () => {
    const store = new InMemoryCopilotRunStore();
    const first = fakeClient();
    const firstManager = new CopilotSessionLifecycleManager(
      first.client,
      store,
      options,
    );
    await firstManager.createRun(input('run-a'));
    await firstManager.shutdownForRestart();

    const second = fakeClient();
    const secondManager = new CopilotSessionLifecycleManager(
      second.client,
      store,
      options,
    );
    const resumed = await secondManager.resumeRun('run-a');

    expect(resumed).toMatchObject({
      state: 'idle',
      connection: 'attached',
      providerSessionId: 'sdk-1',
    });
    expect(second.client.resumeSession).toHaveBeenCalledWith(
      'sdk-1',
      expect.objectContaining({
        continuePendingWork: false,
        suppressResumeEvent: false,
      }),
    );
  });

  it('resumes its retained session when the concurrency limit is full', async () => {
    const store = new InMemoryCopilotRunStore();
    const first = fakeClient();
    const firstManager = new CopilotSessionLifecycleManager(
      first.client,
      store,
      { ...options, maxConcurrentSessions: 1 },
    );
    await firstManager.createRun(input('run-a'));
    await firstManager.disconnectRun('run-a');

    const second = fakeClient();
    const secondManager = new CopilotSessionLifecycleManager(
      second.client,
      store,
      { ...options, maxConcurrentSessions: 1, workerId: 'worker-b' },
    );
    await expect(secondManager.resumeRun('run-a')).resolves.toMatchObject({
      state: 'idle',
      connection: 'attached',
      providerSessionId: 'sdk-1',
    });
  });

  it('rejects resume attempts for another run or a live session', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));

    await expect(manager.resumeRun('run-b')).rejects.toMatchObject({
      code: 'run_not_found',
    });
    await expect(manager.resumeRun('run-a')).rejects.toMatchObject({
      code: 'run_not_resumable',
    });
  });

  it('aborts cancellation and records an unambiguous cleaned terminal state', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));
    const session = sessions.get('sdk-1')!;

    const cancelled = await manager.cancelRun('run-a');

    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledWith('sdk-1');
    expect(cancelled).toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
      providerSessionId: undefined,
    });
  });

  it('resolves a send/cancel race to cancelled without reviving the run', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));
    const response = deferred<{ data: { content: string } } | undefined>();
    sessions.get('sdk-1')!.sendAndWait.mockReturnValue(response.promise);

    const sending = manager.send('run-a', 'prompt');
    await vi.waitFor(async () =>
      expect((await manager.getRun('run-a'))?.state).toBe('active'),
    );
    await manager.cancelRun('run-a');
    response.resolve({ data: { content: 'late-response' } });

    await expect(sending).rejects.toMatchObject({ code: 'lifecycle_conflict' });
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
    });
  });

  it('aborts, deletes, and marks requests that exceed the bounded timeout', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, requestTimeoutMs: 10 },
    );
    await manager.createRun(input('run-a'));
    const session = sessions.get('sdk-1')!;
    session.sendAndWait.mockReturnValue(new Promise(() => undefined));

    await expect(manager.send('run-a', 'prompt')).rejects.toMatchObject({
      code: 'request_timed_out',
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledWith('sdk-1');
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'timed_out',
    });
  });

  it('rejects saturation without creating an extra SDK session', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, maxConcurrentSessions: 1 },
    );
    await manager.createRun(input('run-a'));

    await expect(manager.createRun(input('run-b'))).rejects.toMatchObject({
      code: 'concurrency_saturated',
    });
    expect(client.createSession).toHaveBeenCalledOnce();
  });

  it('serializes overlapping capacity reservations', async () => {
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValue(creation.promise);
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, maxConcurrentSessions: 1 },
    );

    const first = manager.createRun(input('run-a'));
    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
    await expect(manager.createRun(input('run-b'))).rejects.toMatchObject({
      code: 'concurrency_saturated',
    });
    creation.resolve(fakeSession('sdk-1'));
    await expect(first).resolves.toMatchObject({ runId: 'run-a' });
  });

  it('releases a reservation when the run store rejects creation', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new RejectingCreateStore(),
      { ...options, maxConcurrentSessions: 1 },
    );

    await expect(manager.createRun(input('run-a'))).rejects.toThrow(
      'store unavailable',
    );
    await expect(manager.createRun(input('run-b'))).resolves.toMatchObject({
      runId: 'run-b',
    });
  });

  it('counts detached resumable sessions toward concurrency saturation', async () => {
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, maxConcurrentSessions: 1 },
    );
    await manager.createRun(input('run-a'));
    await manager.disconnectRun('run-a');

    await expect(manager.createRun(input('run-b'))).rejects.toMatchObject({
      code: 'concurrency_saturated',
    });
    expect(client.createSession).toHaveBeenCalledOnce();
  });

  it('reserves a run before asynchronous creation can duplicate ownership', async () => {
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValue(creation.promise);
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );

    const first = manager.createRun(input('run-a'));
    await vi.waitFor(() => expect(client.createSession).toHaveBeenCalledOnce());
    await expect(manager.createRun(input('run-a'))).rejects.toMatchObject({
      code: 'lifecycle_conflict',
    });
    creation.resolve(fakeSession('sdk-1'));
    await expect(first).resolves.toMatchObject({ providerSessionId: 'sdk-1' });
  });

  it('atomically rejects duplicate ownership across manager instances', async () => {
    const store = new InMemoryCopilotRunStore();
    const first = fakeClient();
    const second = fakeClient();
    const exporter = new InMemorySpanExporter();
    const runTracer = new HoustonRunTracer({ exporter });
    const firstManager = new CopilotSessionLifecycleManager(
      first.client,
      store,
      { ...options, runTracer },
    );
    const secondManager = new CopilotSessionLifecycleManager(
      second.client,
      store,
      { ...options, runTracer },
    );

    const results = await Promise.allSettled([
      firstManager.createRun(input('run-a')),
      secondManager.createRun(input('run-a')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(
      first.client.createSession.mock.calls.length +
        second.client.createSession.mock.calls.length,
    ).toBe(1);
    await runTracer.forceFlush();
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'mission-control.copilot.run'),
    ).toHaveLength(0);
    const winner =
      results[0].status === 'fulfilled' ? firstManager : secondManager;
    await winner.completeRun('run-a');
    await runTracer.forceFlush();
    expect(
      exporter
        .getFinishedSpans()
        .filter((span) => span.name === 'mission-control.copilot.run'),
    ).toHaveLength(1);
    await runTracer.shutdown();
  });

  it('bounds session creation and cleans a late SDK session', async () => {
    const reportError = vi.fn();
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValue(creation.promise);
    const events: HoustonRunEvent[] = [];
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        sessionOperationTimeoutMs: 10,
        reportError,
        eventSink: { emit: (event) => void events.push(event) },
      },
    );

    await expect(manager.createRun(input('run-a'))).rejects.toMatchObject({
      code: 'session_start_timed_out',
    });
    const lateSession = fakeSession('late-sdk');
    creation.resolve(lateSession);
    await vi.waitFor(() => expect(lateSession.disconnect).toHaveBeenCalledOnce());
    expect(client.deleteSession).toHaveBeenCalledWith('late-sdk');
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'timed_out',
    });
    const terminalIndex = events.findIndex(
      (event) => event.kind === 'run.terminal',
    );
    const cleanupIndex = events.findIndex(
      (event) => event.kind === 'run.cleanup_started',
    );
    expect(terminalIndex).toBeGreaterThanOrEqual(0);
    expect(cleanupIndex).toBe(terminalIndex + 1);
    expect(events[cleanupIndex].sequence).toBe(
      events[terminalIndex].sequence + 1,
    );
  });

  it('exports late session deletion as a child of the run span', async () => {
    const exporter = new InMemorySpanExporter();
    const runTracer = new HoustonRunTracer({ exporter });
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValue(creation.promise);
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        sessionOperationTimeoutMs: 10,
        runTracer,
      },
    );

    await expect(manager.createRun(input('run-a'))).rejects.toMatchObject({
      code: 'session_start_timed_out',
    });
    creation.resolve(fakeSession('late-sdk'));
    await vi.waitFor(async () =>
      expect(await manager.getRun('run-a')).toMatchObject({
        state: 'cleaned_up',
        terminalState: 'timed_out',
      }),
    );
    await runTracer.forceFlush();

    const spans = exporter.getFinishedSpans();
    const root = spans.find(
      (span) => span.name === 'mission-control.copilot.run',
    );
    const deletion = spans.find(
      (span) => span.name === 'mission-control.copilot.session.delete',
    );
    expect(root).toBeDefined();
    expect(deletion).toBeDefined();
    expect(deletion?.spanContext().traceId).toBe(root?.spanContext().traceId);
    expect(deletion?.parentSpanContext?.spanId).toBe(
      root?.spanContext().spanId,
    );
    await runTracer.shutdown();
  });

  it('counts timed-out session creation until the SDK operation settles', async () => {
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValueOnce(creation.promise);
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        maxConcurrentSessions: 1,
        sessionOperationTimeoutMs: 10,
      },
    );

    await expect(manager.createRun(input('run-a'))).rejects.toMatchObject({
      code: 'session_start_timed_out',
    });
    await expect(manager.createRun(input('run-b'))).rejects.toMatchObject({
      code: 'concurrency_saturated',
    });

    creation.resolve(fakeSession('late-sdk'));
    await vi.waitFor(async () =>
      expect(await manager.getRun('run-a')).toMatchObject({
        state: 'cleaned_up',
      }),
    );
    await expect(manager.createRun(input('run-b'))).resolves.toMatchObject({
      runId: 'run-b',
    });
  });

  it('emits separate terminal and cleanup revisions when resume times out', async () => {
    const { client } = fakeClient();
    const resumed = deferred<ReturnType<typeof fakeSession>>();
    const events: HoustonRunEvent[] = [];
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        sessionOperationTimeoutMs: 10,
        eventSink: { emit: (event) => void events.push(event) },
      },
    );
    await manager.createRun(input('run-a'));
    await manager.disconnectRun('run-a');
    client.resumeSession.mockReturnValueOnce(resumed.promise);

    await expect(manager.resumeRun('run-a')).rejects.toMatchObject({
      code: 'session_start_timed_out',
    });
    const terminalIndex = events.findIndex(
      (event) =>
        event.kind === 'run.terminal' &&
        event.terminalState === 'timed_out',
    );
    expect(events[terminalIndex + 1]).toMatchObject({
      kind: 'run.cleanup_started',
      sequence: events[terminalIndex].sequence + 1,
    });

    resumed.resolve(fakeSession('sdk-1'));
    await vi.waitFor(async () =>
      expect(await manager.getRun('run-a')).toMatchObject({
        state: 'cleaned_up',
        terminalState: 'timed_out',
      }),
    );
  });

  it('retains a late session ID when deletion fails during timeout reconciliation', async () => {
    const store = new DelayedTransitionStore();
    const gate = store.delayNext((record) => record.state === 'timed_out');
    const { client } = fakeClient();
    const creation = deferred<ReturnType<typeof fakeSession>>();
    client.createSession.mockReturnValue(creation.promise);
    client.deleteSession.mockRejectedValue(new Error('secret provider response'));
    const manager = new CopilotSessionLifecycleManager(
      client,
      store,
      { ...options, sessionOperationTimeoutMs: 10 },
    );

    const creating = manager.createRun(input('run-a'));
    await gate.entered.promise;
    creation.resolve(fakeSession('late-sdk'));
    await vi.waitFor(() => expect(client.deleteSession).toHaveBeenCalledWith('late-sdk'));
    gate.release.resolve();

    await expect(creating).rejects.toMatchObject({
      code: 'session_start_timed_out',
    });
    await vi.waitFor(async () =>
      expect(await manager.getRun('run-a')).toMatchObject({
        state: 'timed_out',
        cleanupPending: true,
        providerSessionId: 'late-sdk',
      }),
    );
  });

  it('expires and cleans up abandoned idle clients', async () => {
    vi.useFakeTimers();
    try {
      const { client, sessions } = fakeClient();
      const manager = new CopilotSessionLifecycleManager(
        client,
        new InMemoryCopilotRunStore(),
        { ...options, idleTimeoutMs: 10 },
      );
      await manager.createRun(input('run-a'));

      await vi.advanceTimersByTimeAsync(10);

      expect(sessions.get('sdk-1')).toBeUndefined();
      await expect(manager.getRun('run-a')).resolves.toMatchObject({
        state: 'cleaned_up',
        terminalState: 'timed_out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans successful and failed terminal paths', async () => {
    const successful = fakeClient();
    const successManager = new CopilotSessionLifecycleManager(
      successful.client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await successManager.createRun(input('run-success'));
    await expect(successManager.completeRun('run-success')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'completed',
    });

    const failed = fakeClient();
    const failureManager = new CopilotSessionLifecycleManager(
      failed.client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await failureManager.createRun(input('run-failure'));
    failed.sessions
      .get('sdk-1')!
      .sendAndWait.mockRejectedValue(new Error('provider transport failed'));
    await expect(failureManager.send('run-failure', 'prompt')).rejects.toThrow(
      'provider transport failed',
    );
    await expect(failureManager.getRun('run-failure')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'failed',
    });
  });

  it('surfaces cleanup failure instead of reporting successful cleanup', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));
    sessions.get('sdk-1')!.disconnect.mockRejectedValue(new Error('disconnect failed'));

    await expect(manager.cancelRun('run-a')).rejects.toEqual(
      new CopilotLifecycleError('cleanup_failed'),
    );
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'failed',
      terminalState: 'cancelled',
      cleanupPending: true,
      providerSessionId: 'sdk-1',
    });
  });

  it('reconciles a deletion that succeeds after the cleanup timeout', async () => {
    const { client } = fakeClient();
    const deletion = deferred<void>();
    client.deleteSession.mockReturnValue(deletion.promise);
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, cleanupTimeoutMs: 10 },
    );
    await manager.createRun(input('run-a'));

    await expect(manager.cancelRun('run-a')).rejects.toMatchObject({
      code: 'cleanup_failed',
    });
    deletion.resolve();

    await vi.waitFor(async () =>
      expect(await manager.getRun('run-a')).toMatchObject({
        state: 'cleaned_up',
        cleanupPending: undefined,
        providerSessionId: undefined,
      }),
    );
  });

  it('retries cleanup from the failed stage without repeating completed steps', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));
    const session = sessions.get('sdk-1')!;
    session.disconnect.mockRejectedValueOnce(new Error('disconnect failed'));
    await expect(manager.cancelRun('run-a')).rejects.toMatchObject({
      code: 'cleanup_failed',
    });

    await expect(manager.retryCleanup('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
      cleanupPending: undefined,
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledTimes(2);
    expect(client.deleteSession).toHaveBeenCalledOnce();
  });

  it('reaps detached resumable sessions after their idle deadline', async () => {
    let now = 1_000;
    const { client } = fakeClient();
    const events: HoustonRunEvent[] = [];
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        eventSink: { emit: (event) => void events.push(event) },
      },
      () => now,
    );
    await manager.createRun(input('run-a'));
    await manager.disconnectRun('run-a');
    now += options.idleTimeoutMs;

    await expect(manager.reapExpiredDisconnectedRuns()).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-a',
        state: 'cleaned_up',
        terminalState: 'timed_out',
      }),
    ]);
    expect(client.deleteSession).toHaveBeenCalledWith('sdk-1');
    const terminalIndex = events.findIndex(
      (event) => event.kind === 'run.terminal',
    );
    expect(events[terminalIndex + 1]).toMatchObject({
      kind: 'run.cleanup_started',
      sequence: events[terminalIndex].sequence + 1,
    });
  });

  it('recovers an expired attached lease after an ungraceful restart', async () => {
    let now = 1_000;
    const store = new InMemoryCopilotRunStore();
    const first = fakeClient();
    const firstManager = new CopilotSessionLifecycleManager(
      first.client,
      store,
      { ...options, leaseDurationMs: 20_000 },
      () => now,
    );
    await firstManager.createRun(input('run-a'));
    now += 20_000;

    const second = fakeClient();
    const secondManager = new CopilotSessionLifecycleManager(
      second.client,
      store,
      { ...options, leaseDurationMs: 20_000, workerId: 'worker-b' },
      () => now,
    );
    await expect(secondManager.recoverExpiredWorkerLeases()).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-a',
        connection: 'detached',
        ownerId: 'worker-b',
      }),
    ]);
    await expect(secondManager.resumeRun('run-a')).resolves.toMatchObject({
      state: 'idle',
      connection: 'attached',
      ownerId: 'worker-b',
    });
    await expect(firstManager.send('run-a', 'stale-worker')).rejects.toMatchObject({
      code: 'run_not_active',
    });
  });

  it('preserves a restored terminal cursor and emits recovery cleanup failure', async () => {
    const store = new InMemoryCopilotRunStore();
    await store.create({
      runId: 'run-restored',
      featureId: 'houston-chat',
      sensitivity: 'standard',
      correlationId: 'correlation-restored',
      model: 'gpt-5-mini',
      state: 'completed',
      connection: 'attached',
      terminalState: 'completed',
      providerSessionId: 'sdk-restored',
      traceContext: {
        traceparent:
          '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      },
      ownerId: 'worker-a',
      leaseExpiresAt: 1,
      revision: 4,
      createdAt: 1,
      updatedAt: 1,
    });
    const events: HoustonRunEvent[] = [];
    const { client } = fakeClient();
    client.deleteSession.mockRejectedValueOnce(
      new Error('private provider failure'),
    );
    const manager = new CopilotSessionLifecycleManager(
      client,
      store,
      {
        ...options,
        eventCursor: () => ({
          sequence: 7,
          parentEventId: 'evt_restored_terminal',
          terminalState: 'completed',
          cleanupStarted: false,
          seenIdempotencyKeys: [],
        }),
        eventSink: { emit: (event) => void events.push(event) },
      },
      () => 10,
    );

    await expect(manager.recoverExpiredWorkerLeases()).resolves.toEqual([
      expect.objectContaining({
        runId: 'run-restored',
        state: 'failed',
        terminalState: 'completed',
        cleanupPending: true,
        cleanupFailure: true,
      }),
    ]);
    expect(events.map((event) => event.kind)).toEqual([
      'run.cleanup_started',
      'run.cleanup_failed',
    ]);
    expect(events.some((event) => event.kind === 'run.idle')).toBe(false);
    expect(JSON.stringify(events)).not.toContain('sdk-restored');
    expect(JSON.stringify(events)).not.toContain('private provider failure');
  });

  it('contains observer failures without corrupting lifecycle transitions', async () => {
    const reportError = vi.fn();
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, reportError },
    );
    manager.subscribe('run-a', () => {
      throw new Error('observer failed');
    });

    await expect(manager.createRun(input('run-a'))).resolves.toMatchObject({
      state: 'idle',
    });
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'lifecycle_conflict' }),
      'run-event-listener',
    );
    expect(JSON.stringify(reportError.mock.calls)).not.toContain('observer failed');
  });

  it('keeps provider event metrics subscribed when disconnect fails', async () => {
    const { client, sessions } = fakeClient();
    const listener = vi.fn();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    manager.subscribe('run-a', listener);
    await manager.createRun(input('run-a'));
    sessions.get('sdk-1')!.disconnect.mockRejectedValueOnce(
      new Error('disconnect failed'),
    );

    await expect(manager.disconnectRun('run-a')).rejects.toMatchObject({
      code: 'cleanup_failed',
    });
    sessions.get('sdk-1')!.emit({
      id: 'after-failure',
      type: 'session.idle',
      timestamp: new Date().toISOString(),
      parentId: undefined,
      data: {},
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        source: expect.objectContaining({ eventType: 'session.idle' }),
      }),
    );
  });

  it('lets cancellation win while send is claiming the active state', async () => {
    const store = new DelayedTransitionStore();
    const gate = store.delayNext((record) => record.state === 'active');
    const { client } = fakeClient();
    const events: HoustonRunEvent[] = [];
    const manager = new CopilotSessionLifecycleManager(client, store, {
      ...options,
      eventSink: { emit: (event) => void events.push(event) },
    });
    await manager.createRun(input('run-a'));

    const sending = manager.send('run-a', 'prompt');
    await gate.entered.promise;
    const cancelling = manager.cancelRun('run-a');
    gate.release.resolve();

    await expect(sending).rejects.toMatchObject({ code: 'lifecycle_conflict' });
    await expect(cancelling).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
    });
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      providerSessionId: undefined,
    });
    expect(
      events.filter((event) => event.kind === 'run.terminal'),
    ).toEqual([expect.objectContaining({ terminalState: 'cancelled' })]);
    expect(events.at(-1)?.kind).toBe('run.cleanup_completed');
  });

  it('allows only one terminal operation to clean a session', async () => {
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      options,
    );
    await manager.createRun(input('run-a'));
    const session = sessions.get('sdk-1')!;
    const disconnect = deferred<void>();
    session.disconnect.mockReturnValue(disconnect.promise);

    const cancelling = manager.cancelRun('run-a');
    await vi.waitFor(() =>
      expect(session.disconnect).toHaveBeenCalledOnce(),
    );
    await expect(manager.completeRun('run-a')).rejects.toMatchObject({
      code: 'lifecycle_conflict',
    });
    disconnect.resolve();
    await expect(cancelling).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
    });
    expect(client.deleteSession).toHaveBeenCalledOnce();
  });

  it('joins cancellation cleanup during restart without changing its outcome', async () => {
    const events: HoustonRunEvent[] = [];
    const { client, sessions } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        eventSink: { emit: (event) => void events.push(event) },
      },
    );
    await manager.createRun(input('run-a'));
    const session = sessions.get('sdk-1')!;
    const disconnect = deferred<void>();
    session.disconnect.mockReturnValue(disconnect.promise);

    const cancelling = manager.cancelRun('run-a');
    await vi.waitFor(() =>
      expect(session.disconnect).toHaveBeenCalledOnce(),
    );
    const restarting = manager.shutdownForRestart();
    disconnect.resolve();

    await expect(cancelling).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
    });
    await expect(restarting).resolves.toBeUndefined();
    await expect(manager.getRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'cancelled',
    });
    expect(session.abort).toHaveBeenCalledOnce();
    expect(session.disconnect).toHaveBeenCalledOnce();
    expect(client.deleteSession).toHaveBeenCalledOnce();
    expect(
      events.filter((event) => event.kind === 'run.terminal'),
    ).toEqual([expect.objectContaining({ terminalState: 'cancelled' })]);
  });

  it('exports one correlated content-free run trace with operation and event children', async () => {
    const carrier = new CopilotTraceContextCarrier();
    const observed: unknown[] = [];
    const events: HoustonRunEvent[] = [];
    const exporter = new InMemorySpanExporter();
    const runTracer = new HoustonRunTracer({ exporter });
    const { client, sessions } = fakeClient();
    let sdkClientOptions: CopilotClientOptions | undefined;
    const createSession = client.createSession;
    client.createSession = vi.fn(async (config: SessionConfig) => {
      observed.push(sdkClientOptions?.onGetTraceContext?.());
      return createSession(config);
    });
    const manager = createTracedCopilotSessionLifecycleManager(
      (clientOptions) => {
        sdkClientOptions = clientOptions;
        return client;
      },
      new InMemoryCopilotRunStore(),
      {
        ...options,
        traceContextCarrier: carrier,
        runTracer,
        eventSink: { emit: (event) => void events.push(event) },
      },
    );
    const runTrace = {
      traceparent:
        '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
      tracestate: 'vendor=value',
    };
    await manager.createRun({ ...input('run-a'), traceContext: runTrace });
    sessions.get('sdk-1')!.sendAndWait.mockImplementationOnce(async () => {
      observed.push(sdkClientOptions?.onGetTraceContext?.());
      return { data: { content: 'response' } };
    });

    await manager.send('run-a', 'private prompt');
    await manager.completeRun('run-a');
    await runTracer.forceFlush();

    expect(observed).toHaveLength(2);
    expect(sdkClientOptions?.telemetry?.captureContent).toBe(false);
    expect(
      observed.every(
        (item) =>
          typeof item === 'object' &&
          item !== null &&
          'traceparent' in item &&
          String(item.traceparent).startsWith(
            '00-0123456789abcdef0123456789abcdef-',
          ) &&
          item.traceparent !== runTrace.traceparent,
      ),
    ).toBe(true);
    expect(new Set(events.map((event) => event.trace.traceId))).toEqual(
      new Set(['0123456789abcdef0123456789abcdef']),
    );
    expect(events.map((event) => event.sequence)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(JSON.stringify(events)).not.toContain('private prompt');
    expect(JSON.stringify(events)).not.toContain('sdk-1');

    const spans = exporter.getFinishedSpans();
    const roots = spans.filter(
      (span) => span.name === 'mission-control.copilot.run',
    );
    expect(roots).toHaveLength(1);
    expect(roots[0].parentSpanContext?.spanId).toBe(
      '0123456789abcdef',
    );
    const rootSpanId = roots[0].spanContext().spanId;
    const children = spans.filter((span) => span !== roots[0]);
    expect(children.length).toBeGreaterThan(events.length);
    expect(
      children.every(
        (span) =>
          span.spanContext().traceId === roots[0].spanContext().traceId &&
          span.parentSpanContext?.spanId === rootSpanId,
      ),
    ).toBe(true);
    const eventSpanIds = new Set(
      spans
        .filter(
          (span) => span.name === 'mission-control.copilot.run.event',
        )
        .map((span) => span.spanContext().spanId),
    );
    expect(events.every((event) => eventSpanIds.has(event.trace.spanId))).toBe(
      true,
    );
    expect(JSON.stringify(spans.map((span) => span.attributes))).not.toContain(
      'private prompt',
    );
    await runTracer.shutdown();
  });

  it('does not let OpenTelemetry exporter failures change run execution', async () => {
    const failingExporter: SpanExporter = {
      export(_spans, resultCallback) {
        resultCallback({
          code: 1,
          error: new Error('private collector failure'),
        });
      },
      shutdown: async () => undefined,
    };
    const runTracer = new HoustonRunTracer({ exporter: failingExporter });
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      { ...options, runTracer },
    );

    await expect(manager.createRun(input('run-a'))).resolves.toMatchObject({
      state: 'idle',
    });
    await expect(manager.completeRun('run-a')).resolves.toMatchObject({
      state: 'cleaned_up',
      terminalState: 'completed',
    });
    await runTracer.shutdown();
  });

  it('contains synchronous and asynchronous event sink failures', async () => {
    const reportError = vi.fn();
    let calls = 0;
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        reportError,
        eventSink: {
          emit: () => {
            calls += 1;
            if (calls === 1) throw new Error('private exporter failure');
            return Promise.reject(new Error('private async exporter failure'));
          },
        },
      },
    );

    await expect(manager.createRun(input('run-a'))).resolves.toMatchObject({
      state: 'idle',
    });
    await vi.waitFor(() => expect(reportError).toHaveBeenCalledTimes(2));
    expect(reportError).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'lifecycle_conflict' }),
      'run-event-sink',
    );
    expect(JSON.stringify(reportError.mock.calls)).not.toContain(
      'private exporter failure',
    );
  });

  it('maps canonical Houston audits into the run event sink', async () => {
    const events: HoustonRunEvent[] = [];
    const { client } = fakeClient();
    const manager = new CopilotSessionLifecycleManager(
      client,
      new InMemoryCopilotRunStore(),
      {
        ...options,
        eventSink: { emit: (event) => void events.push(event) },
        toolPolicy: new ReadOnlyHoustonToolPolicy({
          executionTimeoutMs: 100,
          readTaskSummary: vi.fn().mockResolvedValue({
            total: 0,
            open: 0,
            done: 0,
            overdue: 0,
            highPriority: 0,
          }),
          audit: vi.fn(),
        }),
      },
    );
    await manager.createRun(input('run-a'));
    const config = client.createSession.mock.calls[0]?.[0] as SessionConfig;

    await config.onPermissionRequest?.(
      {
        kind: 'custom-tool',
        toolName: HOUSTON_TASK_SUMMARY_TOOL,
        toolCallId: 'call-a',
        toolDescription:
          'Read a bounded Mission Control task summary for the current Houston run.',
        args: { includeOverdueItems: false },
      },
      { sessionId: 'sdk-1' },
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'tool.decision',
        tool: {
          identifier: HOUSTON_TASK_SUMMARY_TOOL,
          permissionDecision: 'allow',
          durationMs: expect.any(Number),
          outcome: 'allowed',
        },
      }),
    );
    expect(JSON.stringify(events)).not.toContain('call-a');
    expect(JSON.stringify(events)).not.toContain('sdk-1');
  });
});
