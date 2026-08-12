import type { CopilotComparisonTraceRunner } from './copilot-route-comparison-tracing';

export const COPILOT_ROUTE_COMPARISON_SCHEMA_VERSION = 1 as const;
export const COPILOT_ROUTE_COMPARISON_FIXTURE_VERSION = 1 as const;

export type CopilotComparisonRouteId = 'bifrost' | 'direct-sdk';
export type ComparisonCleanupState =
  | 'confirmed'
  | 'client-only'
  | 'not-observable'
  | 'failed';

export interface ComparisonMessage {
  role: 'system' | 'user';
  content: string;
}

export interface CopilotComparisonFixture {
  id: 'bounded-text-v1' | 'structured-json-v1';
  messages: readonly ComparisonMessage[];
  evaluate(content: string): {
    schemaValid: boolean;
    qualityPass: boolean;
  };
}

const TEXT_MARKER = 'MC_ROUTE_COMPARE_TEXT_V1';
const STRUCTURED_EXPECTED = {
  category: 'maintenance',
  priority: 2,
  labels: ['home', 'weekly'],
} as const;

export const COPILOT_ROUTE_COMPARISON_FIXTURES: readonly CopilotComparisonFixture[] =
  [
    {
      id: 'bounded-text-v1',
      messages: [
        {
          role: 'system',
          content:
            'You are a deterministic validation service. Return only the requested output.',
        },
        {
          role: 'user',
          content: `Return exactly ${TEXT_MARKER} and nothing else.`,
        },
      ],
      evaluate(content) {
        const matched = content.trim() === TEXT_MARKER;
        return { schemaValid: matched, qualityPass: matched };
      },
    },
    {
      id: 'structured-json-v1',
      messages: [
        {
          role: 'system',
          content:
            'Return only one JSON object with exactly the requested keys. Do not use markdown fences.',
        },
        {
          role: 'user',
          content:
            'For the synthetic task "Weekly furnace filter check", return category "maintenance", numeric priority 2, and labels ["home","weekly"]. Use exactly the keys category, priority, and labels.',
        },
      ],
      evaluate(content) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(content);
        } catch {
          return { schemaValid: false, qualityPass: false };
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { schemaValid: false, qualityPass: false };
        }
        const value = parsed as Record<string, unknown>;
        const keys = Object.keys(value).sort();
        const schemaValid =
          keys.join(',') === 'category,labels,priority' &&
          typeof value.category === 'string' &&
          typeof value.priority === 'number' &&
          Array.isArray(value.labels) &&
          value.labels.every((label) => typeof label === 'string');
        const qualityPass =
          schemaValid &&
          value.category === STRUCTURED_EXPECTED.category &&
          value.priority === STRUCTURED_EXPECTED.priority &&
          JSON.stringify(value.labels) ===
            JSON.stringify(STRUCTURED_EXPECTED.labels);
        return { schemaValid, qualityPass };
      },
    },
  ];

export interface CopilotComparisonRequest {
  fixture: CopilotComparisonFixture;
  model: string;
  sensitivity: 'standard';
  correlationId: string;
  traceparent: string;
  timeoutMs: number;
}

export interface CopilotComparisonRouteMetadata {
  route: CopilotComparisonRouteId;
  provider: 'github-copilot';
  model: string;
  runtime: {
    sdkVersion?: string;
    cliPackageVersion?: string;
    cliRuntimeVersion?: string;
    sdkProtocolVersion?: number;
    nodeVersion?: string;
  };
  operatorAssertions?: {
    gatewayDeploymentDigest: string;
    adapterDeploymentDigest: string;
    verification: 'unverified' | 'matched-authenticated-attestation';
  };
  attestation:
    | {
        status: 'verified';
        source: 'in-process-runtime' | 'authenticated-remote-runtime-contract';
        authType: 'token' | 'user' | 'gh-cli' | 'device' | 'unknown';
        gatewayDeploymentDigest?: string;
        adapterDeploymentDigest?: string;
        traceParentageVerified: boolean;
      }
    | {
        status: 'unavailable';
        source: 'none';
        reason: 'authenticated-remote-runtime-contract-unavailable';
      };
  quota: {
    state: 'available' | 'exhausted' | 'unknown';
    snapshotCount: number;
  };
}

export interface CopilotComparisonObservation {
  content: string;
  provider: 'github-copilot';
  model: string;
  fallbackOccurred: boolean;
  correlationMatched: boolean;
  totalLatencyMs: number;
  timeToFirstTokenMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  quota: {
    state: 'available' | 'exhausted' | 'unknown';
    snapshotCount: number;
  };
  cleanup: ComparisonCleanupState;
}

export interface CopilotCancellationObservation {
  outcome: 'cancelled' | 'completed-before-cancel' | 'failed';
  cancellationObserved: boolean;
  cleanup: ComparisonCleanupState;
  totalLatencyMs: number;
  errorCode?: string;
}

export interface CopilotComparisonFinalizationEvidence {
  cleanupSucceeded: boolean;
  traceExportSucceeded?: boolean;
  traceParentageVerified?: boolean;
  expectedTraceCount?: number;
  matchedTraceCount?: number;
}

export interface CopilotComparisonRoute {
  readonly id: CopilotComparisonRouteId;
  initialize(): Promise<CopilotComparisonRouteMetadata>;
  execute(
    request: CopilotComparisonRequest,
    signal: AbortSignal,
  ): Promise<CopilotComparisonObservation>;
  cancel(
    request: CopilotComparisonRequest,
    abortAfterMs: number,
  ): Promise<CopilotCancellationObservation>;
  finalizeEvidence(): Promise<CopilotComparisonFinalizationEvidence>;
  close(): Promise<void>;
}

export interface CopilotComparisonAttemptEvidence {
  fallbackOccurred?: boolean;
  correlationMatched?: boolean;
  modelMatched?: boolean;
  providerMatched?: boolean;
}

export class CopilotComparisonError extends Error {
  constructor(
    readonly code: string,
    readonly attemptEvidence?: CopilotComparisonAttemptEvidence,
  ) {
    super(`Copilot route comparison failed: ${code}`);
    this.name = 'CopilotComparisonError';
  }
}

const SAFE_COMPARISON_ERROR_CODES = new Set([
  'cleanup_failed',
  'client_cancelled',
  'configuration_invalid',
  'concurrency_exceeded',
  'credential_expired',
  'credential_invalid',
  'credential_missing',
  'credential_revoked',
  'entitlement_denied',
  'invalid_request',
  'model_unavailable',
  'policy_denied',
  'policy_metadata_invalid',
  'protocol_evidence_missing',
  'quota_exhausted',
  'rate_limited',
  'request_timeout',
  'route_configuration_invalid',
  'route_unavailable',
  'runtime_unavailable',
  'sensitivity_denied',
  'shutdown_failed',
  'trace_context_invalid',
  'unsupported_request',
  'upstream_failure',
]);

interface ComparisonAttempt {
  route: CopilotComparisonRouteId;
  fixtureId: CopilotComparisonFixture['id'];
  attempt: number;
  correlationId: string;
  traceId: string;
  success: boolean;
  schemaValid: boolean;
  qualityPass: boolean;
  modelMatched: boolean;
  providerMatched: boolean;
  fallbackOccurred?: boolean;
  correlationMatched?: boolean;
  totalLatencyMs?: number;
  timeToFirstTokenMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  quota?: {
    state: 'available' | 'exhausted' | 'unknown';
    snapshotCount: number;
  };
  cleanup?: ComparisonCleanupState;
  responseBytes?: number;
  errorCode?: string;
}

function safeErrorCode(error: unknown): string {
  return error instanceof CopilotComparisonError &&
    SAFE_COMPARISON_ERROR_CODES.has(error.code)
    ? error.code
    : 'route_failure';
}

function traceId(traceparent: string): string {
  const match = /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(
    traceparent,
  );
  if (!match) throw new CopilotComparisonError('trace_context_invalid');
  return match[1];
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function summarize(attempts: ComparisonAttempt[]) {
  const successful = attempts.filter((attempt) => attempt.success);
  const latencies = successful.flatMap((attempt) =>
    attempt.totalLatencyMs === undefined ? [] : [attempt.totalLatencyMs],
  );
  const firstTokenLatencies = successful.flatMap((attempt) =>
    attempt.timeToFirstTokenMs === undefined
      ? []
      : [attempt.timeToFirstTokenMs],
  );
  return {
    requests: attempts.length,
    successfulRequests: successful.length,
    reliabilityRate:
      attempts.length === 0 ? 0 : successful.length / attempts.length,
    schemaValidityRate:
      attempts.length === 0
        ? 0
        : attempts.filter((attempt) => attempt.schemaValid).length /
          attempts.length,
    qualityPassRate:
      attempts.length === 0
        ? 0
        : attempts.filter((attempt) => attempt.qualityPass).length /
          attempts.length,
    modelMatchRate:
      successful.length === 0
        ? 0
        : successful.filter((attempt) => attempt.modelMatched).length /
          successful.length,
    providerMatchRate:
      successful.length === 0
        ? 0
        : successful.filter((attempt) => attempt.providerMatched).length /
          successful.length,
    fallbackViolationCount: attempts.filter(
      (attempt) => attempt.fallbackOccurred === true,
    ).length,
    fallbackUnknownCount: attempts.filter(
      (attempt) => attempt.fallbackOccurred === undefined,
    ).length,
    correlationMismatchCount: attempts.filter(
      (attempt) => attempt.correlationMatched === false,
    ).length,
    correlationUnknownCount: attempts.filter(
      (attempt) => attempt.correlationMatched === undefined,
    ).length,
    usageEvidenceRate:
      successful.length === 0
        ? 0
        : successful.filter((attempt) => attempt.usage !== undefined).length /
          successful.length,
    quotaEvidenceRate:
      successful.length === 0
        ? 0
        : successful.filter((attempt) => attempt.quota?.state === 'available')
            .length / successful.length,
    cleanupConfirmedRate:
      successful.length === 0
        ? 0
        : successful.filter((attempt) => attempt.cleanup === 'confirmed')
            .length / successful.length,
    medianTotalLatencyMs: median(latencies),
    medianTimeToFirstTokenMs: median(firstTokenLatencies),
    firstTokenSamples: firstTokenLatencies.length,
  };
}

export interface RunCopilotComparisonInput {
  model: string;
  sensitivity: 'local-only' | 'restricted' | 'standard';
  repetitions: number;
  timeoutMs: number;
  cancellationAbortAfterMs: number;
  trace: CopilotComparisonTraceRunner;
  now?: () => Date;
  randomId?: () => string;
}

function safeAttemptEvidence(
  error: unknown,
): CopilotComparisonAttemptEvidence | undefined {
  if (!(error instanceof CopilotComparisonError)) return undefined;
  const evidence = error.attemptEvidence;
  if (!evidence) return undefined;
  return {
    ...(typeof evidence.fallbackOccurred === 'boolean'
      ? { fallbackOccurred: evidence.fallbackOccurred }
      : {}),
    ...(typeof evidence.correlationMatched === 'boolean'
      ? { correlationMatched: evidence.correlationMatched }
      : {}),
    ...(typeof evidence.modelMatched === 'boolean'
      ? { modelMatched: evidence.modelMatched }
      : {}),
    ...(typeof evidence.providerMatched === 'boolean'
      ? { providerMatched: evidence.providerMatched }
      : {}),
  };
}

function convergenceReasons(
  byRoute: Record<
    CopilotComparisonRouteId,
    {
      metadata: CopilotComparisonRouteMetadata;
      attempts: ComparisonAttempt[];
      summary: ReturnType<typeof summarize>;
      cancellation: CopilotCancellationObservation;
      finalization: CopilotComparisonFinalizationEvidence;
    }
  >,
  expectedRequests: number,
  traceFlushSucceeded: boolean,
): string[] {
  const reasons = new Set<string>();
  for (const routeId of ['bifrost', 'direct-sdk'] as const) {
    const route = byRoute[routeId];
    if (route.attempts.length !== expectedRequests) {
      reasons.add(`${routeId}_request_count_incomplete`);
    }
    if (route.summary.successfulRequests !== expectedRequests) {
      reasons.add(`${routeId}_request_failure`);
    }
    if (route.summary.schemaValidityRate !== 1) {
      reasons.add(`${routeId}_schema_invalid`);
    }
    if (route.summary.qualityPassRate !== 1) {
      reasons.add(`${routeId}_quality_failed`);
    }
    if (route.summary.modelMatchRate !== 1) {
      reasons.add(`${routeId}_model_mismatch`);
    }
    if (route.summary.providerMatchRate !== 1) {
      reasons.add(`${routeId}_provider_mismatch`);
    }
    if (route.summary.usageEvidenceRate !== 1) {
      reasons.add(`${routeId}_usage_unverified`);
    }
    if (route.summary.quotaEvidenceRate !== 1) {
      reasons.add(`${routeId}_quota_unverified`);
    }
    if (route.summary.cleanupConfirmedRate !== 1) {
      reasons.add(`${routeId}_request_cleanup_unverified`);
    }
    if (
      route.cancellation.outcome !== 'cancelled' ||
      !route.cancellation.cancellationObserved
    ) {
      reasons.add(`${routeId}_cancellation_failed`);
    }
    if (route.cancellation.cleanup !== 'confirmed') {
      reasons.add(`${routeId}_backend_cleanup_unverified`);
    }
    if (route.metadata.quota.state !== 'available') {
      reasons.add(`${routeId}_quota_unverified`);
    }
    if (!route.finalization.cleanupSucceeded) {
      reasons.add(`${routeId}_final_cleanup_failed`);
    }
  }

  const bifrost = byRoute.bifrost;
  if (bifrost.summary.fallbackViolationCount > 0) {
    reasons.add('bifrost_fallback_observed');
  }
  if (bifrost.summary.fallbackUnknownCount > 0) {
    reasons.add('bifrost_fallback_unverified');
  }
  if (bifrost.summary.correlationMismatchCount > 0) {
    reasons.add('bifrost_correlation_mismatch');
  }
  if (bifrost.summary.correlationUnknownCount > 0) {
    reasons.add('bifrost_correlation_unverified');
  }
  if (
    bifrost.metadata.attestation.status !== 'verified' ||
    bifrost.metadata.attestation.source !==
      'authenticated-remote-runtime-contract'
  ) {
    reasons.add('bifrost_runtime_attestation_unavailable');
  } else {
    if (bifrost.metadata.attestation.authType !== 'token') {
      reasons.add('bifrost_token_auth_unverified');
    }
    if (!bifrost.metadata.attestation.traceParentageVerified) {
      reasons.add('bifrost_trace_parentage_unverified');
    }
    const assertions = bifrost.metadata.operatorAssertions;
    const immutableDigest = /^sha256:[0-9a-f]{64}$/;
    if (
      !assertions ||
      assertions.verification !== 'matched-authenticated-attestation' ||
      !immutableDigest.test(
        bifrost.metadata.attestation.gatewayDeploymentDigest ?? '',
      ) ||
      !immutableDigest.test(
        bifrost.metadata.attestation.adapterDeploymentDigest ?? '',
      ) ||
      assertions.gatewayDeploymentDigest !==
        bifrost.metadata.attestation.gatewayDeploymentDigest ||
      assertions.adapterDeploymentDigest !==
        bifrost.metadata.attestation.adapterDeploymentDigest
    ) {
      reasons.add('bifrost_deployment_attestation_mismatch');
    }
  }
  if (
    byRoute['direct-sdk'].metadata.attestation.status !== 'verified' ||
    byRoute['direct-sdk'].metadata.attestation.authType !== 'token'
  ) {
    reasons.add('direct_token_auth_unverified');
  }
  if (
    byRoute['direct-sdk'].finalization.traceParentageVerified !== true
  ) {
    reasons.add('direct_trace_parentage_unverified');
  }
  if (
    byRoute['direct-sdk'].finalization.traceExportSucceeded !== true
  ) {
    reasons.add('direct_trace_export_failed');
  }
  if (!traceFlushSucceeded) {
    reasons.add('harness_trace_export_failed');
  }
  return [...reasons].sort();
}

export function copilotComparisonExitCode(evidence: {
  convergence: { converged: boolean };
}): 0 | 1 {
  return evidence.convergence.converged ? 0 : 1;
}

export async function runCopilotRouteComparison(
  input: RunCopilotComparisonInput,
  routes: readonly [CopilotComparisonRoute, CopilotComparisonRoute],
) {
  if (input.sensitivity !== 'standard') {
    throw new CopilotComparisonError('sensitivity_denied');
  }
  if (
    !/^[A-Za-z0-9._:/-]{1,160}$/.test(input.model) ||
    !Number.isInteger(input.repetitions) ||
    input.repetitions < 1 ||
    input.repetitions > 20 ||
    !Number.isInteger(input.timeoutMs) ||
    input.timeoutMs < 1_000 ||
    input.timeoutMs > 120_000 ||
    !Number.isInteger(input.cancellationAbortAfterMs) ||
    input.cancellationAbortAfterMs < 1 ||
    input.cancellationAbortAfterMs >= input.timeoutMs
  ) {
    throw new CopilotComparisonError('configuration_invalid');
  }
  if (new Set(routes.map((route) => route.id)).size !== 2) {
    throw new CopilotComparisonError('route_configuration_invalid');
  }

  const now = input.now ?? (() => new Date());
  const randomId = input.randomId ?? (() => crypto.randomUUID());
  const startedAt = now().toISOString();

  const initialized = await Promise.allSettled(
    routes.map((route) => route.initialize()),
  );
  if (initialized.some((result) => result.status === 'rejected')) {
    await Promise.allSettled(routes.map((route) => route.close()));
    throw new CopilotComparisonError('route_unavailable');
  }
  const routeMetadata = Object.fromEntries(
    initialized.map((result, index) => [
      routes[index].id,
      (result as PromiseFulfilledResult<CopilotComparisonRouteMetadata>).value,
    ]),
  ) as Record<CopilotComparisonRouteId, CopilotComparisonRouteMetadata>;

  const attempts: ComparisonAttempt[] = [];
  for (let attempt = 1; attempt <= input.repetitions; attempt += 1) {
    const orderedRoutes =
      attempt % 2 === 1 ? routes : ([routes[1], routes[0]] as const);
    for (const fixture of COPILOT_ROUTE_COMPARISON_FIXTURES) {
      for (const route of orderedRoutes) {
        const correlationId = randomId();
        let rootTraceparent = '';
        try {
          const observation = await input.trace.runRoot(
            {
              correlationId,
              route: route.id,
              fixtureId: fixture.id,
              operation: 'request',
              model: input.model,
            },
            (context) => {
              rootTraceparent = context.traceparent;
              return route.execute(
                {
                  fixture,
                  model: input.model,
                  sensitivity: 'standard',
                  correlationId,
                  traceparent: context.traceparent,
                  timeoutMs: input.timeoutMs,
                },
                AbortSignal.timeout(input.timeoutMs),
              );
            },
          );
          const evaluation = fixture.evaluate(observation.content);
          attempts.push({
            route: route.id,
            fixtureId: fixture.id,
            attempt,
            correlationId,
            traceId: traceId(rootTraceparent),
            success: true,
            ...evaluation,
            modelMatched: observation.model === input.model,
            providerMatched: observation.provider === 'github-copilot',
            fallbackOccurred: observation.fallbackOccurred,
            correlationMatched: observation.correlationMatched,
            totalLatencyMs: observation.totalLatencyMs,
            ...(observation.timeToFirstTokenMs === undefined
              ? {}
              : { timeToFirstTokenMs: observation.timeToFirstTokenMs }),
            ...(observation.usage ? { usage: observation.usage } : {}),
            quota: observation.quota,
            cleanup: observation.cleanup,
            responseBytes: Buffer.byteLength(observation.content),
          });
        } catch (error) {
          const evidence = safeAttemptEvidence(error);
          attempts.push({
            route: route.id,
            fixtureId: fixture.id,
            attempt,
            correlationId,
            traceId: rootTraceparent
              ? traceId(rootTraceparent)
              : 'unavailable',
            success: false,
            schemaValid: false,
            qualityPass: false,
            modelMatched: evidence?.modelMatched ?? false,
            providerMatched: evidence?.providerMatched ?? false,
            ...(evidence?.fallbackOccurred === undefined
              ? {}
              : { fallbackOccurred: evidence.fallbackOccurred }),
            ...(evidence?.correlationMatched === undefined
              ? {}
              : { correlationMatched: evidence.correlationMatched }),
            errorCode: safeErrorCode(error),
          });
        }
      }
    }
  }

  const cancellation = Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => {
        const correlationId = randomId();
        try {
          let rootTraceparent = '';
          const observation = await input.trace.runRoot(
            {
              correlationId,
              route: route.id,
              fixtureId: COPILOT_ROUTE_COMPARISON_FIXTURES[0].id,
              operation: 'cancellation',
              model: input.model,
            },
            (context) => {
              rootTraceparent = context.traceparent;
              return route.cancel(
                {
                  fixture: COPILOT_ROUTE_COMPARISON_FIXTURES[0],
                  model: input.model,
                  sensitivity: 'standard',
                  correlationId,
                  traceparent: context.traceparent,
                  timeoutMs: input.timeoutMs,
                },
                input.cancellationAbortAfterMs,
              );
            },
          );
          return [
            route.id,
            {
              correlationId,
              traceId: traceId(rootTraceparent),
              ...observation,
            },
          ] as const;
        } catch (error) {
          return [
            route.id,
            {
              correlationId,
              traceId: 'unavailable',
              outcome: 'failed' as const,
              cancellationObserved: false,
              cleanup: 'failed' as const,
              totalLatencyMs: 0,
              errorCode: safeErrorCode(error),
            },
          ] as const;
        }
      }),
    ),
  ) as Record<
    CopilotComparisonRouteId,
    CopilotCancellationObservation & {
      correlationId: string;
      traceId: string;
    }
  >;

  const finalization = Object.fromEntries(
    await Promise.all(
      routes.map(async (route) => {
        try {
          return [route.id, await route.finalizeEvidence()] as const;
        } catch {
          return [
            route.id,
            {
              cleanupSucceeded: false,
              ...(route.id === 'direct-sdk'
                ? { traceExportSucceeded: false }
                : {}),
            },
          ] as const;
        }
      }),
    ),
  ) as Record<
    CopilotComparisonRouteId,
    CopilotComparisonFinalizationEvidence
  >;

  const byRoute = Object.fromEntries(
    routes.map((route) => {
      const routeAttempts = attempts.filter(
        (attempt) => attempt.route === route.id,
      );
      return [
        route.id,
        {
          metadata: routeMetadata[route.id],
          attempts: routeAttempts,
          summary: summarize(routeAttempts),
          cancellation: cancellation[route.id],
          finalization: finalization[route.id],
        },
      ];
    }),
  ) as Record<
    CopilotComparisonRouteId,
    {
      metadata: CopilotComparisonRouteMetadata;
      attempts: ComparisonAttempt[];
      summary: ReturnType<typeof summarize>;
      cancellation: (typeof cancellation)[CopilotComparisonRouteId];
      finalization: (typeof finalization)[CopilotComparisonRouteId];
    }
  >;

  const traceFlushSucceeded = await input.trace.forceFlush();
  const reasons = convergenceReasons(
    byRoute,
    input.repetitions * COPILOT_ROUTE_COMPARISON_FIXTURES.length,
    traceFlushSucceeded,
  );

  return {
    schemaVersion: COPILOT_ROUTE_COMPARISON_SCHEMA_VERSION,
    fixtureVersion: COPILOT_ROUTE_COMPARISON_FIXTURE_VERSION,
    startedAt,
    completedAt: now().toISOString(),
    controls: {
      sensitivity: 'standard' as const,
      allowedBifrostRoutes: ['bifrost-copilot'] as const,
      model: input.model,
      repetitions: input.repetitions,
      timeoutMs: input.timeoutMs,
      streaming: 'disabled-for-equivalence' as const,
      tools: 'disabled-for-equivalence' as const,
      prompts: 'identical-after-adapter-serialization' as const,
      temperature: 'unavailable-on-both-paths' as const,
      seed: 'unavailable-on-both-paths' as const,
      runtimeEnvironment:
        'not-equivalent-bifrost-deployment-versus-direct-worker' as const,
    },
    trace: {
      root: 'real-opentelemetry-span' as const,
      exportFlushSucceeded: traceFlushSucceeded,
    },
    convergence: {
      converged: reasons.length === 0,
      reasons,
    },
    routes: byRoute,
  };
}
