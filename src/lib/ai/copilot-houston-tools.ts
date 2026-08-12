import {
  defineTool,
  ToolSet,
  type PermissionHandler,
  type PermissionRequestResult,
  type Tool,
  type ToolInvocation,
  type ToolResultObject,
} from '@github/copilot-sdk';
import { z } from 'zod';

export const HOUSTON_TASK_SUMMARY_TOOL = 'mission_control_get_task_summary';

const TOOL_DESCRIPTION =
  'Read a bounded Mission Control task summary for the current Houston run.';
const MAX_TASK_COUNT = 1_000_000;
const MAX_TOOL_OUTPUT_BYTES = 16_384;
const MAX_TOOL_CALL_ID_LENGTH = 128;

const taskSummaryInputSchema = z
  .object({
    includeOverdueItems: z.boolean().optional().default(false),
  })
  .strict();

const taskSummaryOutputSchema = z
  .object({
    total: z.number().int().min(0).max(MAX_TASK_COUNT),
    open: z.number().int().min(0).max(MAX_TASK_COUNT),
    done: z.number().int().min(0).max(MAX_TASK_COUNT),
    overdue: z.number().int().min(0).max(MAX_TASK_COUNT),
    highPriority: z.number().int().min(0).max(MAX_TASK_COUNT),
    overdueItems: z
      .array(
        z
          .object({
            id: z.string().min(1).max(128),
            title: z.string().min(1).max(240),
            status: z.enum(['todo', 'in_progress']),
            priority: z.enum(['critical', 'high', 'medium', 'low', 'none']),
            dueDate: z.string().max(32).nullable(),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.open + value.done > value.total ||
      value.overdue > value.open ||
      value.highPriority > value.open ||
      (value.overdueItems?.length ?? 0) > value.overdue
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Task summary counts are inconsistent.',
      });
    }
  });

export type HoustonTaskSummaryInput = z.infer<typeof taskSummaryInputSchema>;
export type HoustonTaskSummary = z.infer<typeof taskSummaryOutputSchema>;

export type HoustonToolPermissionDecision = 'allow' | 'deny';
export type HoustonToolAuditOutcome =
  | 'allowed'
  | 'denied'
  | 'duplicate'
  | 'invalid_input'
  | 'invalid_output'
  | 'timed_out'
  | 'cancelled'
  | 'failed';

export interface HoustonToolAuditEvent {
  runId: string;
  correlationId: string;
  toolIdentifier: string;
  permissionDecision: HoustonToolPermissionDecision;
  durationMs: number;
  outcome: HoustonToolAuditOutcome;
}

export interface HoustonToolRunContext {
  runId: string;
  correlationId: string;
  authorizeSession(
    sessionId: string,
  ): Promise<{ validUntil: number } | undefined>;
  onAudit?(event: HoustonToolAuditEvent): void;
}

export interface HoustonToolRunBinding {
  tools: Tool<HoustonTaskSummaryInput>[];
  availableTools: string[];
  onPermissionRequest: PermissionHandler;
  cancel(): void;
  dispose(): void;
}

export interface HoustonToolPolicy {
  readonly executionTimeoutMs: number;
  bindRun(context: HoustonToolRunContext): HoustonToolRunBinding;
}

export interface ReadOnlyHoustonToolPolicyOptions {
  executionTimeoutMs: number;
  readTaskSummary(
    input: HoustonTaskSummaryInput,
    context: {
      runId: string;
      correlationId: string;
      signal: AbortSignal;
    },
  ): Promise<unknown>;
  audit(event: HoustonToolAuditEvent): void | Promise<void>;
  now?: () => number;
}

class ToolExecutionInterrupted extends Error {
  constructor(readonly reason: 'timed_out' | 'cancelled') {
    super(reason);
  }
}

function result(
  resultType: ToolResultObject['resultType'],
  message: string,
  error?: string,
): ToolResultObject {
  return {
    textResultForLlm: message,
    resultType,
    ...(error ? { error } : {}),
  };
}

function isBoundedIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TOOL_CALL_ID_LENGTH
  );
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ReadOnlyHoustonToolRunBinding implements HoustonToolRunBinding {
  readonly tools: Tool<HoustonTaskSummaryInput>[];
  readonly availableTools = new ToolSet()
    .addCustom(HOUSTON_TASK_SUMMARY_TOOL)
    .toArray();
  readonly onPermissionRequest: PermissionHandler;

  private readonly runController = new AbortController();
  private readonly permissionRequests = new Map<
    string,
    {
      inputKey: string;
      initialDecision: Promise<boolean>;
      resolveInitialDecision(value: boolean): void;
    }
  >();
  private readonly executions = new Map<
    string,
    { inputKey: string; result: Promise<ToolResultObject> }
  >();
  private disposed = false;

  constructor(
    private readonly context: HoustonToolRunContext,
    private readonly options: Required<
      Pick<ReadOnlyHoustonToolPolicyOptions, 'executionTimeoutMs' | 'now'>
    > &
      Omit<ReadOnlyHoustonToolPolicyOptions, 'executionTimeoutMs' | 'now'>,
  ) {
    this.tools = [
      defineTool(HOUSTON_TASK_SUMMARY_TOOL, {
        description: TOOL_DESCRIPTION,
        parameters: taskSummaryInputSchema,
        defer: 'never',
        skipPermission: false,
        handler: (args, invocation) => this.execute(args, invocation),
      }),
    ];
    this.onPermissionRequest = (request, invocation) =>
      this.decidePermission(request, invocation.sessionId);
  }

  cancel(): void {
    if (!this.runController.signal.aborted) {
      this.runController.abort();
    }
  }

  dispose(): void {
    this.cancel();
    this.disposed = true;
    this.permissionRequests.clear();
    this.executions.clear();
  }

  private async decidePermission(
    request: unknown,
    sessionId: string,
  ): Promise<PermissionRequestResult> {
    const startedAt = this.options.now();
    const hardDeadline = startedAt + this.options.executionTimeoutMs;
    const parsed = z
      .object({
        kind: z.literal('custom-tool'),
        toolName: z.literal(HOUSTON_TASK_SUMMARY_TOOL),
        toolCallId: z.string().min(1).max(MAX_TOOL_CALL_ID_LENGTH),
        toolDescription: z.literal(TOOL_DESCRIPTION),
        args: taskSummaryInputSchema,
      })
      .strict()
      .safeParse(request);

    if (
      this.disposed ||
      this.runController.signal.aborted ||
      !isBoundedIdentifier(sessionId) ||
      !parsed.success
    ) {
      try {
        await this.audit(
          startedAt,
          'deny',
          'denied',
          'unrecognized_tool',
          hardDeadline,
        );
      } catch {
        return {
          kind: 'reject',
          feedback: 'This Houston runtime could not record the denied request.',
        };
      }
      return {
        kind: 'reject',
        feedback: 'This Houston runtime denies the requested capability.',
      };
    }

    const inputKey = this.inputKey(parsed.data.args);
    let existing = this.permissionRequests.get(parsed.data.toolCallId);
    if (existing?.inputKey !== undefined && existing.inputKey !== inputKey) {
      return this.rejectPermission(
        startedAt,
        'invalid_input',
        'A repeated Houston permission request changed its arguments.',
        hardDeadline,
      );
    }

    const duplicate = existing !== undefined;
    if (!existing) {
      const initialDecision = deferred<boolean>();
      existing = {
        inputKey,
        initialDecision: initialDecision.promise,
        resolveInitialDecision: initialDecision.resolve,
      };
      this.permissionRequests.set(parsed.data.toolCallId, existing);
    }
    const entry = existing;

    const authorization = await this.authorizeSession(sessionId, hardDeadline);
    if (
      !authorization ||
      this.disposed ||
      this.runController.signal.aborted
    ) {
      if (!duplicate) {
        entry.resolveInitialDecision(false);
        if (this.permissionRequests.get(parsed.data.toolCallId) === entry) {
          this.permissionRequests.delete(parsed.data.toolCallId);
        }
      }
      return this.rejectPermission(
        startedAt,
        'denied',
        'This Houston runtime denies the requested capability.',
        hardDeadline,
      );
    }
    const pipelineDeadline = Math.min(
      hardDeadline,
      authorization.validUntil,
    );

    if (!duplicate) {
      try {
        await this.audit(
          startedAt,
          'allow',
          'allowed',
          HOUSTON_TASK_SUMMARY_TOOL,
          pipelineDeadline,
        );
      } catch {
        entry.resolveInitialDecision(false);
        if (this.permissionRequests.get(parsed.data.toolCallId) === entry) {
          this.permissionRequests.delete(parsed.data.toolCallId);
        }
        return {
          kind: 'reject',
          feedback: 'This Houston runtime could not record the permission decision.',
        };
      }
    } else if (
      !(await this.withPolicyTimeout(
        entry.initialDecision,
        this.remainingMs(pipelineDeadline),
      ))
    ) {
      return {
        kind: 'reject',
        feedback: 'The original Houston permission request was denied.',
      };
    }

    if (duplicate) {
      try {
        await this.audit(
          startedAt,
          'allow',
          'duplicate',
          HOUSTON_TASK_SUMMARY_TOOL,
          pipelineDeadline,
        );
      } catch {
        return {
          kind: 'reject',
          feedback: 'This Houston runtime could not record the permission retry.',
        };
      }
    }
    if (
      !(await this.authorizeSession(sessionId, pipelineDeadline)) ||
      this.disposed ||
      this.runController.signal.aborted ||
      this.options.now() >= pipelineDeadline
    ) {
      if (!duplicate) {
        entry.resolveInitialDecision(false);
        if (this.permissionRequests.get(parsed.data.toolCallId) === entry) {
          this.permissionRequests.delete(parsed.data.toolCallId);
        }
      }
      return this.rejectPermission(
        startedAt,
        'denied',
        'This Houston runtime no longer owns the permission request.',
        pipelineDeadline,
      );
    }
    if (!duplicate) entry.resolveInitialDecision(true);
    return { kind: 'approve-once' };
  }

  private async execute(
    args: unknown,
    invocation: ToolInvocation,
  ): Promise<ToolResultObject> {
    const startedAt = this.options.now();
    const hardDeadline = startedAt + this.options.executionTimeoutMs;
    const parsedArgs = taskSummaryInputSchema.safeParse(args);
    const invocationIsValid =
      invocation.toolName === HOUSTON_TASK_SUMMARY_TOOL &&
      isBoundedIdentifier(invocation.toolCallId) &&
      isBoundedIdentifier(invocation.sessionId);
    const authorization =
      parsedArgs.success &&
      invocationIsValid &&
      !this.disposed &&
      !this.runController.signal.aborted
        ? await this.authorizeSession(invocation.sessionId, hardDeadline)
        : undefined;

    if (!parsedArgs.success || !invocationIsValid) {
      return this.auditedResult(
        startedAt,
        'deny',
        'invalid_input',
        result('rejected', 'The tool request was invalid.', 'invalid_tool_input'),
        hardDeadline,
      );
    }
    if (this.disposed || this.runController.signal.aborted) {
      return this.auditedResult(
        startedAt,
        'deny',
        'cancelled',
        result('denied', 'The tool execution was cancelled.', 'tool_cancelled'),
        hardDeadline,
      );
    }
    if (!authorization) {
      return this.auditedResult(
        startedAt,
        'deny',
        'denied',
        result('denied', 'The tool request is not owned by this run.', 'tool_denied'),
        hardDeadline,
      );
    }
    const pipelineDeadline = Math.min(
      hardDeadline,
      authorization.validUntil,
    );
    const inputKey = this.inputKey(parsedArgs.data);
    const existing = this.executions.get(invocation.toolCallId);
    if (existing) {
      if (existing.inputKey !== inputKey) {
        return this.auditedResult(
          startedAt,
          'deny',
          'invalid_input',
          result(
            'rejected',
            'A repeated tool request changed its arguments.',
            'invalid_tool_retry',
          ),
          pipelineDeadline,
        );
      }
      const duplicateAudit = await this.auditedResult(
        startedAt,
        'allow',
        'duplicate',
        result('success', 'The duplicate tool request reused its original result.'),
        pipelineDeadline,
      );
      if (duplicateAudit.resultType !== 'success') return duplicateAudit;
      let duplicateResult: ToolResultObject;
      try {
        duplicateResult = await this.withPolicyTimeout(
          existing.result,
          this.remainingMs(pipelineDeadline),
        );
      } catch (error) {
        if (error instanceof ToolExecutionInterrupted) {
          return this.auditedResult(
            startedAt,
            'allow',
            error.reason,
            result(
              error.reason === 'timed_out' ? 'timeout' : 'denied',
              error.reason === 'timed_out'
                ? 'The duplicate tool execution timed out.'
                : 'The duplicate tool execution was cancelled.',
              error.reason === 'timed_out'
                ? 'tool_timed_out'
                : 'tool_cancelled',
            ),
            pipelineDeadline,
          );
        }
        return this.auditedResult(
          startedAt,
          'allow',
          'failed',
          result(
            'failure',
            'The duplicate tool execution failed.',
            'tool_execution_failed',
          ),
          pipelineDeadline,
        );
      }
      if (
        duplicateResult.resultType === 'success' &&
        (!(await this.authorizeSession(
          invocation.sessionId,
          pipelineDeadline,
        )) ||
          this.disposed ||
          this.runController.signal.aborted ||
          this.options.now() >= pipelineDeadline)
      ) {
        return this.auditedResult(
          startedAt,
          'deny',
          'cancelled',
          result(
            'denied',
            'The duplicate tool execution is no longer authorized.',
            'tool_cancelled',
          ),
          pipelineDeadline,
        );
      }
      return duplicateResult;
    }

    const execution = this.executeOnce(
      parsedArgs.data,
      invocation.sessionId,
      pipelineDeadline,
      startedAt,
    );
    this.executions.set(invocation.toolCallId, {
      inputKey,
      result: execution,
    });
    return execution;
  }

  private async executeOnce(
    input: HoustonTaskSummaryInput,
    sessionId: string,
    authorizationDeadline: number,
    startedAt: number,
  ): Promise<ToolResultObject> {
    const remainingLeaseMs = authorizationDeadline - this.options.now();
    if (remainingLeaseMs <= 0) {
      return this.auditedResult(
        startedAt,
        'deny',
        'denied',
        result('denied', 'The tool ownership lease expired.', 'tool_denied'),
        authorizationDeadline,
      );
    }
    if (this.disposed || this.runController.signal.aborted) {
      return this.auditedResult(
        startedAt,
        'allow',
        'cancelled',
        result('denied', 'The tool execution was cancelled.', 'tool_cancelled'),
        authorizationDeadline,
      );
    }
    const callController = new AbortController();
    let timedOut = false;
    const interrupted = new Promise<never>((_, reject) => {
      callController.signal.addEventListener(
        'abort',
        () =>
          reject(
            new ToolExecutionInterrupted(timedOut ? 'timed_out' : 'cancelled'),
          ),
        { once: true },
      );
    });
    const onRunAbort = () => callController.abort();
    this.runController.signal.addEventListener('abort', onRunAbort, { once: true });
    if (this.runController.signal.aborted) onRunAbort();
    const timer = setTimeout(() => {
      timedOut = true;
      callController.abort();
    }, Math.min(this.options.executionTimeoutMs, Math.max(1, remainingLeaseMs)));

    try {
      const rawOutput = await Promise.race([
        this.options.readTaskSummary(input, {
          runId: this.context.runId,
          correlationId: this.context.correlationId,
          signal: callController.signal,
        }),
        interrupted,
      ]);
      if (
        this.disposed ||
        this.runController.signal.aborted ||
        callController.signal.aborted ||
        !(await this.authorizeSession(sessionId, authorizationDeadline)) ||
        this.options.now() >= authorizationDeadline
      ) {
        throw new ToolExecutionInterrupted('cancelled');
      }
      const parsedOutput = taskSummaryOutputSchema.safeParse(rawOutput);
      if (
        !parsedOutput.success ||
        (!input.includeOverdueItems &&
          parsedOutput.data.overdueItems !== undefined)
      ) {
        return this.auditedResult(
          startedAt,
          'allow',
          'invalid_output',
          result(
            'failure',
            'Mission Control returned an invalid tool result.',
            'invalid_tool_output',
          ),
          authorizationDeadline,
        );
      }
      const encoded = JSON.stringify(parsedOutput.data);
      if (Buffer.byteLength(encoded, 'utf8') > MAX_TOOL_OUTPUT_BYTES) {
        return this.auditedResult(
          startedAt,
          'allow',
          'invalid_output',
          result(
            'failure',
            'Mission Control returned an oversized tool result.',
            'invalid_tool_output',
          ),
          authorizationDeadline,
        );
      }
      const successful = await this.auditedResult(
        startedAt,
        'allow',
        'allowed',
        result('success', encoded),
        authorizationDeadline,
      );
      if (
        successful.resultType === 'success' &&
        (!(await this.authorizeSession(sessionId, authorizationDeadline)) ||
          this.disposed ||
          this.runController.signal.aborted ||
          callController.signal.aborted ||
          this.options.now() >= authorizationDeadline)
      ) {
        throw new ToolExecutionInterrupted('cancelled');
      }
      return successful;
    } catch (error) {
      if (error instanceof ToolExecutionInterrupted) {
        return this.auditedResult(
          startedAt,
          'allow',
          error.reason,
          result(
            error.reason === 'timed_out' ? 'timeout' : 'denied',
            error.reason === 'timed_out'
              ? 'The tool execution timed out.'
              : 'The tool execution was cancelled.',
            error.reason === 'timed_out' ? 'tool_timed_out' : 'tool_cancelled',
          ),
          authorizationDeadline,
        );
      }
      return this.auditedResult(
        startedAt,
        'allow',
        'failed',
        result('failure', 'The tool execution failed.', 'tool_execution_failed'),
        authorizationDeadline,
      );
    } finally {
      clearTimeout(timer);
      this.runController.signal.removeEventListener('abort', onRunAbort);
    }
  }

  private async auditedResult(
    startedAt: number,
    permissionDecision: HoustonToolPermissionDecision,
    outcome: HoustonToolAuditOutcome,
    toolResult: ToolResultObject,
    deadline?: number,
  ): Promise<ToolResultObject> {
    try {
      await this.audit(
        startedAt,
        permissionDecision,
        outcome,
        HOUSTON_TASK_SUMMARY_TOOL,
        deadline,
      );
      return toolResult;
    } catch (error) {
      if (
        error instanceof ToolExecutionInterrupted &&
        toolResult.resultType !== 'success'
      ) {
        return toolResult;
      }
      return result(
        'failure',
        'The tool audit record could not be written.',
        'tool_audit_failed',
      );
    }
  }

  private async audit(
    startedAt: number,
    permissionDecision: HoustonToolPermissionDecision,
    outcome: HoustonToolAuditOutcome,
    toolIdentifier: string,
    deadline?: number,
  ): Promise<void> {
    const event: HoustonToolAuditEvent = {
      runId: this.context.runId,
      correlationId: this.context.correlationId,
      toolIdentifier,
      permissionDecision,
      durationMs: Math.max(0, this.options.now() - startedAt),
      outcome,
    };
    await this.withPolicyTimeout(
      Promise.resolve(this.options.audit(event)),
      deadline === undefined
        ? this.options.executionTimeoutMs
        : this.remainingMs(deadline),
    );
    this.context.onAudit?.(event);
  }

  private inputKey(input: HoustonTaskSummaryInput): string {
    return input.includeOverdueItems ? 'include-overdue' : 'summary-only';
  }

  private async authorizeSession(
    sessionId: string,
    deadline?: number,
  ): Promise<{ validUntil: number } | undefined> {
    try {
      const authorization = await this.withPolicyTimeout(
        this.context.authorizeSession(sessionId),
        deadline === undefined
          ? this.options.executionTimeoutMs
          : this.remainingMs(deadline),
      );
      return authorization && authorization.validUntil > this.options.now()
        ? authorization
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async rejectPermission(
    startedAt: number,
    outcome: HoustonToolAuditOutcome,
    feedback: string,
    deadline: number,
  ): Promise<PermissionRequestResult> {
    try {
      await this.audit(
        startedAt,
        'deny',
        outcome,
        HOUSTON_TASK_SUMMARY_TOOL,
        deadline,
      );
      return { kind: 'reject', feedback };
    } catch {
      return {
        kind: 'reject',
        feedback: 'This Houston runtime could not record the denied request.',
      };
    }
  }

  private remainingMs(deadline: number): number {
    return Math.max(0, deadline - this.options.now());
  }

  private async withPolicyTimeout<T>(
    operation: Promise<T>,
    timeoutMs = this.options.executionTimeoutMs,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new ToolExecutionInterrupted('timed_out')),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export class ReadOnlyHoustonToolPolicy implements HoustonToolPolicy {
  readonly executionTimeoutMs: number;
  private readonly options: Required<
    Pick<ReadOnlyHoustonToolPolicyOptions, 'executionTimeoutMs' | 'now'>
  > &
    Omit<ReadOnlyHoustonToolPolicyOptions, 'executionTimeoutMs' | 'now'>;

  constructor(options: ReadOnlyHoustonToolPolicyOptions) {
    if (
      !Number.isInteger(options.executionTimeoutMs) ||
      options.executionTimeoutMs < 1
    ) {
      throw new TypeError('Houston tool execution timeout must be a positive integer.');
    }
    this.options = {
      ...options,
      now: options.now ?? Date.now,
    };
    this.executionTimeoutMs = options.executionTimeoutMs;
  }

  bindRun(context: HoustonToolRunContext): HoustonToolRunBinding {
    if (!context.runId.trim() || !context.correlationId.trim()) {
      throw new TypeError('Houston tool bindings require run and correlation IDs.');
    }
    return new ReadOnlyHoustonToolRunBinding(context, this.options);
  }
}
