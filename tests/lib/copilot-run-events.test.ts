import type { SessionEvent } from '@github/copilot-sdk';
import { describe, expect, it } from 'vitest';
import {
  COPILOT_EXECUTION_ROUTE,
  COPILOT_PROVIDER,
  CopilotTraceContextCarrier,
  HoustonRunEventMapper,
  copilotSdkTelemetryOptions,
  createW3CTraceContext,
  type HoustonLifecycleEventSource,
  type HoustonRunEventContext,
  type W3CTraceContext,
} from '@/lib/ai/copilot-run-events';
import { HOUSTON_TASK_SUMMARY_TOOL } from '@/lib/ai/copilot-houston-tools';

const traceContext: W3CTraceContext = {
  traceparent:
    '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01',
  tracestate: 'vendor=value',
};

const context: HoustonRunEventContext = {
  runId: 'run-1',
  correlationId: 'correlation-1',
  featureId: 'houston-chat',
  sensitivity: 'standard',
  model: 'gpt-5-mini',
  traceContext,
};

function lifecycle(
  overrides: Partial<HoustonLifecycleEventSource> = {},
): HoustonLifecycleEventSource {
  return {
    ...context,
    state: 'creating',
    connection: 'attached',
    revision: 0,
    updatedAt: Date.parse('2026-08-04T12:00:00.000Z'),
    ...overrides,
  };
}

function sdkEvent(
  id: string,
  type: string,
  data: Record<string, unknown> = {},
  overrides: Partial<{
    timestamp: string;
    ephemeral: boolean;
    parentId: string | null;
  }> = {},
): SessionEvent {
  return {
    id,
    type,
    data,
    parentId: overrides.parentId ?? null,
    timestamp: overrides.timestamp ?? '2026-08-04T12:00:01.000Z',
    ...(overrides.ephemeral ? { ephemeral: true } : {}),
  } as unknown as SessionEvent;
}

function accepted(
  disposition: ReturnType<HoustonRunEventMapper['mapNative']>,
) {
  expect(disposition.accepted).toBe(true);
  if (!disposition.accepted) throw new Error('Expected an accepted event.');
  return disposition.event;
}

describe('HoustonRunEventMapper', () => {
  it('creates stable IDs, monotonic sequences, and a public parent chain', () => {
    const mapper = new HoustonRunEventMapper(
      context,
      undefined,
      () => Date.parse('2026-08-04T12:00:02.000Z'),
    );
    const started = mapper.mapLifecycle(lifecycle());
    expect(started.accepted).toBe(true);
    if (!started.accepted) throw new Error('Expected a lifecycle event.');
    const attached = accepted(
      mapper.mapNative(
        sdkEvent('sdk-event-1', 'session.start', {
          sessionId: 'private-provider-session',
          selectedModel: 'gpt-5-mini',
          copilotVersion: '1.0.76-0',
        }),
      ),
    );

    expect(started.event).toMatchObject({
      schemaVersion: 1,
      sequence: 1,
      kind: 'run.started',
      executionRoute: COPILOT_EXECUTION_ROUTE,
      provider: { name: COPILOT_PROVIDER, model: 'gpt-5-mini' },
      trace: {
        traceId: '0123456789abcdef0123456789abcdef',
        parentSpanId: '0123456789abcdef',
      },
    });
    expect(attached.sequence).toBe(2);
    expect(attached.parentEventId).toBe(started.event.eventId);
    expect(JSON.stringify([started.event, attached])).not.toContain(
      'private-provider-session',
    );

    const replayedMapper = new HoustonRunEventMapper(context);
    const replayedStart = replayedMapper.mapLifecycle(lifecycle());
    const replayedAttached = accepted(
      replayedMapper.mapNative(
        sdkEvent('sdk-event-1', 'session.start', {
          sessionId: 'another-provider-session',
          selectedModel: 'gpt-5-mini',
        }),
      ),
    );
    expect(replayedStart.accepted && replayedStart.event.eventId).toBe(
      started.event.eventId,
    );
    expect(replayedAttached.eventId).toBe(attached.eventId);
  });

  it('maps streaming, reasoning, usage, model, and failures without content', () => {
    const mapper = new HoustonRunEventMapper(context);
    const output = accepted(
      mapper.mapNative(
        sdkEvent('message-delta', 'assistant.message_delta', {
          messageId: 'message-1',
          deltaContent: 'PRIVATE RESPONSE',
        }),
      ),
    );
    const reasoning = accepted(
      mapper.mapNative(
        sdkEvent('reasoning-delta', 'assistant.reasoning_delta', {
          reasoningId: 'reasoning-1',
          deltaContent: 'PRIVATE REASONING',
        }),
      ),
    );
    const usage = accepted(
      mapper.mapNative(
        sdkEvent('usage-1', 'assistant.usage', {
          apiCallId: 'provider-call-private',
          model: 'gpt-5-mini',
          inputTokens: 10,
          outputTokens: 4,
          reasoningTokens: 2,
          cacheReadTokens: 3,
          duration: 50,
          timeToFirstTokenMs: 12,
          finishReason: 'stop',
          apiEndpoint: '/responses',
          copilotUsage: { totalNanoAiu: 123 },
        }),
      ),
    );
    const modelStart = accepted(
      mapper.mapNative(
        sdkEvent('model-start', 'model.call_start', {
          turnId: 'turn-1',
          model: 'gpt-5-mini',
        }),
      ),
    );
    const turnEnd = accepted(
      mapper.mapNative(sdkEvent('turn-end', 'assistant.turn_end')),
    );
    const message = accepted(
      mapper.mapNative(sdkEvent('message', 'assistant.message')),
    );
    const failure = accepted(
      mapper.mapNative(
        sdkEvent('model-failure', 'model.call_failure', {
          model: 'gpt-5-mini',
          errorCode: 'quota_exceeded',
          errorType: 'quota',
          errorMessage: 'credential ghp_PRIVATE',
          statusCode: 429,
          failureKind: 'api',
          source: 'top_level',
          transport: 'http',
          requestFingerprint: { messageCount: 1 },
        }),
      ),
    );
    const unsafeFailure = accepted(
      mapper.mapNative(
        sdkEvent('unsafe-failure', 'session.error', {
          errorType: 'ghp_PRIVATE_CATEGORY',
          errorCode: 'github_pat_PRIVATE_CODE',
          message: 'PRIVATE MESSAGE',
          stack: 'PRIVATE STACK',
        }),
      ),
    );
    const unsafeUsage = accepted(
      mapper.mapNative(
        sdkEvent('unsafe-usage', 'assistant.usage', {
          model: 'gpt-5-mini',
          finishReason: 'ghp_PRIVATE_FINISH',
          apiEndpoint: '/private/credential',
        }),
      ),
    );

    expect(output).toMatchObject({
      kind: 'output.progress',
      progressBytes: Buffer.byteLength('PRIVATE RESPONSE'),
    });
    expect(reasoning).toMatchObject({
      kind: 'reasoning.progress',
      progressBytes: Buffer.byteLength('PRIVATE REASONING'),
    });
    expect(usage).toMatchObject({
      kind: 'model.usage',
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        reasoningTokens: 2,
        cacheReadTokens: 3,
        durationMs: 50,
        timeToFirstTokenMs: 12,
        finishReason: 'stop',
        endpoint: '/responses',
        totalNanoAiu: 123,
      },
    });
    expect(modelStart.kind).toBe('model.started');
    expect(turnEnd.kind).toBe('model.completed');
    expect(message.kind).toBe('output.completed');
    expect(failure).toMatchObject({
      kind: 'model.failed',
      failure: {
        category: 'quota',
        code: 'quota_exceeded',
        statusCode: 429,
        failureKind: 'api',
        source: 'top_level',
        transport: 'http',
      },
    });
    const serialized = JSON.stringify([
      output,
      reasoning,
      usage,
      modelStart,
      failure,
      unsafeFailure,
      unsafeUsage,
    ]);
    expect(serialized).not.toContain('PRIVATE RESPONSE');
    expect(serialized).not.toContain('PRIVATE REASONING');
    expect(serialized).not.toContain('ghp_PRIVATE');
    expect(serialized).not.toContain('provider-call-private');
    expect(serialized).not.toContain('requestFingerprint');
    expect(serialized).not.toContain('ghp_PRIVATE_CATEGORY');
    expect(serialized).not.toContain('github_pat_PRIVATE_CODE');
    expect(serialized).not.toContain('PRIVATE MESSAGE');
    expect(serialized).not.toContain('PRIVATE STACK');
    expect(serialized).not.toContain('ghp_PRIVATE_FINISH');
    expect(serialized).not.toContain('/private/credential');
    expect(unsafeFailure.failure).toEqual({});
    expect(unsafeUsage.usage).toEqual({});
  });

  it('deduplicates, marks replay and late delivery, and restores a cursor', () => {
    const mapper = new HoustonRunEventMapper(context);
    const firstSource = sdkEvent(
      'event-1',
      'assistant.streaming_delta',
      { totalResponseSizeBytes: 10 },
      { timestamp: '2026-08-04T12:00:10.000Z', ephemeral: true },
    );
    const first = accepted(mapper.mapNative(firstSource));
    expect(mapper.mapNative(firstSource)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    const replay = accepted(
      mapper.mapNative(
        sdkEvent(
          'event-2',
          'assistant.streaming_delta',
          { totalResponseSizeBytes: 20 },
          { timestamp: '2026-08-04T12:00:11.000Z' },
        ),
        { replay: true },
      ),
    );
    const late = accepted(
      mapper.mapNative(
        sdkEvent(
          'event-3',
          'assistant.streaming_delta',
          { totalResponseSizeBytes: 15 },
          { timestamp: '2026-08-04T12:00:09.000Z' },
        ),
      ),
    );

    expect(first.sequence).toBe(1);
    expect(replay).toMatchObject({
      sequence: 2,
      source: { delivery: 'replay' },
    });
    expect(late).toMatchObject({
      sequence: 3,
      source: { delivery: 'late' },
    });

    const resumed = new HoustonRunEventMapper(context, mapper.cursor());
    expect(resumed.mapNative(firstSource)).toEqual({
      accepted: false,
      reason: 'duplicate',
    });
    const continued = accepted(
      resumed.mapNative(sdkEvent('event-4', 'assistant.message_start')),
    );
    expect(continued.sequence).toBe(4);
    expect(continued.parentEventId).toBe(late.eventId);
  });

  it('emits one immutable terminal outcome and rejects provider events afterward', () => {
    const mapper = new HoustonRunEventMapper(context);
    const terminal = mapper.mapLifecycle(
      lifecycle({
        state: 'cancelling',
        terminalState: 'cancelled',
        revision: 1,
      }),
    );
    expect(terminal.accepted).toBe(true);
    if (!terminal.accepted) throw new Error('Expected terminal event.');
    expect(terminal.event).toMatchObject({
      kind: 'run.terminal',
      terminalState: 'cancelled',
    });
    expect(
      mapper.mapNative(sdkEvent('late-provider', 'assistant.message')),
    ).toEqual({ accepted: false, reason: 'post_terminal' });

    const cleanupStarted = mapper.mapLifecycle(
      lifecycle({
        state: 'failed',
        terminalState: 'cancelled',
        cleanupPending: true,
        revision: 2,
      }),
    );
    expect(cleanupStarted.accepted && cleanupStarted.event.kind).toBe(
      'run.cleanup_started',
    );
    const cleanupFailure = mapper.mapLifecycle(
      lifecycle({
        state: 'failed',
        terminalState: 'cancelled',
        cleanupPending: true,
        cleanupFailure: true,
        revision: 3,
      }),
    );
    expect(cleanupFailure.accepted && cleanupFailure.event.kind).toBe(
      'run.cleanup_failed',
    );
    expect(
      mapper.mapLifecycle(
        lifecycle({
          state: 'failed',
          terminalState: 'failed',
          revision: 4,
        }),
      ),
    ).toEqual({ accepted: false, reason: 'terminal_conflict' });
  });

  it('uses canonical content-free Houston tool metadata only', () => {
    const mapper = new HoustonRunEventMapper(context);
    expect(
      mapper.mapToolAudit({
        runId: 'other-run',
        correlationId: context.correlationId,
        toolIdentifier: HOUSTON_TASK_SUMMARY_TOOL,
        permissionDecision: 'allow',
        durationMs: 1,
        outcome: 'allowed',
      }),
    ).toEqual({ accepted: false, reason: 'ignored' });
    const decision = mapper.mapToolAudit({
      runId: context.runId,
      correlationId: context.correlationId,
      toolIdentifier: HOUSTON_TASK_SUMMARY_TOOL,
      permissionDecision: 'allow',
      durationMs: 4,
      outcome: 'allowed',
    });
    expect(decision.accepted).toBe(true);
    if (!decision.accepted) throw new Error('Expected tool decision.');
    const started = accepted(
      mapper.mapNative(
        sdkEvent('tool-start', 'tool.execution_start', {
          toolCallId: 'call-1',
          toolName: HOUSTON_TASK_SUMMARY_TOOL,
          arguments: { credential: 'PRIVATE ARGUMENT' },
        }),
      ),
    );
    const completed = accepted(
      mapper.mapNative(
        sdkEvent('tool-complete', 'tool.execution_complete', {
          toolCallId: 'call-1',
          result: { content: 'PRIVATE RESULT' },
          error: { message: 'PRIVATE ERROR' },
          success: true,
        }),
      ),
    );

    expect(decision.event.tool).toEqual({
      identifier: HOUSTON_TASK_SUMMARY_TOOL,
      permissionDecision: 'allow',
      durationMs: 4,
      outcome: 'allowed',
    });
    expect(completed).toMatchObject({
      kind: 'tool.completed',
      tool: {
        identifier: HOUSTON_TASK_SUMMARY_TOOL,
        outcome: 'allowed',
      },
    });
    expect(started).toMatchObject({
      kind: 'tool.started',
      tool: { identifier: HOUSTON_TASK_SUMMARY_TOOL },
    });
    const serialized = JSON.stringify([decision.event, started, completed]);
    expect(serialized).not.toContain('call-1');
    expect(serialized).not.toContain('PRIVATE ARGUMENT');
    expect(serialized).not.toContain('PRIVATE RESULT');
    expect(serialized).not.toContain('PRIVATE ERROR');
  });
});

describe('Copilot trace context', () => {
  it('propagates one W3C context and configures content-free OTLP export', async () => {
    const carrier = new CopilotTraceContextCarrier();
    const options = copilotSdkTelemetryOptions(
      carrier,
      'http://collector.internal:4318/',
    );

    expect(options.telemetry).toEqual({
      captureContent: false,
      exporterType: 'otlp-http',
      otlpEndpoint: 'http://collector.internal:4318',
      otlpProtocol: 'http/protobuf',
      sourceName: 'mission-control-copilot-runtime',
    });
    await carrier.run(traceContext, async () => {
      expect(await options.onGetTraceContext?.()).toEqual(traceContext);
    });
    expect(await options.onGetTraceContext?.()).toEqual({});
  });

  it('creates valid unique root contexts and rejects invalid input', () => {
    const first = createW3CTraceContext();
    const second = createW3CTraceContext();
    expect(first.traceparent).toMatch(
      /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/,
    );
    expect(second.traceparent).not.toBe(first.traceparent);
    const carrier = new CopilotTraceContextCarrier();
    expect(() =>
      carrier.run(
        {
          traceparent:
            '00-00000000000000000000000000000000-0000000000000000-01',
        },
        () => undefined,
      ),
    ).toThrow('valid W3C traceparent');
  });
});
