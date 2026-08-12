import {
  ROOT_CONTEXT,
  SpanStatusCode,
  context,
  trace,
  type Attributes,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BasicTracerProvider,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
} from '@opentelemetry/sdk-trace-base';
import {
  ExportResultCode,
  type ExportResult,
} from '@opentelemetry/core';

export interface CopilotComparisonTraceContext {
  traceparent: string;
}

export interface CopilotComparisonTraceInput {
  correlationId: string;
  route: 'bifrost' | 'direct-sdk';
  fixtureId: 'bounded-text-v1' | 'structured-json-v1';
  operation: 'request' | 'cancellation';
  model: string;
}

export interface CopilotComparisonTraceRunner {
  runRoot<T>(
    input: CopilotComparisonTraceInput,
    operation: (context: CopilotComparisonTraceContext) => Promise<T>,
  ): Promise<T>;
  forceFlush(): Promise<boolean>;
}

export interface CopilotComparisonTracerOptions {
  exporter?: SpanExporter;
}

class TrackingSpanExporter implements SpanExporter {
  failed = false;

  constructor(private readonly delegate: SpanExporter) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    let completed = false;
    try {
      this.delegate.export(spans, (result) => {
        completed = true;
        if (result.code !== ExportResultCode.SUCCESS) this.failed = true;
        resultCallback(result);
      });
    } catch (error) {
      this.failed = true;
      if (!completed) {
        resultCallback({
          code: ExportResultCode.FAILED,
          ...(error instanceof Error ? { error } : {}),
        });
      }
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this.delegate.forceFlush?.();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this.delegate.shutdown();
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
}

function traceContext(span: Span): CopilotComparisonTraceContext {
  const context = span.spanContext();
  return {
    traceparent: `00-${context.traceId}-${context.spanId}-${context.traceFlags
      .toString(16)
      .padStart(2, '0')}`,
  };
}

export class CopilotComparisonTracer
  implements CopilotComparisonTraceRunner
{
  private readonly provider: BasicTracerProvider;
  private readonly tracer: Tracer;
  private readonly exporter: TrackingSpanExporter | undefined;

  constructor(options: CopilotComparisonTracerOptions = {}) {
    this.exporter = options.exporter
      ? new TrackingSpanExporter(options.exporter)
      : undefined;
    this.provider = new BasicTracerProvider({
      spanProcessors: this.exporter
        ? [new SimpleSpanProcessor(this.exporter)]
        : [],
    });
    this.tracer = this.provider.getTracer(
      'mission-control-copilot-comparison',
      '1.0.0',
    );
  }

  async runRoot<T>(
    input: CopilotComparisonTraceInput,
    operation: (context: CopilotComparisonTraceContext) => Promise<T>,
  ): Promise<T> {
    const attributes: Attributes = {
      'mc.comparison.correlation_id': input.correlationId,
      'mc.comparison.route': input.route,
      'mc.comparison.fixture_id': input.fixtureId,
      'mc.comparison.operation': input.operation,
      'mc.ai.sensitivity': 'standard',
      'gen_ai.request.model': input.model,
    };
    const root = this.tracer.startSpan(
      'mission-control.copilot.comparison',
      { attributes },
      ROOT_CONTEXT,
    );
    try {
      const activeRoot = trace.setSpan(ROOT_CONTEXT, root);
      const result = await context.with(activeRoot, () =>
        operation(traceContext(root)),
      );
      root.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      root.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      try {
        root.end();
      } catch {
        // Trace export is best-effort and must not change route execution.
      }
    }
  }

  async forceFlush(): Promise<boolean> {
    try {
      await this.provider.forceFlush();
      return this.exporter?.failed !== true;
    } catch {
      return false;
    }
  }

  async shutdown(): Promise<boolean> {
    try {
      await this.provider.shutdown();
      return this.exporter?.failed !== true;
    } catch {
      return false;
    }
  }
}

export function createOtlpCopilotComparisonTracer(
  endpoint: string,
): CopilotComparisonTracer {
  return new CopilotComparisonTracer({
    exporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    }),
  });
}
