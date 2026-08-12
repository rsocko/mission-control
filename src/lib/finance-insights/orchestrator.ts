import 'server-only';

import { sqlite } from '@/db';
import type { ConnectorConfig } from '@/types';
import logger from '@/lib/logger';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import {
  FINANCE_INSIGHT_FACT_KINDS,
  FINANCE_INSIGHT_OCCURRENCE_SNAPSHOT_PAGE_LIMIT,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  defaultOccurrenceListQueryV1,
  evaluationRequestSchema,
  insightOccurrenceSummarySchema,
  type EvaluationRequestV1,
  type EvaluationResultV1,
  type OccurrenceListQueryV1,
  type OccurrenceListResponseV1,
  type SourceBatchReceiptV1,
  type SourceFactBatchV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
  type SourceGenerationResultV1,
} from './contract';
import {
  TyrionFinanceInsightClient,
  TyrionFinanceInsightError,
  resolveTyrionFinanceInsightConfig,
} from './client';
import {
  loadFinanceInsightPublication,
} from './publication';
import {
  FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT,
  replaceFinanceInsightOccurrenceCache,
} from './occurrence-cache';
import { isFinanceInsightDeliveryEnabled } from './cutover';
import { ingestFinanceInsightNotifications } from './notification-ingestion';
import { FINANCE_PROVIDER_ALIASES } from './provider';

type FinanceInsightClient = {
  createSourceGeneration(
    request: SourceGenerationCreateRequestV1,
    signal?: AbortSignal,
  ): Promise<SourceGenerationResultV1>;
  putSourceFactBatch(
    request: SourceFactBatchV1,
    signal?: AbortSignal,
  ): Promise<SourceBatchReceiptV1>;
  commitSourceGeneration(
    request: SourceGenerationCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<SourceGenerationResultV1>;
  retryEvaluation(
    request: EvaluationRequestV1,
    signal?: AbortSignal,
  ): Promise<EvaluationResultV1>;
  listOccurrences(
    query: OccurrenceListQueryV1,
    signal?: AbortSignal,
  ): Promise<OccurrenceListResponseV1>;
};

export type FinanceInsightIngestionResult =
  | { status: 'disabled' }
  | { status: 'pending'; evaluationState: 'queued' | 'evaluating' }
  | {
      status: 'completed';
      itemCount: number;
      notificationsProcessed: number;
      notificationsAdded: number;
    }
  | { status: 'failed'; code: string; retryable: boolean };

type DeliveryState = {
  stage: 'captured' | 'staging' | 'uploading' | 'committed' | 'evaluation-requested';
  nextBatchOrdinal: number;
  detectorSetVersion: string | null;
  policyVersion: number | null;
  evaluationSequence: number | null;
};

export function isFinanceInsightShadowIngestEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED?.trim().toLowerCase() === 'true';
}

export function findFinanceInsightContinuationPublicationId(
  connectorId: string,
): string | null {
  const pending = sqlite.prepare(`
    SELECT publication_id AS publicationId
    FROM finance_insight_publication_delivery
    WHERE connector_id = ?
      AND (
        evaluation_state IN ('queued', 'evaluating')
        OR last_error_retryable = 1
      )
    ORDER BY source_sequence DESC
    LIMIT 1
  `).get(connectorId) as { publicationId: string } | undefined;
  return pending?.publicationId ?? null;
}

function stableIdentifier(prefix: string, value: CanonicalJsonValue): string {
  return `${prefix}:${financeInsightDigestV1(value).replace('sha256:', '')}`;
}

function assertSingleFinanceConnector(connectorId: string): void {
  const placeholders = FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ');
  const rows = sqlite.prepare(`
    SELECT id FROM connector_configs
    WHERE enabled = 1 AND deleted_at IS NULL
      AND type IN (${placeholders})
    ORDER BY id
    LIMIT 2
  `).all(...FINANCE_PROVIDER_ALIASES) as Array<{ id: string }>;
  if (rows.length !== 1 || rows[0].id !== connectorId) {
    throw new TyrionFinanceInsightError(
      'finance_insight_connector_unavailable',
      'Finance insight connector is unavailable',
      false,
    );
  }
}

function ensureDeliveryState(
  connectorId: string,
  publicationId: string,
  sourceSequence: number,
  now: string,
): DeliveryState {
  sqlite.prepare(`
    INSERT INTO finance_insight_publication_delivery (
      publication_id, connector_id, source_sequence, stage, next_batch_ordinal,
      last_error_retryable, created_at, updated_at
    ) VALUES (?, ?, ?, 'captured', 0, 0, ?, ?)
    ON CONFLICT(publication_id) DO NOTHING
  `).run(publicationId, connectorId, sourceSequence, now, now);
  const state = sqlite.prepare(`
    SELECT stage, next_batch_ordinal AS nextBatchOrdinal,
           detector_set_version AS detectorSetVersion,
           policy_version AS policyVersion,
           evaluation_sequence AS evaluationSequence
    FROM finance_insight_publication_delivery
    WHERE publication_id = ? AND connector_id = ? AND source_sequence = ?
  `).get(publicationId, connectorId, sourceSequence) as DeliveryState | undefined;
  if (!state) {
    throw new TyrionFinanceInsightError(
      'source_generation_conflict',
      'Finance insight source generation conflicts with prior input',
      false,
      409,
    );
  }
  return state;
}

function validateSourceResult(
  result: SourceGenerationResultV1,
  request: SourceGenerationCreateRequestV1,
): void {
  if (
    result.connectorRef !== request.connectorRef
    || result.sourceGeneration !== request.sourceGeneration
    || result.sourceSequence !== request.sourceSequence
  ) {
    throw new TyrionFinanceInsightError(
      'source_generation_conflict',
      'Finance insight source generation conflicts with prior input',
      false,
      409,
    );
  }
}

function orderedBatches(batches: readonly SourceFactBatchV1[]): SourceFactBatchV1[] {
  const kindOrder = new Map(FINANCE_INSIGHT_FACT_KINDS.map((kind, index) => [kind, index]));
  return [...batches].sort((left, right) => (
    kindOrder.get(left.kind)! - kindOrder.get(right.kind)!
    || left.batchIndex - right.batchIndex
  ));
}

function recordFailure(
  publicationId: string,
  code: string,
  retryable: boolean,
  now: string,
): void {
  sqlite.prepare(`
    UPDATE finance_insight_publication_delivery
    SET last_attempt_at = ?, last_error_code = ?, last_error_retryable = ?, updated_at = ?
    WHERE publication_id = ?
  `).run(now, code, retryable ? 1 : 0, now, publicationId);
}

async function refreshOccurrences(input: {
  client: FinanceInsightClient;
  connectorId: string;
  sourceGeneration: string;
  sourceSequence: number;
  sourceAsOf: string;
  detectorSetVersion: string;
  policyVersion: number;
  alertCapable: boolean;
  environment?: Readonly<Record<string, string | undefined>>;
  signal?: AbortSignal;
  now: Date;
}): Promise<{
  itemCount: number;
  notificationsProcessed: number;
  notificationsAdded: number;
}> {
  const baseQuery = {
    ...defaultOccurrenceListQueryV1(),
    connectorRef: input.connectorId,
    sourceLifecycle: ['open', 'resolved', 'superseded'] as const,
    analysisState: ['qualified'] as const,
    limit: 100,
  };
  const items: ReturnType<typeof insightOccurrenceSummarySchema.parse>[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    pageCount++;
    const page = await input.client.listOccurrences({
      ...baseQuery,
      sourceLifecycle: [...baseQuery.sourceLifecycle],
      analysisState: [...baseQuery.analysisState],
      cursor,
    }, input.signal);
    for (const item of page.items) {
      const parsed = insightOccurrenceSummarySchema.parse(item);
      if (
        parsed.provenance.connectorRef !== input.connectorId
        || parsed.provenance.sourceGeneration !== input.sourceGeneration
        || parsed.provenance.sourceAsOf !== input.sourceAsOf
        || parsed.provenance.detectorSetVersion !== input.detectorSetVersion
        || parsed.provenance.policyVersion !== input.policyVersion
      ) {
        throw new TyrionFinanceInsightError(
          'stale_evaluation',
          'Finance insight evaluation is stale',
          false,
          409,
        );
      }
      items.push(parsed);
      if (items.length > FINANCE_INSIGHT_OCCURRENCE_CACHE_LIMIT) {
        throw new TyrionFinanceInsightError(
          'page_too_large',
          'Finance insight page exceeds the allowed size',
          false,
          413,
        );
      }
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (pageCount >= FINANCE_INSIGHT_OCCURRENCE_SNAPSHOT_PAGE_LIMIT) {
        throw new TyrionFinanceInsightError(
          'page_too_large',
          'Finance insight occurrence snapshot is invalid',
          false,
          413,
        );
      }
      if (cursors.has(cursor)) {
        throw new TyrionFinanceInsightError(
          'invalid_cursor',
          'Finance insight cursor is invalid',
          false,
          400,
        );
      }
      cursors.add(cursor);
    }
  } while (cursor !== null);
  if (new Set(items.map((item) => item.occurrenceId)).size !== items.length) {
    throw new TyrionFinanceInsightError(
      'invalid_finance_insight_contract',
      'Tyrion finance insight response is invalid',
      false,
    );
  }
  replaceFinanceInsightOccurrenceCache({
    connectorId: input.connectorId,
    sourceGeneration: input.sourceGeneration,
    sourceSequence: input.sourceSequence,
    sourceAsOf: input.sourceAsOf,
    items,
    now: input.now,
  });
  let notificationsProcessed = 0;
  let notificationsAdded = 0;
  if (input.alertCapable && isFinanceInsightDeliveryEnabled(input.connectorId)) {
    const notificationResults = await ingestFinanceInsightNotifications({
      connectorId: input.connectorId,
      items,
      now: input.now,
      environment: { ...process.env, ...input.environment },
    });
    notificationsProcessed = notificationResults.length;
    notificationsAdded = notificationResults.filter((result) => result.created).length;
  }
  return { itemCount: items.length, notificationsProcessed, notificationsAdded };
}

export async function runFinanceInsightIngestion(input: {
  config: ConnectorConfig;
  publicationId?: string;
  signal?: AbortSignal;
  environment?: Readonly<Record<string, string | undefined>>;
  client?: FinanceInsightClient;
  clock?: () => Date;
}): Promise<FinanceInsightIngestionResult> {
  if (!isFinanceInsightShadowIngestEnabled(input.environment)) {
    return { status: 'disabled' };
  }
  const clock = input.clock ?? (() => new Date());
  const now = clock();
  const nowIso = now.toISOString();
  let publicationId = input.publicationId ?? null;
  try {
    assertSingleFinanceConnector(input.config.id);
    const publication = loadFinanceInsightPublication(
      input.config.id,
      input.publicationId,
      input.clock,
    );
    if (!publication) {
      throw new TyrionFinanceInsightError(
        'finance_insight_publication_unavailable',
        'Finance insight publication is unavailable',
        false,
      );
    }
    publicationId = publication.createRequest.sourceGeneration;
    const client = input.client ?? new TyrionFinanceInsightClient(
      resolveTyrionFinanceInsightConfig(input.config, input.environment),
    );
    let delivery = ensureDeliveryState(
      input.config.id,
      publicationId,
      publication.createRequest.sourceSequence,
      nowIso,
    );
    const sourceResult = await client.createSourceGeneration(
      publication.createRequest,
      input.signal,
    );
    validateSourceResult(sourceResult, publication.createRequest);
    if (sourceResult.state === 'historical') {
      throw new TyrionFinanceInsightError(
        'stale_source_generation',
        'Finance insight source generation is stale',
        false,
        409,
      );
    }

    let detectorSetVersion = sourceResult.detectorSetVersion;
    let policyVersion = sourceResult.policyVersion;
    if (sourceResult.state === 'staging') {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = 'staging', last_attempt_at = ?, last_error_code = NULL,
            last_error_retryable = 0, updated_at = ?
        WHERE publication_id = ?
      `).run(nowIso, nowIso, publicationId);
      const batches = orderedBatches(publication.batches);
      for (let ordinal = delivery.nextBatchOrdinal; ordinal < batches.length; ordinal++) {
        const batch = batches[ordinal];
        const receipt = await client.putSourceFactBatch(batch, input.signal);
        if (
          receipt.sourceGeneration !== batch.sourceGeneration
          || receipt.kind !== batch.kind
          || receipt.batchIndex !== batch.batchIndex
          || receipt.digest !== batch.digest
        ) {
          throw new TyrionFinanceInsightError(
            'source_batch_conflict',
            'Finance insight source batch conflicts with prior input',
            false,
            409,
          );
        }
        sqlite.prepare(`
          UPDATE finance_insight_publication_delivery
          SET stage = 'uploading', next_batch_ordinal = ?,
              last_successful_at = ?, updated_at = ?
          WHERE publication_id = ?
        `).run(ordinal + 1, nowIso, nowIso, publicationId);
      }
      const committed = await client.commitSourceGeneration(
        publication.commitRequest,
        input.signal,
      );
      validateSourceResult(committed, publication.createRequest);
      if (committed.state !== 'promoted') {
        throw new TyrionFinanceInsightError(
          'stale_source_generation',
          'Finance insight source generation is stale',
          false,
          409,
        );
      }
      detectorSetVersion = committed.detectorSetVersion;
      policyVersion = committed.policyVersion;
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = 'committed', detector_set_version = ?, policy_version = ?,
            last_successful_at = ?, last_error_code = NULL,
            last_error_retryable = 0, updated_at = ?
        WHERE publication_id = ?
      `).run(detectorSetVersion, policyVersion, nowIso, nowIso, publicationId);
    } else {
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = 'committed', detector_set_version = ?, policy_version = ?,
            last_successful_at = ?, last_error_code = NULL,
            last_error_retryable = 0, updated_at = ?
        WHERE publication_id = ?
      `).run(detectorSetVersion, policyVersion, nowIso, nowIso, publicationId);
    }
    if (!detectorSetVersion || !policyVersion) {
      throw new TyrionFinanceInsightError(
        'invalid_finance_insight_contract',
        'Tyrion finance insight response is invalid',
        false,
      );
    }
    delivery = ensureDeliveryState(
      input.config.id,
      publicationId,
      publication.createRequest.sourceSequence,
      nowIso,
    );
    const evaluationInput = {
      contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
      connectorRef: input.config.id,
      sourceGeneration: publicationId,
      detectorSetVersion,
      expectedPolicyVersion: policyVersion,
    };
    const evaluationRequest = evaluationRequestSchema.parse({
      ...evaluationInput,
      idempotencyKey: stableIdentifier(
        'finance-evaluation-v1',
        evaluationInput as CanonicalJsonValue,
      ),
    });
    const evaluation = await client.retryEvaluation(evaluationRequest, input.signal);
    if (
      evaluation.identity.connectorRef !== input.config.id
      || evaluation.identity.sourceGeneration !== publicationId
      || evaluation.identity.detectorSetVersion !== detectorSetVersion
      || evaluation.identity.policyVersion !== policyVersion
      || evaluation.sourceSequence !== publication.createRequest.sourceSequence
    ) {
      throw new TyrionFinanceInsightError(
        'stale_evaluation',
        'Finance insight evaluation is stale',
        false,
        409,
      );
    }
    const maximumEvaluation = sqlite.prepare(`
      SELECT MAX(evaluation_sequence) AS sequence
      FROM finance_insight_publication_delivery
      WHERE connector_id = ? AND publication_id <> ?
    `).get(input.config.id, publicationId) as { sequence: number | null };
    if (
      maximumEvaluation.sequence !== null
      && evaluation.evaluationSequence <= maximumEvaluation.sequence
    ) {
      throw new TyrionFinanceInsightError(
        'stale_evaluation',
        'Finance insight evaluation is stale',
        false,
        409,
      );
    }
    if (
      delivery.evaluationSequence !== null
      && evaluation.evaluationSequence !== delivery.evaluationSequence
    ) {
      throw new TyrionFinanceInsightError(
        'stale_evaluation',
        'Finance insight evaluation is stale',
        false,
        409,
      );
    }
    if (evaluation.state === 'failed' || evaluation.state === 'unavailable') {
      const code = `finance_insight_evaluation_${evaluation.state}`;
      const retryable = evaluation.state === 'unavailable';
      sqlite.prepare(`
        UPDATE finance_insight_publication_delivery
        SET stage = 'evaluation-requested', evaluation_sequence = ?,
            evaluation_state = ?, evaluation_idempotency_key = ?,
            last_attempt_at = ?, last_error_code = ?,
            last_error_retryable = ?, updated_at = ?
        WHERE publication_id = ?
      `).run(
        evaluation.evaluationSequence,
        evaluation.state,
        evaluationRequest.idempotencyKey,
        nowIso,
        code,
        retryable ? 1 : 0,
        nowIso,
        publicationId,
      );
      return { status: 'failed', code, retryable };
    }
    sqlite.prepare(`
      UPDATE finance_insight_publication_delivery
      SET stage = 'evaluation-requested', evaluation_sequence = ?,
          evaluation_state = ?, evaluation_idempotency_key = ?,
          last_attempt_at = ?, last_successful_at = ?, last_error_code = NULL,
          last_error_retryable = 0, updated_at = ?
      WHERE publication_id = ?
    `).run(
      evaluation.evaluationSequence,
      evaluation.state,
      evaluationRequest.idempotencyKey,
      nowIso,
      nowIso,
      nowIso,
      publicationId,
    );
    if (evaluation.state === 'queued' || evaluation.state === 'evaluating') {
      return { status: 'pending', evaluationState: evaluation.state };
    }
    const refreshed = await refreshOccurrences({
      client,
      connectorId: input.config.id,
      sourceGeneration: publicationId,
      sourceSequence: publication.createRequest.sourceSequence,
      sourceAsOf: publication.createRequest.sourceAsOf,
      detectorSetVersion,
      policyVersion,
      alertCapable: publication.alertCapable,
      environment: input.environment,
      signal: input.signal,
      now,
    });
    return { status: 'completed', ...refreshed };
  } catch (error) {
    const normalized = error instanceof TyrionFinanceInsightError
      ? error
      : new TyrionFinanceInsightError(
        'finance_insight_ingestion_failed',
        'Finance insight ingestion failed',
        true,
      );
    if (publicationId) {
      try {
        recordFailure(publicationId, normalized.code, normalized.retryable, nowIso);
      } catch {
        logger.warn(
          { code: 'finance_insight_delivery_state_unavailable' },
          'Finance insight delivery state could not be recorded',
        );
      }
    }
    return { status: 'failed', code: normalized.code, retryable: normalized.retryable };
  }
}
