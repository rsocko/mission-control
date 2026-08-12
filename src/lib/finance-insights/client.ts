import 'server-only';

import { getPersistedFinanceManagerServiceToken } from '@/lib/connectors/monarch-money/client';
import type { ConnectorConfig } from '@/types';
import {
  FINANCE_INSIGHT_MAX_REQUEST_BYTES,
  FINANCE_INSIGHT_OCCURRENCE_SNAPSHOT_PAGE_LIMIT,
  insightOccurrenceDetailSchema,
  occurrenceIdSchema,
  occurrenceActionRequestSchema,
  occurrenceActionResultSchema,
  occurrenceListQuerySchema,
  sourceReferenceSchema,
  insightErrorResponseSchema,
  occurrenceListResponseSchema,
  evaluationRequestSchema,
  evaluationResultSchema,
  sourceBatchReceiptSchema,
  sourceFactBatchSchema,
  sourceGenerationCommitRequestSchema,
  sourceGenerationCreateRequestSchema,
  sourceGenerationResultSchema,
  type OccurrenceListResponseV1,
  type OccurrenceActionRequestV1,
  type OccurrenceActionResultV1,
  type OccurrenceListQueryV1,
  type EvaluationRequestV1,
  type EvaluationResultV1,
  type InsightOccurrenceDetailV1,
  type InsightOccurrenceSummaryV1,
  type SourceBatchReceiptV1,
  type SourceFactBatchV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
  type SourceGenerationResultV1,
} from './contract';

const PRIVATE_TYRION_FINANCE_INSIGHT_ORIGIN = 'http://tyrion-operations-ui:3000';
const SOURCE_GENERATIONS_PATH = '/api/internal/v1/finance/insights/source-generations';
const OCCURRENCES_PATH = '/api/internal/v1/finance/insights/occurrences';
const EVALUATIONS_PATH = '/api/internal/v1/finance/insights/evaluations';
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRIES = 3;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BACKOFF_DELAY_MS = 10_000;
const MAX_RETRY_AFTER_MS = 300_000;
const MAX_OCCURRENCE_SNAPSHOT_ITEMS = 500;

export interface TyrionFinanceInsightConfig {
  serviceToken: string;
  timeoutMs: number;
  maxRetries: number;
  shadowIngestEnabled: boolean;
}

export class TyrionFinanceInsightError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TyrionFinanceInsightError';
  }
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  maximum: number,
  allowZero = false,
): number {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  return Number.isSafeInteger(parsed) && parsed >= minimum
    ? Math.min(parsed, maximum)
    : fallback;
}

export function resolveTyrionFinanceInsightConfig(
  financeConfig: Pick<ConnectorConfig, 'credentials'>,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): TyrionFinanceInsightConfig {
  const serviceToken = getPersistedFinanceManagerServiceToken(financeConfig)
    || environment.FINANCE_MANAGER_API_TOKEN?.trim()
    || '';
  if (!serviceToken) {
    throw new TyrionFinanceInsightError(
      'insight_service_not_configured',
      'Tyrion finance insight service is not configured',
      false,
    );
  }
  return {
    serviceToken,
    timeoutMs: boundedInteger(
      environment.TYRION_FINANCE_INSIGHTS_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    maxRetries: boundedInteger(
      environment.TYRION_FINANCE_INSIGHTS_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      MAX_RETRIES,
      true,
    ),
    shadowIngestEnabled:
      environment.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED?.trim().toLowerCase() === 'true',
  };
}

export function createTyrionFinanceInsightHeaders(
  config: Pick<TyrionFinanceInsightConfig, 'serviceToken'>,
): Headers {
  return new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${config.serviceToken}`,
    'Content-Type': 'application/json',
  });
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function financeInsightRetryDelayMs(
  response: Response | null,
  attempt: number,
): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS);
    }
  }
  return Math.min(250 * (2 ** attempt), MAX_BACKOFF_DELAY_MS);
}

async function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled'));
      return;
    }
    const timer = setTimeout(resolve, delayMs);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled'));
    }, { once: true });
  });
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new TyrionFinanceInsightError(
      'invalid_finance_insight_contract',
      'Tyrion finance insight response is invalid',
      false,
      response.status,
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TyrionFinanceInsightError(
        'invalid_finance_insight_contract',
        'Tyrion finance insight response is invalid',
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

function sanitizedErrorCode(status: number, body: unknown): string {
  const parsed = insightErrorResponseSchema.safeParse(body);
  if (parsed.success) return parsed.data.error.code;
  if (status === 401) return 'insight_auth_invalid';
  if (status === 403) return 'insight_forbidden';
  if (status === 404) return 'insight_route_not_available';
  if (status === 409) return 'source_generation_conflict';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'evaluation_in_progress';
  if (status >= 500) return 'insight_source_unavailable';
  return 'invalid_request';
}

type JsonSchema<T> = {
  parse(value: unknown): T;
};

export class TyrionFinanceInsightClient {
  constructor(
    readonly config: TyrionFinanceInsightConfig,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  createSourceGeneration(
    request: SourceGenerationCreateRequestV1,
    signal?: AbortSignal,
  ): Promise<SourceGenerationResultV1> {
    return this.request(
      SOURCE_GENERATIONS_PATH,
      'POST',
      request,
      sourceGenerationCreateRequestSchema,
      sourceGenerationResultSchema,
      202,
      signal,
    );
  }

  putSourceFactBatch(
    request: SourceFactBatchV1,
    signal?: AbortSignal,
  ): Promise<SourceBatchReceiptV1> {
    return this.request(
      `${SOURCE_GENERATIONS_PATH}/${encodeURIComponent(request.sourceGeneration)}`
        + `/batches/${request.batchIndex}`,
      'PUT',
      request,
      sourceFactBatchSchema,
      sourceBatchReceiptSchema,
      200,
      signal,
    );
  }

  commitSourceGeneration(
    request: SourceGenerationCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<SourceGenerationResultV1> {
    return this.request(
      `${SOURCE_GENERATIONS_PATH}/${encodeURIComponent(request.sourceGeneration)}/commit`,
      'POST',
      request,
      sourceGenerationCommitRequestSchema,
      sourceGenerationResultSchema,
      200,
      signal,
    );
  }

  retryEvaluation(
    request: EvaluationRequestV1,
    signal?: AbortSignal,
  ): Promise<EvaluationResultV1> {
    return this.request(
      EVALUATIONS_PATH,
      'POST',
      request,
      evaluationRequestSchema,
      evaluationResultSchema,
      202,
      signal,
    );
  }

  async listOccurrences(
    query: OccurrenceListQueryV1,
    signal?: AbortSignal,
  ): Promise<OccurrenceListResponseV1> {
    let parsed: OccurrenceListQueryV1;
    try {
      parsed = occurrenceListQuerySchema.parse(query);
    } catch {
      throw new TyrionFinanceInsightError(
        'invalid_filter',
        'Tyrion finance insight occurrence filter is invalid',
        false,
      );
    }
    const parameters = new URLSearchParams();
    for (const key of [
      'kind',
      'sourceLifecycle',
      'analysisState',
      'severity',
      'baselineSufficiency',
    ] as const) {
      parsed[key].forEach((value) => parameters.append(key, value));
    }
    for (const key of ['connectorRef', 'updatedAfter', 'cursor'] as const) {
      if (parsed[key] !== null) parameters.set(key, parsed[key]);
    }
    parameters.set('limit', String(parsed.limit));
    const suffix = `?${parameters.toString()}`;
    const result = await this.request(
      `${OCCURRENCES_PATH}${suffix}`,
      'GET',
      null,
      null,
      occurrenceListResponseSchema,
      200,
      signal,
    );
    if (
      parsed.connectorRef !== null
      && result.items.some((item) => item.provenance.connectorRef !== parsed.connectorRef)
    ) {
      throw new TyrionFinanceInsightError(
        'invalid_finance_insight_contract',
        'Tyrion finance insight response is invalid',
        false,
        200,
      );
    }
    return result;
  }

  async listOccurrenceSnapshot(
    query: OccurrenceListQueryV1,
    signal?: AbortSignal,
  ): Promise<InsightOccurrenceSummaryV1[]> {
    let parsed: OccurrenceListQueryV1;
    try {
      parsed = occurrenceListQuerySchema.parse(query);
    } catch {
      throw new TyrionFinanceInsightError(
        'invalid_filter',
        'Tyrion finance insight occurrence filter is invalid',
        false,
      );
    }
    const items: InsightOccurrenceSummaryV1[] = [];
    const occurrenceIds = new Set<string>();
    const cursors = new Set<string>(parsed.cursor === null ? [] : [parsed.cursor]);
    let cursor = parsed.cursor;
    for (
      let pageCount = 0;
      pageCount < FINANCE_INSIGHT_OCCURRENCE_SNAPSHOT_PAGE_LIMIT;
      pageCount++
    ) {
      const page = await this.listOccurrences({ ...parsed, cursor }, signal);
      const pageOccurrenceIds = new Set<string>();
      if (items.length + page.items.length > MAX_OCCURRENCE_SNAPSHOT_ITEMS) {
        throw new TyrionFinanceInsightError(
          'page_too_large',
          'Tyrion finance insight occurrence snapshot is invalid',
          false,
        );
      }
      for (const item of page.items) {
        if (
          occurrenceIds.has(item.occurrenceId)
          || pageOccurrenceIds.has(item.occurrenceId)
        ) {
          throw new TyrionFinanceInsightError(
            'page_too_large',
            'Tyrion finance insight occurrence snapshot is invalid',
            false,
          );
        }
        pageOccurrenceIds.add(item.occurrenceId);
        items.push(item);
        occurrenceIds.add(item.occurrenceId);
      }
      if (page.nextCursor === null) return items;
      if (cursors.has(page.nextCursor)) {
        throw new TyrionFinanceInsightError(
          'invalid_cursor',
          'Tyrion finance insight occurrence cursor is invalid',
          false,
        );
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw new TyrionFinanceInsightError(
      'page_too_large',
      'Tyrion finance insight occurrence snapshot is invalid',
      false,
    );
  }

  async getOccurrence(
    occurrenceId: string,
    expectedConnectorRef: string,
    signal?: AbortSignal,
  ): Promise<InsightOccurrenceDetailV1> {
    const parsed = occurrenceIdSchema.safeParse(occurrenceId);
    const connectorRef = sourceReferenceSchema.safeParse(expectedConnectorRef);
    if (!parsed.success || !connectorRef.success) {
      throw new TyrionFinanceInsightError(
        'invalid_request',
        'Tyrion finance insight occurrence identifier is invalid',
        false,
      );
    }
    const result = await this.request(
      `${OCCURRENCES_PATH}/${encodeURIComponent(parsed.data)}`,
      'GET',
      null,
      null,
      insightOccurrenceDetailSchema,
      200,
      signal,
    );
    if (
      result.occurrenceId !== parsed.data
      || result.provenance.connectorRef !== connectorRef.data
    ) {
      throw new TyrionFinanceInsightError(
        'invalid_finance_insight_contract',
        'Tyrion finance insight response is invalid',
        false,
        200,
      );
    }
    return result;
  }

  applyOccurrenceAction(
    request: OccurrenceActionRequestV1,
    signal?: AbortSignal,
  ): Promise<OccurrenceActionResultV1> {
    return this.request(
      `${OCCURRENCES_PATH}/${encodeURIComponent(request.occurrenceId)}/actions`,
      'POST',
      request,
      occurrenceActionRequestSchema,
      occurrenceActionResultSchema,
      200,
      signal,
    );
  }

  private async request<Request, Result>(
    path: string,
    method: 'GET' | 'POST' | 'PUT',
    request: Request | null,
    requestSchema: JsonSchema<Request> | null,
    responseSchema: JsonSchema<Result>,
    expectedStatus: number,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (!this.config.shadowIngestEnabled) {
      throw new TyrionFinanceInsightError(
        'insight_shadow_ingest_disabled',
        'Tyrion finance insight shadow ingestion is disabled',
        false,
      );
    }
    let body: string | undefined;
    if (requestSchema && request !== null) {
      let parsedRequest: Request;
      try {
        parsedRequest = requestSchema.parse(request);
      } catch {
        throw new TyrionFinanceInsightError(
          'invalid_request',
          'Tyrion finance insight request is invalid',
          false,
        );
      }
      body = JSON.stringify(parsedRequest);
      if (new TextEncoder().encode(body).byteLength > FINANCE_INSIGHT_MAX_REQUEST_BYTES) {
        throw new TyrionFinanceInsightError(
          'payload_too_large',
          'Tyrion finance insight request exceeds the size limit',
          false,
        );
      }
    }

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const timeoutSignal = AbortSignal.timeout(this.config.timeoutMs);
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      let response: Response | null = null;
      let responseText = '';
      try {
        response = await this.fetchImplementation(
          `${PRIVATE_TYRION_FINANCE_INSIGHT_ORIGIN}${path}`,
          {
            method,
            headers: createTyrionFinanceInsightHeaders(this.config),
            ...(body === undefined ? {} : { body }),
            cache: 'no-store',
            redirect: 'error',
            signal: requestSignal,
          },
        );
        responseText = await readBoundedResponse(response);
      } catch (error) {
        if (error instanceof TyrionFinanceInsightError) throw error;
        if (signal?.aborted) {
          throw signal.reason instanceof Error ? signal.reason : new Error('Sync cancelled');
        }
        if (attempt < this.config.maxRetries) {
          await wait(financeInsightRetryDelayMs(null, attempt), signal);
          continue;
        }
        throw new TyrionFinanceInsightError(
          timeoutSignal.aborted ? 'insight_timeout' : 'insight_source_unavailable',
          timeoutSignal.aborted
            ? 'Tyrion finance insight request timed out'
            : 'Tyrion finance insight service is unavailable',
          true,
        );
      }

      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim();
      let responseBody: unknown = null;
      if (contentType === 'application/json') {
        try {
          responseBody = JSON.parse(responseText);
        } catch {
          responseBody = null;
        }
      }
      if (response.status !== expectedStatus) {
        const code = sanitizedErrorCode(response.status, responseBody);
        if (isRetryableStatus(response.status) && attempt < this.config.maxRetries) {
          await wait(financeInsightRetryDelayMs(response, attempt), signal);
          continue;
        }
        throw new TyrionFinanceInsightError(
          code,
          `Tyrion finance insight request failed (${code})`,
          isRetryableStatus(response.status),
          response.status,
        );
      }
      try {
        return responseSchema.parse(responseBody);
      } catch {
        throw new TyrionFinanceInsightError(
          'invalid_finance_insight_contract',
          'Tyrion finance insight response is invalid',
          false,
          response.status,
        );
      }
    }
    throw new TyrionFinanceInsightError(
      'insight_source_unavailable',
      'Tyrion finance insight service is unavailable',
      true,
    );
  }
}
