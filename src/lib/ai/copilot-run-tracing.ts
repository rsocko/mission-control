import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  createTraceState,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import type {
  HoustonRunEvent,
  HoustonRunTerminalState,
  W3CTraceContext,
} from './copilot-run-events';

const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export type HoustonRunTraceOperation =
  | 'session.create'
  | 'session.resume'
  | 'session.send'
  | 'session.abort'
  | 'session.disconnect'
  | 'session.delete';

export interface HoustonRunTraceSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId: string;
}

export interface HoustonRunTrace {
  readonly traceContext: W3CTraceContext;
  recordEvent(event: HoustonRunEvent): HoustonRunTraceSpanContext;
  runOperation<T>(
    operation: HoustonRunTraceOperation,
    callback: (traceContext: W3CTraceContext) => Promise<T>,
  ): Promise<T>;
  end(terminalState: HoustonRunTerminalState): void;
}

export interface HoustonRunTraceInput {
  runId: string;
  correlationId: string;
  featureId: string;
  sensitivity: 'standard';
  incomingTraceContext?: W3CTraceContext;
}

export interface HoustonRunTracerOptions {
  exporter?: SpanExporter;
}

function contextFromTraceContext(traceContext: W3CTraceContext): Context {
  const match = TRACEPARENT_PATTERN.exec(traceContext.traceparent);
  if (!match) {
    throw new TypeError('A valid W3C traceparent is required.');
  }
  return trace.setSpanContext(ROOT_CONTEXT, {
    traceId: match[1],
    spanId: match[2],
    traceFlags:
      Number.parseInt(match[3], 16) & TraceFlags.SAMPLED
        ? TraceFlags.SAMPLED
        : TraceFlags.NONE,
    isRemote: true,
    ...(traceContext.tracestate
      ? { traceState: createTraceState(traceContext.tracestate) }
      : {}),
  });
}

function traceContextFromSpan(span: Span): W3CTraceContext {
  const spanContext = span.spanContext();
  const tracestate = spanContext.traceState?.serialize();
  return {
    traceparent: `00-${spanContext.traceId}-${spanContext.spanId}-${spanContext.traceFlags
      .toString(16)
      .padStart(2, '0')}`,
    ...(tracestate ? { tracestate } : {}),
  };
}

function eventAttributes(event: HoustonRunEvent): Attributes {
  return {
    'mc.run.id': event.runId,
    'mc.run.correlation_id': event.correlationId,
    'mc.run.feature_id': event.featureId,
    'mc.run.sensitivity': event.sensitivity,
    'mc.run.event_id': event.eventId,
    'mc.run.event_sequence': event.sequence,
    'mc.run.event_kind': event.kind,
    'mc.run.execution_route': event.executionRoute,
    'mc.run.source_boundary': event.source.boundary,
    'mc.run.source_event_type': event.source.eventType,
    'mc.run.source_delivery': event.source.delivery,
    'gen_ai.system': event.provider.name,
    ...(event.provider.model
      ? { 'gen_ai.request.model': event.provider.model }
      : {}),
    ...(event.lifecycleState
      ? { 'mc.run.lifecycle_state': event.lifecycleState }
      : {}),
    ...(event.terminalState
      ? { 'mc.run.terminal_state': event.terminalState }
      : {}),
    ...(event.tool
      ? {
          'gen_ai.tool.name': event.tool.identifier,
          ...(event.tool.permissionDecision
            ? {
                'mc.run.tool.permission_decision':
                  event.tool.permissionDecision,
              }
            : {}),
          ...(event.tool.outcome
            ? { 'mc.run.tool.outcome': event.tool.outcome }
            : {}),
          ...(event.tool.durationMs === undefined
            ? {}
            : { 'mc.run.tool.duration_ms': event.tool.durationMs }),
        }
      : {}),
    ...(event.usage?.inputTokens === undefined
      ? {}
      : { 'gen_ai.usage.input_tokens': event.usage.inputTokens }),
    ...(event.usage?.outputTokens === undefined
      ? {}
      : { 'gen_ai.usage.output_tokens': event.usage.outputTokens }),
    ...(event.failure?.category
      ? { 'mc.run.failure.category': event.failure.category }
      : {}),
    ...(event.failure?.code
      ? { 'mc.run.failure.code': event.failure.code }
      : {}),
    ...(event.failure?.statusCode === undefined
      ? {}
      : { 'http.response.status_code': event.failure.statusCode }),
  };
}

class OpenTelemetryHoustonRunTrace implements HoustonRunTrace {
  readonly traceContext: W3CTraceContext;
  private readonly parentContext: Context;
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    private readonly rootSpan: Span | undefined,
    traceContext: W3CTraceContext,
  ) {
    this.traceContext = traceContext;
    this.parentContext = contextFromTraceContext(traceContext);
  }

  recordEvent(event: HoustonRunEvent): HoustonRunTraceSpanContext {
    const span = this.tracer.startSpan(
      'mission-control.copilot.run.event',
      { attributes: eventAttributes(event) },
      this.parentContext,
    );
    const spanContext = span.spanContext();
    span.setStatus({
      code:
        event.kind === 'provider.error' ||
        event.kind === 'model.failed' ||
        event.kind === 'run.cleanup_failed'
          ? SpanStatusCode.ERROR
          : SpanStatusCode.OK,
    });
    span.end();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      parentSpanId: TRACEPARENT_PATTERN.exec(this.traceContext.traceparent)![2],
    };
  }

  async runOperation<T>(
    operation: HoustonRunTraceOperation,
    callback: (traceContext: W3CTraceContext) => Promise<T>,
  ): Promise<T> {
    const span = this.tracer.startSpan(
      `mission-control.copilot.${operation}`,
      {
        attributes: {
          'mc.run.operation': operation,
        },
      },
      this.parentContext,
    );
    try {
      const result = await callback(traceContextFromSpan(span));
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      span.end();
    }
  }

  end(terminalState: HoustonRunTerminalState): void {
    if (this.ended || !this.rootSpan) return;
    this.ended = true;
    this.rootSpan.setAttribute('mc.run.terminal_state', terminalState);
    this.rootSpan.setStatus({
      code:
        terminalState === 'completed' || terminalState === 'cancelled'
          ? SpanStatusCode.OK
          : SpanStatusCode.ERROR,
    });
    this.rootSpan.end();
  }
}

export class HoustonRunTracer {
  private readonly provider: BasicTracerProvider;
  private readonly tracer: Tracer;

  constructor(options: HoustonRunTracerOptions = {}) {
    this.provider = new BasicTracerProvider({
      spanProcessors: options.exporter
        ? [new SimpleSpanProcessor(options.exporter)]
        : [],
    });
    this.tracer = this.provider.getTracer(
      'mission-control-copilot-run',
      '1.0.0',
    );
  }

  startRun(input: HoustonRunTraceInput): HoustonRunTrace {
    const parentContext = input.incomingTraceContext
      ? contextFromTraceContext(input.incomingTraceContext)
      : ROOT_CONTEXT;
    const rootSpan = this.tracer.startSpan(
      'mission-control.copilot.run',
      {
        attributes: {
          'mc.run.id': input.runId,
          'mc.run.correlation_id': input.correlationId,
          'mc.run.feature_id': input.featureId,
          'mc.run.sensitivity': input.sensitivity,
        },
      },
      parentContext,
    );
    return new OpenTelemetryHoustonRunTrace(
      this.tracer,
      rootSpan,
      traceContextFromSpan(rootSpan),
    );
  }

  continueRun(traceContext: W3CTraceContext): HoustonRunTrace {
    return new OpenTelemetryHoustonRunTrace(
      this.tracer,
      undefined,
      traceContext,
    );
  }

  forceFlush(): Promise<void> {
    return this.provider.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.provider.shutdown();
  }
}

let defaultTracer: HoustonRunTracer | undefined;

export function getDefaultHoustonRunTracer(): HoustonRunTracer {
  if (defaultTracer) return defaultTracer;
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
    ?.trim()
    .replace(/\/$/, '');
  defaultTracer = new HoustonRunTracer({
    ...(endpoint
      ? {
          exporter: new OTLPTraceExporter({
            url: `${endpoint}/v1/traces`,
          }),
        }
      : {}),
  });
  return defaultTracer;
}
