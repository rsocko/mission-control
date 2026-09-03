import type {
  CopilotClientOptions,
  SessionEvent,
} from '@github/copilot-sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes } from 'node:crypto';
import {
  HOUSTON_TASK_SUMMARY_TOOL,
  type HoustonToolAuditEvent,
  type HoustonToolAuditOutcome,
  type HoustonToolPermissionDecision,
} from './copilot-houston-tools';
import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
} from './durable-runs/route-contract';

export const HOUSTON_RUN_EVENT_SCHEMA_VERSION = 1 as const;
export {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
};

export type HoustonRunTerminalState =
  | 'completed'
  | 'cancelled'
  | 'failed'
  | 'timed_out';

export type HoustonRunEventKind =
  | 'run.started'
  | 'run.resuming'
  | 'run.attached'
  | 'run.detached'
  | 'run.active'
  | 'run.idle'
  | 'run.terminal'
  | 'run.cleanup_started'
  | 'run.cleanup_completed'
  | 'run.cleanup_failed'
  | 'output.started'
  | 'output.progress'
  | 'output.completed'
  | 'reasoning.started'
  | 'reasoning.progress'
  | 'reasoning.completed'
  | 'model.started'
  | 'model.completed'
  | 'model.retry'
  | 'model.usage'
  | 'model.failed'
  | 'tool.requested'
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.decision'
  | 'run.cancel_observed'
  | 'provider.error'
  | 'provider.shutdown'
  | 'provider.task_completed'
  | 'model.changed';

export interface W3CTraceContext {
  traceparent: string;
  tracestate?: string;
}

export interface HoustonRunEventUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalNanoAiu?: number;
  durationMs?: number;
  timeToFirstTokenMs?: number;
  interTokenLatencyMs?: number;
  finishReason?: string;
  endpoint?: string;
  contentFilterTriggered?: boolean;
}

export interface HoustonRunEventFailure {
  category?: string;
  code?: string;
  statusCode?: number;
  failureKind?: 'api' | 'transport';
  source?: 'top_level' | 'subagent' | 'mcp_sampling';
  transport?: 'http' | 'websocket';
}

export interface HoustonRunEventTool {
  identifier: typeof HOUSTON_TASK_SUMMARY_TOOL | 'unrecognized_tool';
  callCorrelationId?: string;
  permissionDecision?: HoustonToolPermissionDecision;
  outcome?: HoustonToolAuditOutcome;
  durationMs?: number;
}

export interface HoustonRunEvent {
  schemaVersion: typeof HOUSTON_RUN_EVENT_SCHEMA_VERSION;
  eventId: string;
  idempotencyKey: string;
  runId: string;
  correlationId: string;
  parentEventId?: string;
  sequence: number;
  timestamp: string;
  observedAt: string;
  kind: HoustonRunEventKind;
  executionRoute: typeof COPILOT_EXECUTION_ROUTE;
  featureId: string;
  sensitivity: 'standard';
  provider: {
    name: typeof COPILOT_PROVIDER;
    model?: string;
  };
  source: {
    boundary: 'lifecycle' | 'sdk' | 'tool_audit';
    eventType: string;
    delivery: 'live' | 'replay' | 'late';
    ephemeral?: boolean;
  };
  trace: {
    traceId: string;
    spanId: string;
    parentSpanId: string;
  };
  lifecycleState?: string;
  terminalState?: HoustonRunTerminalState;
  usage?: HoustonRunEventUsage;
  failure?: HoustonRunEventFailure;
  tool?: HoustonRunEventTool;
  progressBytes?: number;
}

export interface HoustonRunEventCursor {
  sequence: number;
  parentEventId?: string;
  terminalState?: HoustonRunTerminalState;
  cleanupStarted?: boolean;
  lastNativeTimestamp?: string;
  seenIdempotencyKeys: string[];
}

export type HoustonRunEventDisposition =
  | { accepted: true; event: HoustonRunEvent }
  | {
      accepted: false;
      reason: 'duplicate' | 'ignored' | 'post_terminal' | 'terminal_conflict';
    };

export interface HoustonRunEventSink {
  emit(event: HoustonRunEvent): void | Promise<void>;
}

export interface HoustonRunEventContext {
  runId: string;
  correlationId: string;
  featureId: string;
  sensitivity: 'standard';
  model: string;
  traceContext: W3CTraceContext;
}

export interface HoustonLifecycleEventSource extends HoustonRunEventContext {
  state: string;
  terminalState?: HoustonRunTerminalState;
  connection: 'attached' | 'detached';
  cleanupPending?: true;
  cleanupFailure?: true;
  revision: number;
  updatedAt: number;
}

interface EventMetadata {
  model?: string;
  usage?: HoustonRunEventUsage;
  failure?: HoustonRunEventFailure;
  tool?: HoustonRunEventTool;
  progressBytes?: number;
}

interface NativeEventRecord {
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  type?: unknown;
  ephemeral?: unknown;
  data?: unknown;
  agentId?: unknown;
}

const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9._:/-]+$/;
const MAX_SAFE_IDENTIFIER_LENGTH = 160;
const SAFE_FAILURE_CATEGORIES = new Set([
  'authentication',
  'authorization',
  'quota',
  'rate_limit',
  'context_limit',
  'query',
]);
const SAFE_FAILURE_CODES = new Set([
  'quota_exceeded',
  'session_quota_exceeded',
  'billing_not_configured',
  'user_weekly_rate_limited',
  'user_global_rate_limited',
  'rate_limited',
  'user_model_rate_limited',
  'integration_rate_limited',
  'model_max_prompt_tokens_exceeded',
]);
const SAFE_FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
]);
const SAFE_API_ENDPOINTS = new Set([
  '/chat/completions',
  '/v1/messages',
  '/responses',
  'ws:/responses',
]);

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableId(prefix: string, value: string, length = 32): string {
  return `${prefix}_${hash(value).slice(0, length)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeIdentifier(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SAFE_IDENTIFIER_LENGTH ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    return undefined;
  }
  return value;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0
    ? value
    : undefined;
}

function finiteStatusCode(value: unknown): number | undefined {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function eventTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function parseTraceparent(traceparent: string): {
  traceId: string;
  spanId: string;
} {
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (
    !match ||
    match[1] === '00000000000000000000000000000000' ||
    match[2] === '0000000000000000'
  ) {
    throw new TypeError('A valid W3C traceparent is required.');
  }
  return { traceId: match[1], spanId: match[2] };
}

export function createW3CTraceContext(): W3CTraceContext {
  return {
    traceparent: `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`,
  };
}

export function validateW3CTraceContext(
  context: W3CTraceContext,
): W3CTraceContext {
  parseTraceparent(context.traceparent);
  if (
    context.tracestate !== undefined &&
    (context.tracestate.length === 0 ||
      context.tracestate.length > 512 ||
      /[\u0000-\u001f\u007f]/.test(context.tracestate))
  ) {
    throw new TypeError(
      'W3C tracestate must be printable and between 1 and 512 characters.',
    );
  }
  return { ...context };
}

export class CopilotTraceContextCarrier {
  private readonly storage = new AsyncLocalStorage<W3CTraceContext>();

  run<T>(traceContext: W3CTraceContext, operation: () => T): T {
    return this.storage.run(validateW3CTraceContext(traceContext), operation);
  }

  currentTraceContext(): W3CTraceContext | undefined {
    const current = this.storage.getStore();
    return current ? { ...current } : undefined;
  }
}

export function copilotSdkTelemetryOptions(
  carrier: CopilotTraceContextCarrier,
  otlpEndpoint?: string,
): Pick<CopilotClientOptions, 'telemetry' | 'onGetTraceContext'> {
  const endpoint = (
    otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  )
    ?.trim()
    .replace(/\/$/, '');
  return {
    telemetry: {
      captureContent: false,
      ...(endpoint
        ? {
            exporterType: 'otlp-http',
            otlpEndpoint: endpoint,
            otlpProtocol: 'http/protobuf' as const,
            sourceName: 'mission-control-copilot-runtime',
          }
        : {}),
    },
    onGetTraceContext: () => carrier.currentTraceContext() ?? {},
  };
}

function nativeEventKind(type: string): HoustonRunEventKind | undefined {
  switch (type) {
    case 'session.start':
      return 'run.attached';
    case 'session.resume':
      return 'run.attached';
    case 'session.idle':
    case 'assistant.idle':
      return 'run.idle';
    case 'session.shutdown':
      return 'provider.shutdown';
    case 'session.task_complete':
      return 'provider.task_completed';
    case 'session.model_change':
      return 'model.changed';
    case 'assistant.turn_start':
    case 'model.call_start':
      return 'model.started';
    case 'assistant.turn_retry':
      return 'model.retry';
    case 'assistant.message_start':
      return 'output.started';
    case 'assistant.streaming_delta':
    case 'assistant.message_delta':
      return 'output.progress';
    case 'assistant.message':
      return 'output.completed';
    case 'assistant.turn_end':
      return 'model.completed';
    case 'assistant.reasoning':
      return 'reasoning.completed';
    case 'assistant.reasoning_delta':
      return 'reasoning.progress';
    case 'assistant.usage':
      return 'model.usage';
    case 'model.call_failure':
      return 'model.failed';
    case 'session.error':
      return 'provider.error';
    case 'abort':
      return 'run.cancel_observed';
    case 'tool.user_requested':
      return 'tool.requested';
    case 'tool.execution_start':
      return 'tool.started';
    case 'tool.execution_partial_result':
    case 'tool.execution_progress':
    case 'assistant.tool_call_delta':
      return 'tool.progress';
    case 'tool.execution_complete':
      return 'tool.completed';
    default:
      return undefined;
  }
}

function safeToolIdentifier(
  value: unknown,
): HoustonRunEventTool['identifier'] {
  return value === HOUSTON_TASK_SUMMARY_TOOL
    ? HOUSTON_TASK_SUMMARY_TOOL
    : 'unrecognized_tool';
}

function safeUsage(data: Record<string, unknown>): HoustonRunEventUsage {
  const copilotUsage = isRecord(data.copilotUsage)
    ? data.copilotUsage
    : undefined;
  const finishReason = safeIdentifier(data.finishReason);
  const endpoint = safeIdentifier(data.apiEndpoint);
  return {
    ...(finiteNonNegative(data.inputTokens) === undefined
      ? {}
      : { inputTokens: finiteNonNegative(data.inputTokens) }),
    ...(finiteNonNegative(data.outputTokens) === undefined
      ? {}
      : { outputTokens: finiteNonNegative(data.outputTokens) }),
    ...(finiteNonNegative(data.cacheReadTokens) === undefined
      ? {}
      : { cacheReadTokens: finiteNonNegative(data.cacheReadTokens) }),
    ...(finiteNonNegative(data.cacheWriteTokens) === undefined
      ? {}
      : { cacheWriteTokens: finiteNonNegative(data.cacheWriteTokens) }),
    ...(finiteNonNegative(data.reasoningTokens) === undefined
      ? {}
      : { reasoningTokens: finiteNonNegative(data.reasoningTokens) }),
    ...(finiteNonNegative(copilotUsage?.totalNanoAiu) === undefined
      ? {}
      : { totalNanoAiu: finiteNonNegative(copilotUsage?.totalNanoAiu) }),
    ...(finiteNonNegative(data.duration) === undefined
      ? {}
      : { durationMs: finiteNonNegative(data.duration) }),
    ...(finiteNonNegative(data.timeToFirstTokenMs) === undefined
      ? {}
      : { timeToFirstTokenMs: finiteNonNegative(data.timeToFirstTokenMs) }),
    ...(finiteNonNegative(data.interTokenLatencyMs) === undefined
      ? {}
      : { interTokenLatencyMs: finiteNonNegative(data.interTokenLatencyMs) }),
    ...(finishReason && SAFE_FINISH_REASONS.has(finishReason)
      ? { finishReason }
      : {}),
    ...(endpoint && SAFE_API_ENDPOINTS.has(endpoint)
      ? { endpoint }
      : {}),
    ...(typeof data.contentFilterTriggered === 'boolean'
      ? { contentFilterTriggered: data.contentFilterTriggered }
      : {}),
  };
}

function safeFailure(data: Record<string, unknown>): HoustonRunEventFailure {
  const category = safeIdentifier(data.errorType);
  const code = safeIdentifier(data.errorCode);
  const failureKind =
    data.failureKind === 'api' || data.failureKind === 'transport'
      ? data.failureKind
      : undefined;
  const source =
    data.source === 'top_level' ||
    data.source === 'subagent' ||
    data.source === 'mcp_sampling'
      ? data.source
      : undefined;
  const transport =
    data.transport === 'http' || data.transport === 'websocket'
      ? data.transport
      : undefined;
  return {
    ...(category && SAFE_FAILURE_CATEGORIES.has(category)
      ? { category }
      : {}),
    ...(code && SAFE_FAILURE_CODES.has(code)
      ? { code }
      : {}),
    ...(finiteStatusCode(data.statusCode) === undefined
      ? {}
      : { statusCode: finiteStatusCode(data.statusCode) }),
    ...(failureKind ? { failureKind } : {}),
    ...(source ? { source } : {}),
    ...(transport ? { transport } : {}),
  };
}

function nativeMetadata(
  type: string,
  data: Record<string, unknown>,
  tool: HoustonRunEventTool | undefined,
): EventMetadata {
  const model = safeIdentifier(
    data.model ?? data.selectedModel ?? data.newModel ?? data.currentModel,
  );
  if (type === 'assistant.usage') {
    return { model, usage: safeUsage(data) };
  }
  if (type === 'model.call_failure' || type === 'session.error') {
    return { model, failure: safeFailure(data) };
  }
  if (
    type.startsWith('tool.') ||
    type === 'assistant.tool_call_delta' ||
    type.startsWith('permission.')
  ) {
    if (
      tool &&
      type === 'tool.execution_complete' &&
      typeof data.success === 'boolean'
    ) {
      tool.outcome = data.success ? 'allowed' : 'failed';
    }
    return { model, tool };
  }
  if (type === 'assistant.streaming_delta') {
    return {
      progressBytes: finiteNonNegative(data.totalResponseSizeBytes),
    };
  }
  if (
    type === 'assistant.message_delta' ||
    type === 'assistant.reasoning_delta'
  ) {
    const content = data.deltaContent;
    return {
      progressBytes:
        typeof content === 'string' ? Buffer.byteLength(content) : undefined,
    };
  }
  if (type === 'assistant.message') {
    return {
      model,
      usage:
        finiteNonNegative(data.outputTokens) === undefined
          ? undefined
          : { outputTokens: finiteNonNegative(data.outputTokens) },
    };
  }
  return { model };
}

function lifecycleKind(
  source: HoustonLifecycleEventSource,
  terminalState: HoustonRunTerminalState | undefined,
  cleanupStarted: boolean,
): HoustonRunEventKind | undefined {
  if (source.terminalState && !terminalState) return 'run.terminal';
  if (source.state === 'cleaned_up') return 'run.cleanup_completed';
  if (source.cleanupFailure) return 'run.cleanup_failed';
  if (source.cleanupPending && source.terminalState && !cleanupStarted) {
    return 'run.cleanup_started';
  }
  if (source.cleanupPending && cleanupStarted) return undefined;
  if (source.terminalState && terminalState) return undefined;
  if (source.state === 'creating') return 'run.started';
  if (source.state === 'resuming') return 'run.resuming';
  if (source.connection === 'detached') return 'run.detached';
  if (source.state === 'active') return 'run.active';
  return 'run.idle';
}

export class HoustonRunEventMapper {
  private sequence: number;
  private parentEventId: string | undefined;
  private terminalState: HoustonRunTerminalState | undefined;
  private cleanupStarted: boolean;
  private lastNativeTimestamp: string | undefined;
  private readonly seenIdempotencyKeys: Set<string>;
  private readonly toolIdentifiers = new Map<
    string,
    HoustonRunEventTool['identifier']
  >();
  private readonly trace: { traceId: string; spanId: string };

  constructor(
    private readonly context: HoustonRunEventContext,
    cursor: HoustonRunEventCursor = {
      sequence: 0,
      seenIdempotencyKeys: [],
    },
    private readonly now: () => number = Date.now,
  ) {
    if (!context.runId || !context.correlationId || !context.featureId) {
      throw new TypeError('Run, correlation, and feature identifiers are required.');
    }
    this.trace = parseTraceparent(
      validateW3CTraceContext(context.traceContext).traceparent,
    );
    this.sequence = cursor.sequence;
    this.parentEventId = cursor.parentEventId;
    this.terminalState = cursor.terminalState;
    this.cleanupStarted = cursor.cleanupStarted ?? false;
    this.lastNativeTimestamp = cursor.lastNativeTimestamp;
    this.seenIdempotencyKeys = new Set(cursor.seenIdempotencyKeys);
  }

  cursor(): HoustonRunEventCursor {
    return {
      sequence: this.sequence,
      parentEventId: this.parentEventId,
      terminalState: this.terminalState,
      cleanupStarted: this.cleanupStarted,
      lastNativeTimestamp: this.lastNativeTimestamp,
      seenIdempotencyKeys: [...this.seenIdempotencyKeys],
    };
  }

  mapLifecycle(
    source: HoustonLifecycleEventSource,
  ): HoustonRunEventDisposition {
    if (
      source.runId !== this.context.runId ||
      source.correlationId !== this.context.correlationId ||
      source.featureId !== this.context.featureId ||
      source.sensitivity !== this.context.sensitivity
    ) {
      return { accepted: false, reason: 'ignored' };
    }
    const idempotencyKey = stableId(
      'idem',
      `${source.runId}:lifecycle:${source.revision}`,
    );
    if (this.seenIdempotencyKeys.has(idempotencyKey)) {
      return { accepted: false, reason: 'duplicate' };
    }
    if (
      source.terminalState &&
      this.terminalState &&
      source.terminalState !== this.terminalState
    ) {
      return { accepted: false, reason: 'terminal_conflict' };
    }
    const kind = lifecycleKind(
      source,
      this.terminalState,
      this.cleanupStarted,
    );
    if (!kind) return { accepted: false, reason: 'ignored' };
    if (kind === 'run.terminal') this.terminalState = source.terminalState;
    if (kind === 'run.cleanup_started') this.cleanupStarted = true;
    if (kind === 'run.cleanup_completed') this.cleanupStarted = false;
    return this.accept({
      sourceKey: `lifecycle:${source.revision}`,
      idempotencyKey,
      timestamp: new Date(source.updatedAt).toISOString(),
      kind,
      boundary: 'lifecycle',
      eventType: `lifecycle.${source.state}`,
      delivery: 'live',
      metadata: { model: source.model },
      lifecycleState: source.state,
      terminalState:
        kind === 'run.terminal' ? source.terminalState : undefined,
    });
  }

  mapNative(
    event: SessionEvent,
    options: { replay?: boolean } = {},
  ): HoustonRunEventDisposition {
    const record = event as unknown as NativeEventRecord;
    const sourceId = safeIdentifier(record.id);
    const type = safeIdentifier(record.type);
    if (!sourceId || !type) return { accepted: false, reason: 'ignored' };
    const kind = nativeEventKind(type);
    if (!kind) return { accepted: false, reason: 'ignored' };
    const idempotencyKey = stableId(
      'idem',
      `${this.context.runId}:sdk:${sourceId}`,
    );
    if (this.seenIdempotencyKeys.has(idempotencyKey)) {
      return { accepted: false, reason: 'duplicate' };
    }
    if (this.terminalState) {
      return { accepted: false, reason: 'post_terminal' };
    }
    const observedAt = new Date(this.now()).toISOString();
    const timestamp = eventTimestamp(record.timestamp, observedAt);
    const late =
      this.lastNativeTimestamp !== undefined &&
      timestamp < this.lastNativeTimestamp;
    if (!late) this.lastNativeTimestamp = timestamp;
    const data = isRecord(record.data) ? record.data : {};
    return this.accept({
      sourceKey: `sdk:${sourceId}`,
      idempotencyKey,
      timestamp,
      kind,
      boundary: 'sdk',
      eventType: type,
      delivery: options.replay ? 'replay' : late ? 'late' : 'live',
      ephemeral: record.ephemeral === true,
      metadata: nativeMetadata(
        type,
        data,
        this.nativeToolMetadata(type, data),
      ),
    });
  }

  mapToolAudit(event: HoustonToolAuditEvent): HoustonRunEventDisposition {
    if (
      event.runId !== this.context.runId ||
      event.correlationId !== this.context.correlationId
    ) {
      return { accepted: false, reason: 'ignored' };
    }
    if (this.terminalState) {
      return { accepted: false, reason: 'post_terminal' };
    }
    const sourceKey = `tool-audit:${this.sequence + 1}`;
    return this.accept({
      sourceKey,
      idempotencyKey: stableId(
        'idem',
        `${this.context.runId}:${sourceKey}`,
      ),
      timestamp: new Date(this.now()).toISOString(),
      kind: 'tool.decision',
      boundary: 'tool_audit',
      eventType: 'houston.tool_audit',
      delivery: 'live',
      metadata: {
        tool: {
          identifier: safeToolIdentifier(event.toolIdentifier),
          permissionDecision: event.permissionDecision,
          outcome: event.outcome,
          durationMs: finiteNonNegative(event.durationMs),
        },
      },
    });
  }

  private accept(input: {
    sourceKey: string;
    idempotencyKey: string;
    timestamp: string;
    kind: HoustonRunEventKind;
    boundary: HoustonRunEvent['source']['boundary'];
    eventType: string;
    delivery: HoustonRunEvent['source']['delivery'];
    ephemeral?: boolean;
    metadata: EventMetadata;
    lifecycleState?: string;
    terminalState?: HoustonRunTerminalState;
  }): HoustonRunEventDisposition {
    this.sequence += 1;
    const eventId = stableId(
      'evt',
      `${this.context.runId}:${input.sourceKey}`,
    );
    const observedAt = new Date(this.now()).toISOString();
    const event: HoustonRunEvent = {
      schemaVersion: HOUSTON_RUN_EVENT_SCHEMA_VERSION,
      eventId,
      idempotencyKey: input.idempotencyKey,
      runId: this.context.runId,
      correlationId: this.context.correlationId,
      ...(this.parentEventId ? { parentEventId: this.parentEventId } : {}),
      sequence: this.sequence,
      timestamp: input.timestamp,
      observedAt,
      kind: input.kind,
      executionRoute: COPILOT_EXECUTION_ROUTE,
      featureId: this.context.featureId,
      sensitivity: this.context.sensitivity,
      provider: {
        name: COPILOT_PROVIDER,
        ...(input.metadata.model
          ? { model: input.metadata.model }
          : { model: this.context.model }),
      },
      source: {
        boundary: input.boundary,
        eventType: input.eventType,
        delivery: input.delivery,
        ...(input.ephemeral ? { ephemeral: true } : {}),
      },
      trace: {
        traceId: this.trace.traceId,
        spanId: hash(eventId).slice(0, 16),
        parentSpanId: this.trace.spanId,
      },
      ...(input.lifecycleState
        ? { lifecycleState: input.lifecycleState }
        : {}),
      ...(input.terminalState ? { terminalState: input.terminalState } : {}),
      ...(input.metadata.usage ? { usage: input.metadata.usage } : {}),
      ...(input.metadata.failure ? { failure: input.metadata.failure } : {}),
      ...(input.metadata.tool ? { tool: input.metadata.tool } : {}),
      ...(input.metadata.progressBytes === undefined
        ? {}
        : { progressBytes: input.metadata.progressBytes }),
    };
    this.parentEventId = eventId;
    this.seenIdempotencyKeys.add(input.idempotencyKey);
    return { accepted: true, event };
  }

  private nativeToolMetadata(
    type: string,
    data: Record<string, unknown>,
  ): HoustonRunEventTool | undefined {
    if (!type.startsWith('tool.') && type !== 'assistant.tool_call_delta') {
      return undefined;
    }
    const toolCallId = safeIdentifier(data.toolCallId);
    const toolName = safeIdentifier(data.toolName ?? data.name);
    if (!toolCallId && !toolName) return undefined;
    const identifier = toolName
      ? safeToolIdentifier(toolName)
      : toolCallId
        ? this.toolIdentifiers.get(toolCallId) ?? 'unrecognized_tool'
        : 'unrecognized_tool';
    if (toolCallId && toolName) {
      this.toolIdentifiers.set(toolCallId, identifier);
    }
    const tool: HoustonRunEventTool = {
      identifier,
      ...(toolCallId
        ? {
            callCorrelationId: stableId(
              'tool',
              `${this.context.runId}:${toolCallId}`,
              24,
            ),
          }
        : {}),
    };
    if (type === 'tool.execution_complete' && toolCallId) {
      this.toolIdentifiers.delete(toolCallId);
    }
    return tool;
  }
}
