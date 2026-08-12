import type {
  PermissionRequest,
  ToolHandler,
  ToolInvocation,
  ToolResultObject,
} from '@github/copilot-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  HOUSTON_TASK_SUMMARY_TOOL,
  ReadOnlyHoustonToolPolicy,
  type HoustonTaskSummary,
  type HoustonToolAuditEvent,
} from '@/lib/ai/copilot-houston-tools';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function summary(): HoustonTaskSummary {
  return {
    total: 4,
    open: 2,
    done: 2,
    overdue: 1,
    highPriority: 1,
    overdueItems: [
      {
        id: 'task-1',
        title: 'Review the release',
        status: 'todo',
        priority: 'high',
        dueDate: '2026-08-03',
      },
    ],
  };
}

function invocation(
  overrides: Partial<ToolInvocation> = {},
): ToolInvocation {
  return {
    sessionId: 'sdk-1',
    toolCallId: 'tool-call-1',
    toolName: HOUSTON_TASK_SUMMARY_TOOL,
    arguments: { includeOverdueItems: true },
    ...overrides,
  };
}

function permissionRequest(
  overrides: Record<string, unknown> = {},
): PermissionRequest {
  return {
    kind: 'custom-tool',
    toolName: HOUSTON_TASK_SUMMARY_TOOL,
    toolCallId: 'tool-call-1',
    toolDescription:
      'Read a bounded Mission Control task summary for the current Houston run.',
    args: { includeOverdueItems: true },
    ...overrides,
  } as PermissionRequest;
}

function createBinding(options: {
  readTaskSummary?: () => Promise<unknown>;
  ownsSession?: (sessionId: string) => Promise<boolean>;
  audit?: (event: HoustonToolAuditEvent) => void | Promise<void>;
  executionTimeoutMs?: number;
}) {
  const policy = new ReadOnlyHoustonToolPolicy({
    executionTimeoutMs: options.executionTimeoutMs ?? 100,
    readTaskSummary:
      options.readTaskSummary ?? vi.fn().mockResolvedValue(summary()),
    audit: options.audit ?? vi.fn(),
  });
  return policy.bindRun({
    runId: 'run-1',
    correlationId: 'correlation-1',
    authorizeSession: async (sessionId) =>
      (await (options.ownsSession ??
        (async (candidate: string) => candidate === 'sdk-1'))(sessionId))
        ? { validUntil: Date.now() + 60_000 }
        : undefined,
  });
}

function handler(
  binding: ReturnType<typeof createBinding>,
): ToolHandler<unknown> {
  const toolHandler = binding.tools[0]?.handler;
  if (!toolHandler) throw new Error('Expected the Houston tool handler.');
  return toolHandler as ToolHandler<unknown>;
}

describe('ReadOnlyHoustonToolPolicy', () => {
  it('exposes one exact custom tool and executes a bounded read-only summary', async () => {
    const readTaskSummary = vi.fn().mockResolvedValue(summary());
    const audit = vi.fn();
    const binding = createBinding({ readTaskSummary, audit });

    expect(binding.availableTools).toEqual([
      `custom:${HOUSTON_TASK_SUMMARY_TOOL}`,
    ]);
    expect(binding.tools).toEqual([
      expect.objectContaining({
        name: HOUSTON_TASK_SUMMARY_TOOL,
        defer: 'never',
        skipPermission: false,
      }),
    ]);
    await expect(
      binding.onPermissionRequest(permissionRequest(), { sessionId: 'sdk-1' }),
    ).resolves.toEqual({ kind: 'approve-once' });

    const toolResult = (await handler(binding)(
      { includeOverdueItems: true },
      invocation(),
    )) as ToolResultObject;

    expect(toolResult.resultType).toBe('success');
    expect(JSON.parse(toolResult.textResultForLlm)).toEqual(summary());
    expect(readTaskSummary).toHaveBeenCalledWith(
      { includeOverdueItems: true },
      expect.objectContaining({
        runId: 'run-1',
        correlationId: 'correlation-1',
        signal: expect.any(AbortSignal),
      }),
    );
    expect(audit).toHaveBeenCalledWith({
      runId: 'run-1',
      correlationId: 'correlation-1',
      toolIdentifier: HOUSTON_TASK_SUMMARY_TOOL,
      permissionDecision: 'allow',
      durationMs: expect.any(Number),
      outcome: 'allowed',
    });
  });

  it.each([
    ['shell', { kind: 'shell' }],
    ['filesystem read', { kind: 'read' }],
    ['filesystem write', { kind: 'write' }],
    ['web', { kind: 'url' }],
    [
      'MCP indirection',
      {
        kind: 'mcp',
        serverName: 'mission-control',
        toolName: HOUSTON_TASK_SUMMARY_TOOL,
      },
    ],
    ['memory', { kind: 'memory' }],
    ['hook', { kind: 'hook', toolName: HOUSTON_TASK_SUMMARY_TOOL }],
    ['extension management', { kind: 'extension-management' }],
    ['extension access', { kind: 'extension-permission-access' }],
    [
      'unknown custom tool',
      permissionRequest({ toolName: 'mission_control_update_task' }),
    ],
    [
      'case alias',
      permissionRequest({ toolName: HOUSTON_TASK_SUMMARY_TOOL.toUpperCase() }),
    ],
    ['malformed custom tool', permissionRequest({ args: { extra: true } })],
  ])('denies %s permission requests', async (_name, request) => {
    const audit = vi.fn();
    const binding = createBinding({ audit });

    await expect(
      binding.onPermissionRequest(request as PermissionRequest, {
        sessionId: 'sdk-1',
      }),
    ).resolves.toMatchObject({ kind: 'reject' });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        toolIdentifier: 'unrecognized_tool',
        permissionDecision: 'deny',
        outcome: 'denied',
      }),
    );
  });

  it('handles repeated permission requests without granting session-wide access', async () => {
    const audit = vi.fn();
    const binding = createBinding({ audit });

    await expect(
      binding.onPermissionRequest(permissionRequest(), { sessionId: 'sdk-1' }),
    ).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      binding.onPermissionRequest(permissionRequest(), { sessionId: 'sdk-1' }),
    ).resolves.toEqual({ kind: 'approve-once' });
    await expect(
      binding.onPermissionRequest(
        permissionRequest({ args: { includeOverdueItems: false } }),
        { sessionId: 'sdk-1' },
      ),
    ).resolves.toMatchObject({ kind: 'reject' });

    expect(audit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        permissionDecision: 'deny',
        outcome: 'invalid_input',
      }),
    );
  });

  it('serializes concurrent permission retries with changed arguments', async () => {
    const pendingAudit = deferred<void>();
    const audit = vi
      .fn()
      .mockImplementationOnce(() => pendingAudit.promise)
      .mockResolvedValue(undefined);
    const binding = createBinding({ audit });

    const first = binding.onPermissionRequest(permissionRequest(), {
      sessionId: 'sdk-1',
    });
    const changedRetry = binding.onPermissionRequest(
      permissionRequest({ args: { includeOverdueItems: false } }),
      { sessionId: 'sdk-1' },
    );
    pendingAudit.resolve();

    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    await expect(changedRetry).resolves.toMatchObject({ kind: 'reject' });
  });

  it('fails closed when cancellation races session ownership checks', async () => {
    const permissionOwnership = deferred<boolean>();
    const permissionBinding = createBinding({
      ownsSession: vi.fn(() => permissionOwnership.promise),
    });
    const permission = permissionBinding.onPermissionRequest(permissionRequest(), {
      sessionId: 'sdk-1',
    });
    permissionBinding.cancel();
    permissionOwnership.resolve(true);
    await expect(permission).resolves.toMatchObject({ kind: 'reject' });

    const executionOwnership = deferred<boolean>();
    const readTaskSummary = vi.fn().mockResolvedValue(summary());
    const executionBinding = createBinding({
      ownsSession: vi.fn(() => executionOwnership.promise),
      readTaskSummary,
    });
    const execution = handler(executionBinding)(
      { includeOverdueItems: true },
      invocation(),
    );
    executionBinding.cancel();
    executionOwnership.resolve(true);
    await expect(execution).resolves.toMatchObject({
      resultType: 'denied',
      error: 'tool_cancelled',
    });
    expect(readTaskSummary).not.toHaveBeenCalled();
  });

  it('fails closed when cancellation races final authorization', async () => {
    const permissionFinalAuthorization = deferred<
      { validUntil: number } | undefined
    >();
    const authorizePermission = vi
      .fn()
      .mockResolvedValueOnce({ validUntil: Date.now() + 60_000 })
      .mockImplementationOnce(() => permissionFinalAuthorization.promise);
    const permissionBinding = new ReadOnlyHoustonToolPolicy({
      executionTimeoutMs: 100,
      readTaskSummary: vi.fn().mockResolvedValue(summary()),
      audit: vi.fn(),
    }).bindRun({
      runId: 'run-1',
      correlationId: 'correlation-1',
      authorizeSession: authorizePermission,
    });
    const permission = permissionBinding.onPermissionRequest(permissionRequest(), {
      sessionId: 'sdk-1',
    });
    await vi.waitFor(() => expect(authorizePermission).toHaveBeenCalledTimes(2));
    permissionBinding.cancel();
    permissionFinalAuthorization.resolve({ validUntil: Date.now() + 60_000 });
    await expect(permission).resolves.toMatchObject({ kind: 'reject' });

    const executionFinalAuthorization = deferred<
      { validUntil: number } | undefined
    >();
    const authorizeExecution = vi
      .fn()
      .mockResolvedValueOnce({ validUntil: Date.now() + 60_000 })
      .mockResolvedValueOnce({ validUntil: Date.now() + 60_000 })
      .mockImplementationOnce(() => executionFinalAuthorization.promise);
    const executionBinding = new ReadOnlyHoustonToolPolicy({
      executionTimeoutMs: 100,
      readTaskSummary: vi.fn().mockResolvedValue(summary()),
      audit: vi.fn(),
    }).bindRun({
      runId: 'run-1',
      correlationId: 'correlation-1',
      authorizeSession: authorizeExecution,
    });
    const execution = handler(executionBinding)(
      { includeOverdueItems: true },
      invocation(),
    );
    await vi.waitFor(() => expect(authorizeExecution).toHaveBeenCalledTimes(3));
    executionBinding.cancel();
    executionFinalAuthorization.resolve({ validUntil: Date.now() + 60_000 });

    await expect(execution).resolves.toMatchObject({
      resultType: 'denied',
      error: 'tool_cancelled',
    });
  });

  it('denies malformed, aliased, and cross-run tool invocations', async () => {
    const readTaskSummary = vi.fn().mockResolvedValue(summary());
    const binding = createBinding({ readTaskSummary });
    const execute = handler(binding);

    await expect(
      execute({ extra: true }, invocation()),
    ).resolves.toMatchObject({ resultType: 'rejected', error: 'invalid_tool_input' });
    await expect(
      execute(
        { includeOverdueItems: true },
        invocation({ toolName: HOUSTON_TASK_SUMMARY_TOOL.toUpperCase() }),
      ),
    ).resolves.toMatchObject({ resultType: 'rejected', error: 'invalid_tool_input' });
    await expect(
      execute(
        { includeOverdueItems: true },
        invocation({ sessionId: 'sdk-other', toolCallId: 'tool-call-2' }),
      ),
    ).resolves.toMatchObject({ resultType: 'denied', error: 'tool_denied' });
    expect(readTaskSummary).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent and repeated SDK tool retries', async () => {
    const pending = deferred<unknown>();
    const readTaskSummary = vi.fn(() => pending.promise);
    const audit = vi.fn();
    const binding = createBinding({ readTaskSummary, audit });
    const execute = handler(binding);

    const first = execute({ includeOverdueItems: true }, invocation());
    const duplicate = execute({ includeOverdueItems: true }, invocation());
    await vi.waitFor(() => expect(readTaskSummary).toHaveBeenCalledOnce());
    pending.resolve(summary());

    await expect(first).resolves.toMatchObject({ resultType: 'success' });
    await expect(duplicate).resolves.toMatchObject({ resultType: 'success' });
    await expect(
      execute({ includeOverdueItems: true }, invocation()),
    ).resolves.toMatchObject({ resultType: 'success' });
    await expect(
      execute({ includeOverdueItems: false }, invocation()),
    ).resolves.toMatchObject({
      resultType: 'rejected',
      error: 'invalid_tool_retry',
    });
    expect(readTaskSummary).toHaveBeenCalledOnce();
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'duplicate' }),
    );
  });

  it('maps a duplicate wait timeout to a safe audited timeout result', async () => {
    vi.useFakeTimers();
    try {
      const delayedOriginalTimeoutAudit = deferred<void>();
      let timeoutAudits = 0;
      const audit = vi.fn((event: HoustonToolAuditEvent) => {
        if (event.outcome === 'timed_out' && timeoutAudits++ === 0) {
          return delayedOriginalTimeoutAudit.promise;
        }
      });
      const binding = new ReadOnlyHoustonToolPolicy({
        executionTimeoutMs: 10,
        readTaskSummary: vi.fn(() => new Promise(() => undefined)),
        audit,
      }).bindRun({
        runId: 'run-1',
        correlationId: 'correlation-1',
        authorizeSession: vi
          .fn()
          .mockResolvedValue({ validUntil: Date.now() + 60_000 }),
      });
      const execute = handler(binding);
      const first = execute({ includeOverdueItems: false }, invocation());
      const duplicate = execute({ includeOverdueItems: false }, invocation());

      await vi.advanceTimersByTimeAsync(10);

      await expect(duplicate).resolves.toMatchObject({
        resultType: 'timeout',
        error: 'tool_timed_out',
      });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          permissionDecision: 'allow',
          outcome: 'timed_out',
        }),
      );
      delayedOriginalTimeoutAudit.resolve();
      await expect(first).resolves.toMatchObject({
        resultType: 'timeout',
        error: 'tool_timed_out',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds execution time and aborts the read operation', async () => {
    vi.useFakeTimers();
    try {
      let executionSignal: AbortSignal | undefined;
      const binding = new ReadOnlyHoustonToolPolicy({
        executionTimeoutMs: 10,
        readTaskSummary: vi.fn(async (_input, context) => {
          executionSignal = context.signal;
          return new Promise(() => undefined);
        }),
        audit: vi.fn(),
      }).bindRun({
        runId: 'run-1',
        correlationId: 'correlation-1',
        authorizeSession: vi
          .fn()
          .mockResolvedValue({ validUntil: Date.now() + 60_000 }),
      });

      const executing = handler(binding)(
        { includeOverdueItems: false },
        invocation(),
      );
      await vi.advanceTimersByTimeAsync(10);

      await expect(executing).resolves.toMatchObject({
        resultType: 'timeout',
        error: 'tool_timed_out',
      });
      expect(executionSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled audit callback', async () => {
    vi.useFakeTimers();
    try {
      const binding = createBinding({
        executionTimeoutMs: 10,
        readTaskSummary: vi.fn().mockResolvedValue({
          total: 1,
          open: 1,
          done: 0,
          overdue: 0,
          highPriority: 0,
        }),
        audit: vi.fn(() => new Promise<void>(() => undefined)),
      });

      const executing = handler(binding)(
        { includeOverdueItems: false },
        invocation(),
      );
      await vi.advanceTimersByTimeAsync(10);

      await expect(executing).resolves.toMatchObject({
        resultType: 'failure',
        error: 'tool_audit_failed',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels active calls and rejects calls after cleanup', async () => {
    let executionSignal: AbortSignal | undefined;
    const binding = new ReadOnlyHoustonToolPolicy({
      executionTimeoutMs: 100,
      readTaskSummary: vi.fn(async (_input, context) => {
        executionSignal = context.signal;
        return new Promise(() => undefined);
      }),
      audit: vi.fn(),
    }).bindRun({
      runId: 'run-1',
      correlationId: 'correlation-1',
      authorizeSession: vi
        .fn()
        .mockResolvedValue({ validUntil: Date.now() + 60_000 }),
    });

    const executing = handler(binding)(
      { includeOverdueItems: false },
      invocation(),
    );
    await vi.waitFor(() => expect(executionSignal).toBeDefined());
    binding.cancel();

    await expect(executing).resolves.toMatchObject({
      resultType: 'denied',
      error: 'tool_cancelled',
    });
    expect(executionSignal?.aborted).toBe(true);
    binding.dispose();
    await expect(
      handler(binding)(
        { includeOverdueItems: false },
        invocation({ toolCallId: 'tool-call-2' }),
      ),
    ).resolves.toMatchObject({ resultType: 'denied' });
  });

  it('fails safely for invalid output and redacts content from audit metadata', async () => {
    const audit = vi.fn();
    const binding = createBinding({
      readTaskSummary: vi.fn().mockResolvedValue({
        ...summary(),
        secret: 'credential-value',
      }),
      audit,
    });

    await expect(
      handler(binding)(
        { includeOverdueItems: false, privateArgument: 'prompt-content' },
        invocation(),
      ),
    ).resolves.toMatchObject({
      resultType: 'rejected',
      error: 'invalid_tool_input',
    });
    await expect(
      handler(binding)(
        { includeOverdueItems: false },
        invocation({ toolCallId: 'tool-call-2' }),
      ),
    ).resolves.toMatchObject({
      resultType: 'failure',
      error: 'invalid_tool_output',
    });

    const auditJson = JSON.stringify(audit.mock.calls);
    expect(auditJson).not.toContain('prompt-content');
    expect(auditJson).not.toContain('credential-value');
    expect(auditJson).not.toContain('sdk-1');
    expect(Object.keys(audit.mock.calls.at(-1)?.[0] ?? {})).toEqual([
      'runId',
      'correlationId',
      'toolIdentifier',
      'permissionDecision',
      'durationMs',
      'outcome',
    ]);
  });
});
