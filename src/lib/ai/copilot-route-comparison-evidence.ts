import {
  CopilotComparisonError,
  type ComparisonCleanupState,
  type CopilotCancellationObservation,
  type CopilotComparisonAttemptEvidence,
  type CopilotComparisonFinalizationEvidence,
  type CopilotComparisonFixture,
  type CopilotComparisonRouteId,
  type CopilotComparisonRouteMetadata,
} from './copilot-route-comparison-contracts';

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

export interface CopilotComparisonAttempt {
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

export function safeCopilotComparisonErrorCode(error: unknown): string {
  return error instanceof CopilotComparisonError &&
    SAFE_COMPARISON_ERROR_CODES.has(error.code)
    ? error.code
    : 'route_failure';
}

export function copilotComparisonTraceId(traceparent: string): string {
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

export function summarizeCopilotComparisonAttempts(
  attempts: CopilotComparisonAttempt[],
) {
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

export function sanitizeCopilotComparisonAttemptEvidence(
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

export interface CopilotComparisonRouteEvidence {
  metadata: CopilotComparisonRouteMetadata;
  attempts: CopilotComparisonAttempt[];
  summary: ReturnType<typeof summarizeCopilotComparisonAttempts>;
  cancellation: CopilotCancellationObservation & {
    correlationId: string;
    traceId: string;
  };
  finalization: CopilotComparisonFinalizationEvidence;
}

export function validateCopilotComparisonEvidence(
  byRoute: Record<CopilotComparisonRouteId, CopilotComparisonRouteEvidence>,
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
  if (byRoute['direct-sdk'].finalization.traceExportSucceeded !== true) {
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
