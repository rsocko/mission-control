import { describe, expect, it, vi } from 'vitest';
import {
  COPILOT_ROUTE_COMPARISON_FIXTURES,
  copilotComparisonExitCode,
  runCopilotRouteComparison,
  validateCopilotComparisonConfig,
  type CopilotComparisonRequest,
  type CopilotComparisonRoute,
} from '@/lib/ai/copilot-route-comparison';
import type { CopilotComparisonTraceRunner } from '@/lib/ai/copilot-route-comparison-tracing';

const gatewayDigest = `sha256:${'a'.repeat(64)}`;
const adapterDigest = `sha256:${'b'.repeat(64)}`;

function traceRunner(): CopilotComparisonTraceRunner {
  let sequence = 0;
  return {
    async runRoot(_input, operation) {
      sequence += 1;
      return operation({
        traceparent: `00-${sequence.toString(16).padStart(32, '0')}-${sequence
          .toString(16)
          .padStart(16, '0')}-01`,
      });
    },
    async forceFlush() {
      return true;
    },
  };
}

function validOutput(request: CopilotComparisonRequest): string {
  return request.fixture.id === 'bounded-text-v1'
    ? 'MC_ROUTE_COMPARE_TEXT_V1'
    : '{"category":"maintenance","priority":2,"labels":["home","weekly"]}';
}

function route(id: CopilotComparisonRoute['id']): CopilotComparisonRoute {
  return {
    id,
    initialize: vi.fn(async () => ({
      route: id,
      provider: 'github-copilot' as const,
      model: 'gpt-5-mini',
      runtime: {},
      ...(id === 'bifrost'
        ? {
            operatorAssertions: {
              gatewayDeploymentDigest: gatewayDigest,
              adapterDeploymentDigest: adapterDigest,
              verification: 'matched-authenticated-attestation' as const,
            },
          }
        : {}),
      attestation:
        id === 'bifrost'
          ? ({
              status: 'verified',
              source: 'authenticated-remote-runtime-contract',
              authType: 'token',
              gatewayDeploymentDigest: gatewayDigest,
              adapterDeploymentDigest: adapterDigest,
              traceParentageVerified: true,
            } as const)
          : ({
              status: 'verified',
              source: 'in-process-runtime',
              authType: 'token',
              traceParentageVerified: true,
            } as const),
      quota: { state: 'available' as const, snapshotCount: 1 },
    })),
    execute: vi.fn(async (request) => ({
      content: validOutput(request),
      provider: 'github-copilot' as const,
      model: request.model,
      fallbackOccurred: false,
      correlationMatched: true,
      totalLatencyMs: 10,
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      quota: { state: 'available' as const, snapshotCount: 1 },
      cleanup: 'confirmed' as const,
    })),
    cancel: vi.fn(async () => ({
      outcome: 'cancelled' as const,
      cancellationObserved: true,
      cleanup: 'confirmed' as const,
      totalLatencyMs: 1,
    })),
    finalizeEvidence: vi.fn(async () => ({
      cleanupSucceeded: true,
      ...(id === 'direct-sdk'
        ? {
            traceExportSucceeded: true,
            traceParentageVerified: true,
          }
        : {}),
    })),
    close: vi.fn(async () => undefined),
  };
}

function input() {
  return {
    model: 'gpt-5-mini',
    sensitivity: 'standard' as const,
    repetitions: 1,
    timeoutMs: 30_000,
    cancellationAbortAfterMs: 25,
    trace: traceRunner(),
    now: () => new Date('2026-08-18T00:00:00.000Z'),
    randomId: () => crypto.randomUUID(),
  };
}

describe('Copilot route comparison modules', () => {
  it('keeps fixture schema and semantic evidence separate', () => {
    const structured = COPILOT_ROUTE_COMPARISON_FIXTURES[1];

    expect(
      structured.evaluate(
        '{"category":"maintenance","priority":3,"labels":["home","weekly"]}',
      ),
    ).toEqual({ schemaValid: true, qualityPass: false });
    expect(structured.evaluate('not-json')).toEqual({
      schemaValid: false,
      qualityPass: false,
    });
  });

  it('requires exactly one Bifrost and one direct SDK route', () => {
    const bifrost = route('bifrost');

    expect(() =>
      validateCopilotComparisonConfig(input(), [bifrost, bifrost]),
    ).toThrowError(
      expect.objectContaining({
        code: 'route_configuration_invalid',
      }),
    );
  });

  it('produces converged content-free evidence through the public facade', async () => {
    const evidence = await runCopilotRouteComparison(input(), [
      route('bifrost'),
      route('direct-sdk'),
    ]);

    expect(evidence.convergence).toEqual({ converged: true, reasons: [] });
    expect(evidence.routes.bifrost.summary).toMatchObject({
      requests: 2,
      successfulRequests: 2,
      schemaValidityRate: 1,
      qualityPassRate: 1,
    });
    expect(evidence.routes.bifrost.cancellation).toMatchObject({
      correlationId: expect.any(String),
      traceId: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
    expect(copilotComparisonExitCode(evidence)).toBe(0);
    expect(JSON.stringify(evidence)).not.toContain('MC_ROUTE_COMPARE_TEXT_V1');
  });
});
