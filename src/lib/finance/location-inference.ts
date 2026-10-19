import 'server-only';

import { generateObject } from 'ai';
import { z } from 'zod';
import type {
  FinanceLocationEvidenceCacheEntry,
  FinanceSnapshotPersistence,
  FinanceSnapshotTransaction,
} from '@/db/persistence/finance-snapshot';
import { getAsyncAIModel } from '@/lib/ai/provider-runtime';
import type { MonarchTransaction } from '@/lib/connectors/monarch-money/client';
import {
  resolveTyrionQuickReviewToken,
  TyrionFinanceReviewClient,
} from '@/lib/connectors/monarch-money/quick-review-client';
import type { ConnectorConfig } from '@/types';
import {
  attributionStatementDescriptors,
  descriptorEvidenceFingerprint,
  normalizedLocationEvidenceSchema,
  type NormalizedLocationEvidence,
} from './transaction-evidence';

const MAX_CONCURRENCY = 4;
const MAX_INFERENCES_PER_PAGE = 16;
const MINIMUM_CONFIDENCE = 0.55;
const STALE_AFTER_DAYS = 90;

const inferenceOutputSchema = z.object({
  countryCode: z.string().regex(/^[A-Za-z]{2}$/).nullable(),
  region: z.string().trim().min(1).max(80).nullable(),
  locality: z.string().trim().min(1).max(80).nullable(),
  confidence: z.number().min(0).max(1),
  evidence: z.string().trim().min(1).max(240),
}).strict();

export interface LocationInferenceResult {
  evidence: NormalizedLocationEvidence | null;
  inferenceEvidence: string | null;
  errorCode: 'location_inference_unavailable'
    | 'location_inference_uncertain'
    | 'location_inference_invalid'
    | null;
}

type InferLocation = (
  transaction: MonarchTransaction,
  requestedAt: Date,
  signal?: AbortSignal,
) => Promise<LocationInferenceResult>;

function fresh(evidence: NormalizedLocationEvidence | null, now: Date): boolean {
  return evidence !== null && Date.parse(evidence.staleAfter) > now.getTime();
}

type EnrichedMonarchTransaction = MonarchTransaction & Pick<
  FinanceSnapshotTransaction,
  | 'locationEvidence'
  | 'locationEvidenceInputFingerprint'
  | 'locationInferenceEvidence'
  | 'locationInferenceErrorCode'
>;

function snapshotTransaction(
  transaction: MonarchTransaction,
  inputFingerprint: string | null,
  result: LocationInferenceResult,
): EnrichedMonarchTransaction {
  return {
    ...transaction,
    locationEvidenceInputFingerprint: inputFingerprint,
    locationEvidence: result.evidence,
    locationInferenceEvidence: result.inferenceEvidence,
    locationInferenceErrorCode: result.errorCode,
  };
}

export async function inferTransactionLocation(
  config: ConnectorConfig,
  transaction: MonarchTransaction,
  requestedAt: Date,
  signal?: AbortSignal,
): Promise<LocationInferenceResult> {
  try {
    const descriptors = attributionStatementDescriptors(transaction.statementDescriptors);
    const envelope = await new TyrionFinanceReviewClient(
      resolveTyrionQuickReviewToken(config),
    ).prepareDescriptorInference({
      contractVersion: '1.0',
      statementDescriptors: descriptors,
    }, signal);
    const route = await getAsyncAIModel('finance-location-inference', {
      sources: ['monarch-money'],
      sensitivityOverride: 'restricted',
    });
    const response = await generateObject({
      model: route.model,
      schema: inferenceOutputSchema,
      system: `Infer only coarse transaction geography from statement descriptor evidence.
Return an ISO 3166-1 alpha-2 country code, a normalized state/province/region, and an optional locality.
Do not use public web search. Do not infer an exact street address. If the evidence is ambiguous, return null countryCode and region with low confidence.
The evidence summary must be concise and must cite only text present in the supplied descriptors.`,
      prompt: JSON.stringify(envelope),
      maxOutputTokens: 300,
      maxRetries: 1,
      abortSignal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
        : AbortSignal.timeout(15_000),
    });
    const output = response.object;
    if (
      !output.countryCode
      || !output.region
      || output.confidence < MINIMUM_CONFIDENCE
    ) {
      return {
        evidence: null,
        inferenceEvidence: output.evidence,
        errorCode: 'location_inference_uncertain',
      };
    }
    const evaluatedAt = requestedAt.toISOString();
    const staleAfter = new Date(
      requestedAt.getTime() + STALE_AFTER_DAYS * 24 * 60 * 60_000,
    ).toISOString();
    const parsed = normalizedLocationEvidenceSchema.safeParse({
      countryCode: output.countryCode.toUpperCase(),
      region: output.region.toUpperCase(),
      locality: output.locality,
      confidence: output.confidence,
      sourceKind: 'private-ai-inference',
      model: route.configured.model,
      modelVersion: `provider:${route.configured.provider}`,
      evaluatedAt,
      staleAfter,
    });
    if (!parsed.success) {
      return {
        evidence: null,
        inferenceEvidence: output.evidence,
        errorCode: 'location_inference_invalid',
      };
    }
    return {
      evidence: parsed.data,
      inferenceEvidence: output.evidence,
      errorCode: null,
    };
  } catch {
    return {
      evidence: null,
      inferenceEvidence: null,
      errorCode: 'location_inference_unavailable',
    };
  }
}

export async function enrichTransactionsWithLocationEvidence(input: {
  connectorId: string;
  config: ConnectorConfig;
  transactions: readonly MonarchTransaction[];
  persistence: FinanceSnapshotPersistence;
  now?: Date;
  signal?: AbortSignal;
  infer?: InferLocation;
}): Promise<EnrichedMonarchTransaction[]> {
  const now = input.now ?? new Date();
  const prior = await input.persistence.readLocationEvidence(
    input.connectorId,
    input.transactions.map((transaction) => transaction.id),
  );
  const results = new Array<EnrichedMonarchTransaction>(input.transactions.length);
  const infer = input.infer ?? (
    (transaction, requestedAt, signal) => inferTransactionLocation(
      input.config,
      transaction,
      requestedAt,
      signal,
    )
  );
  const candidates: Array<{
    index: number;
    transaction: MonarchTransaction;
    fingerprint: string;
    existing: FinanceLocationEvidenceCacheEntry | undefined;
    priority: number;
  }> = [];
  for (const [index, transaction] of input.transactions.entries()) {
    const fingerprint = transaction.statementDescriptors.length
      ? descriptorEvidenceFingerprint(transaction.statementDescriptors)
      : null;
    const existing = prior.get(transaction.id);
    if (
      fingerprint !== null
      && existing?.inputFingerprint === fingerprint
      && fresh(existing.evidence, now)
    ) {
      results[index] = snapshotTransaction(transaction, fingerprint, {
        evidence: existing.evidence,
        inferenceEvidence: existing.inferenceEvidence,
        errorCode: existing.errorCode as LocationInferenceResult['errorCode'],
      });
      continue;
    }
    if (fingerprint === null) {
      results[index] = snapshotTransaction(transaction, null, {
        evidence: null,
        inferenceEvidence: null,
        errorCode: null,
      });
      continue;
    }
    candidates.push({
      index,
      transaction,
      fingerprint,
      existing,
      priority: existing?.inputFingerprint !== fingerprint
        ? 0
        : existing.evidence
          ? 1
          : 2,
    });
  }
  candidates.sort((left, right) => left.priority - right.priority || left.index - right.index);
  const selected = candidates.slice(0, MAX_INFERENCES_PER_PAGE);
  for (const candidate of candidates.slice(MAX_INFERENCES_PER_PAGE)) {
    const matchingPrior = candidate.existing?.inputFingerprint === candidate.fingerprint;
    results[candidate.index] = snapshotTransaction(
      candidate.transaction,
      matchingPrior ? candidate.fingerprint : null,
      {
        evidence: matchingPrior ? candidate.existing?.evidence ?? null : null,
        inferenceEvidence: matchingPrior ? candidate.existing?.inferenceEvidence ?? null : null,
        errorCode: matchingPrior
          ? candidate.existing?.errorCode as LocationInferenceResult['errorCode']
          : 'location_inference_unavailable',
      },
    );
  }
  let next = 0;
  const worker = async () => {
    while (next < selected.length) {
      const candidate = selected[next++];
      const inferred = await infer(candidate.transaction, now, input.signal);
      const preserved = inferred.evidence === null
        && candidate.existing?.inputFingerprint === candidate.fingerprint
        && candidate.existing.evidence
        ? { ...inferred, evidence: candidate.existing.evidence }
        : inferred;
      results[candidate.index] = snapshotTransaction(
        candidate.transaction,
        candidate.fingerprint,
        preserved,
      );
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(MAX_CONCURRENCY, selected.length) },
    () => worker(),
  ));
  return results;
}
