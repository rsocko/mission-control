import 'server-only';

import type { ConnectorConfig } from '@/types';
import { getPersistedFinanceManagerServiceToken } from './client';
import {
  attributionBatchRequestSchema,
  attributionBatchResponseSchema,
  attributionErrorResponseSchema,
  TYRION_ATTRIBUTION_CONTRACT_VERSION,
  TYRION_ATTRIBUTION_MAX_BODY_BYTES,
  TYRION_ATTRIBUTION_MAX_ITEMS,
  TYRION_ATTRIBUTION_MAX_RESPONSE_BYTES,
  TYRION_ATTRIBUTION_PATH,
  TYRION_ATTRIBUTION_PROVENANCE,
  type AttributionBatchItem,
  type AttributionBatchRequest,
  type AttributionBatchResponse,
} from './attribution-contract';
import {
  financeConnectorScopedReference,
  financeIdentityNamespaceFromCredentials,
} from './identity';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const PRIVATE_TYRION_ORIGIN = 'http://tyrion-operations-ui:3000';

const stableServiceErrorCodes = new Set([
  'invalid_request',
  'attribution_auth_required',
  'attribution_auth_invalid',
  'attribution_forbidden',
  'attribution_route_not_available',
  'policy_conflict',
  'payload_too_large',
  'batch_too_large',
  'unsupported_media_type',
  'attribution_rate_limited',
  'attribution_operation_failed',
  'attribution_auth_not_configured',
  'policy_unavailable',
  'attribution_service_unavailable',
]);

export interface TyrionAttributionConfig {
  serviceToken: string;
  identityNamespace: string;
  expectedPolicyVersion: number;
  timeoutMs: number;
}

export class TyrionAttributionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TyrionAttributionError';
  }
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function requiredPositiveInteger(value: string | undefined): number {
  const parsed = Number(value);
  if (!value?.trim() || !Number.isSafeInteger(parsed) || parsed < 1) {
    throw new TyrionAttributionError(
      'attribution_not_configured',
      'Tyrion attribution policy configuration is invalid',
      false,
    );
  }
  return parsed;
}

export function resolveTyrionAttributionConfig(
  financeConfig: Pick<ConnectorConfig, 'credentials'> = { credentials: {} },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TyrionAttributionConfig {
  const serviceToken = getPersistedFinanceManagerServiceToken(financeConfig)
    || environment.FINANCE_MANAGER_API_TOKEN?.trim()
    || '';
  const identityNamespace = financeIdentityNamespaceFromCredentials(
    financeConfig.credentials,
  );
  if (!serviceToken || !identityNamespace) {
    throw new TyrionAttributionError(
      'attribution_not_configured',
      'Tyrion attribution service configuration is unavailable',
      false,
    );
  }
  return {
    serviceToken,
    identityNamespace,
    expectedPolicyVersion: requiredPositiveInteger(
      environment.TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION,
    ),
    timeoutMs: positiveInteger(
      environment.TYRION_ATTRIBUTION_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
  };
}

export function createAttributionSourceRef(
  config: Pick<TyrionAttributionConfig, 'identityNamespace'>,
  _connectorId: string,
  upstreamTransactionId: string,
): string {
  return financeConnectorScopedReference(
    config.identityNamespace,
    'source',
    upstreamTransactionId,
  );
}

export function createAttributionAccountRef(
  config: Pick<TyrionAttributionConfig, 'identityNamespace'>,
  accountId: string,
): string {
  return financeConnectorScopedReference(
    config.identityNamespace,
    'account',
    accountId,
  );
}

export function normalizeAttributionMerchant(value: string | null): string {
  const normalized = (value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (normalized || 'Unknown merchant').slice(0, 160);
}

export function createAttributionHeaders(
  config: Pick<TyrionAttributionConfig, 'serviceToken'>,
): Headers {
  return new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${config.serviceToken}`,
    'Content-Type': 'application/json',
  });
}

function retryableCode(code: string, status: number): boolean {
  return status === 408
    || status === 429
    || status >= 500
    || [
      'attribution_rate_limited',
      'attribution_operation_failed',
      'policy_unavailable',
      'attribution_service_unavailable',
    ].includes(code);
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > TYRION_ATTRIBUTION_MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new TyrionAttributionError(
        'invalid_attribution_contract',
        'Tyrion attribution returned an invalid response',
        false,
        response.status,
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function sanitizedServiceCode(status: number, parsedCode?: string): string {
  if (parsedCode && stableServiceErrorCodes.has(parsedCode)) return parsedCode;
  if (status === 401) return 'attribution_auth_invalid';
  if (status === 403) return 'attribution_forbidden';
  if (status === 409) return 'policy_conflict';
  if (status === 429) return 'attribution_rate_limited';
  if (status >= 500) return 'attribution_service_unavailable';
  return 'invalid_request';
}

export class TyrionAttributionClient {
  constructor(
    readonly config = resolveTyrionAttributionConfig(),
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async attribute(
    request: AttributionBatchRequest,
    signal?: AbortSignal,
  ): Promise<AttributionBatchResponse> {
    const parsedRequest = attributionBatchRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      throw new TyrionAttributionError(
        'invalid_request',
        'Tyrion attribution request is invalid',
        false,
      );
    }
    const bodyText = JSON.stringify(parsedRequest.data);
    const body = new TextEncoder().encode(bodyText);
    if (body.byteLength > TYRION_ATTRIBUTION_MAX_BODY_BYTES) {
      throw new TyrionAttributionError(
        'payload_too_large',
        'Tyrion attribution request exceeds the size limit',
        false,
      );
    }
    const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${PRIVATE_TYRION_ORIGIN}${TYRION_ATTRIBUTION_PATH}`,
        {
          method: 'POST',
          headers: createAttributionHeaders(this.config),
          body: bodyText,
          cache: 'no-store',
          redirect: 'error',
          signal: requestSignal,
        },
      );
    } catch {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
      }
      throw new TyrionAttributionError(
        timeoutSignal.aborted ? 'attribution_timeout' : 'attribution_service_unavailable',
        timeoutSignal.aborted
          ? 'Tyrion attribution request timed out'
          : 'Tyrion attribution service is unavailable',
        true,
      );
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
    const responseText = await readBoundedResponse(response);
    let responseBody: unknown = null;
    if (contentType === 'application/json') {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = null;
      }
    }
    if (response.status !== 200) {
      const parsedError = attributionErrorResponseSchema.safeParse(responseBody);
      const code = sanitizedServiceCode(
        response.status,
        parsedError.success ? parsedError.data.error.code : undefined,
      );
      throw new TyrionAttributionError(
        code,
        `Tyrion attribution request failed (${code})`,
        retryableCode(code, response.status),
        response.status,
      );
    }
    const parsedResponse = attributionBatchResponseSchema.safeParse(responseBody);
    if (!parsedResponse.success) {
      throw new TyrionAttributionError(
        'invalid_attribution_contract',
        'Tyrion attribution returned an invalid response',
        false,
        response.status,
      );
    }
    const result = parsedResponse.data;
    if (
      result.results.length !== request.items.length
      || result.results.some((item, index) => item.sourceRef !== request.items[index].sourceRef)
      || result.results.some((item, index) => (
        request.items[index].existingManualDecision === null
        && (item.method === 'manual' || item.decisionSource === 'manual')
      ))
      || result.results.some((item) => (
        item.contractVersion !== result.contractVersion
        || item.policyVersion !== result.policyVersion
        || item.engineVersion !== result.engineVersion
      ))
    ) {
      throw new TyrionAttributionError(
        'invalid_attribution_correlation',
        'Tyrion attribution returned mismatched results',
        false,
        response.status,
      );
    }
    if (
      request.expectedPolicyVersion !== null
      && result.policyVersion !== request.expectedPolicyVersion
    ) {
      throw new TyrionAttributionError(
        'policy_conflict',
        'Tyrion attribution policy version changed',
        false,
        response.status,
      );
    }
    return result;
  }
}

export function createAttributionRequests(
  items: AttributionBatchItem[],
  expectedPolicyVersion: number,
): AttributionBatchRequest[] {
  if (items.length === 0) return [];
  const requests: AttributionBatchRequest[] = [];
  let current: AttributionBatchItem[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const request = {
      contractVersion: TYRION_ATTRIBUTION_CONTRACT_VERSION,
      provenance: TYRION_ATTRIBUTION_PROVENANCE,
      expectedPolicyVersion,
      items: candidate,
    } satisfies AttributionBatchRequest;
    const size = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    if (
      current.length > 0
      && (candidate.length > TYRION_ATTRIBUTION_MAX_ITEMS
        || size > TYRION_ATTRIBUTION_MAX_BODY_BYTES)
    ) {
      requests.push({ ...request, items: current });
      current = [item];
      continue;
    }
    if (size > TYRION_ATTRIBUTION_MAX_BODY_BYTES) {
      throw new TyrionAttributionError(
        'payload_too_large',
        'Tyrion attribution item exceeds the size limit',
        false,
      );
    }
    current = candidate;
  }
  requests.push({
    contractVersion: TYRION_ATTRIBUTION_CONTRACT_VERSION,
    provenance: TYRION_ATTRIBUTION_PROVENANCE,
    expectedPolicyVersion,
    items: current,
  });
  return requests;
}
