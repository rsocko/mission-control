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
