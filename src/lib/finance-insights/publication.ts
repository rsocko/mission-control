import 'server-only';

import {
  buildFinanceInsightHistoryWindows,
  financeInsightHistoryGenerationRef,
  FINANCE_INSIGHT_HISTORY_MONTHS,
} from '@/lib/connectors/monarch-money/finance-insight-history-sync';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import { createFinanceIdentityNamespace } from '@/lib/connectors/monarch-money/identity';
import logger from '@/lib/logger';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { ConnectorConfig, DomainSyncResult } from '@/types';
import { financeInsightDigestV1, type CanonicalJsonValue } from './canonical';
import {
  FINANCE_INSIGHT_BATCH_SIZE,
  FINANCE_INSIGHT_FACT_KINDS,
  FINANCE_INSIGHT_ITEM_LIMITS,
  FINANCE_INSIGHT_MAX_REQUEST_BYTES,
  FINANCE_INSIGHTS_CONTRACT_VERSION,
  accountSourceFactSchema,
  categorySourceFactSchema,
  currencySchema,
  recurringSourceFactSchema,
  sourceFactBatchSchema,
  sourceGenerationCommitRequestSchema,
  sourceGenerationCreateRequestSchema,
  tagSourceFactSchema,
  transactionSourceFactSchema,
  type SourceFactBatchV1,
  type SourceFactKindV1,
  type TransactionSourceFactV1,
  type RecurringSourceFactV1,
  type CategorySourceFactV1,
  type AccountSourceFactV1,
  type TagSourceFactV1,
  type SourceGenerationCommitRequestV1,
  type SourceGenerationCreateRequestV1,
} from './contract';
import { normalizeFinanceProviderAlias } from './provider';
import { validateFinanceConnectorScopedReference } from '@/lib/connectors/monarch-money/identity';

export const FINANCE_INSIGHT_PUBLICATION_CACHE_COUNT = 3;
export const FINANCE_INSIGHT_PUBLICATION_FALLBACK_MS = 7 * 24 * 60 * 60 * 1_000;
export const FINANCE_INSIGHT_ALERT_MAX_AGE_MS = 48 * 60 * 60 * 1_000;

type SourceFact = SourceFactBatchV1['facts'][number];
type ProjectionFacts = {
  transaction: TransactionSourceFactV1[];
  recurring: RecurringSourceFactV1[];
  category: CategorySourceFactV1[];
  account: AccountSourceFactV1[];
  tag: TagSourceFactV1[];
};
type SourceFactBatches = Record<SourceFactKindV1, SourceFact[][]>;
type CaptureResult =
  | { status: 'captured' | 'idempotent'; publicationId: string; sourceSequence: number }
  | { status: 'refused' | 'failed'; code: string };

type TransactionWindowProof = {
  index: number;
  start: string;
  end: string;
  sourceAsOf: string;
  itemCount: number;
  digest: string;
};

type PreparedPublication = {
  generationIdentity: string;
  requestWithoutSequence: Omit<
    SourceGenerationCreateRequestV1,
    'sourceGeneration' | 'sourceSequence' | 'idempotencyKey'
  >;
  facts: ProjectionFacts;
  batches: SourceFactBatches;
};

function stableIdentifier(prefix: string, digest: string): string {
  return `${prefix}:${digest.replace('sha256:', '')}`;
}

const publicationIdPlaceholder = stableIdentifier(
  'finance-publication-v1',
  `sha256:${'0'.repeat(64)}`,
);

function sourceFactBatchValue(
  sourceGeneration: string,
  kind: SourceFactKindV1,
  batchIndex: number,
  facts: SourceFact[],
) {
  const digest = financeInsightDigestV1(facts as CanonicalJsonValue);
  const input = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    sourceGeneration,
    kind,
    batchIndex,
    facts,
    digest,
  };
  return {
    ...input,
    idempotencyKey: stableIdentifier(
      `finance-batch-v1:${kind}:${batchIndex}`,
      financeInsightDigestV1(input as CanonicalJsonValue),
    ),
  };
}

function batchRequestBytes(
  kind: SourceFactKindV1,
  batchIndex: number,
  facts: SourceFact[],
): number {
  return new TextEncoder().encode(JSON.stringify(
    sourceFactBatchValue(publicationIdPlaceholder, kind, batchIndex, facts),
  )).byteLength;
}

function partitionFacts(
  kind: SourceFactKindV1,
  facts: SourceFact[],
): SourceFact[][] {
  const batches: SourceFact[][] = [];
  let current: SourceFact[] = [];
  for (const fact of facts) {
    const candidate = [...current, fact];
    if (
      candidate.length > FINANCE_INSIGHT_BATCH_SIZE
      || batchRequestBytes(kind, batches.length, candidate) > FINANCE_INSIGHT_MAX_REQUEST_BYTES
    ) {
      if (current.length === 0) throw new Error('single_fact_exceeds_batch_limit');
      batches.push(current);
      current = [fact];
      if (
        batchRequestBytes(kind, batches.length, current)
        > FINANCE_INSIGHT_MAX_REQUEST_BYTES
      ) {
        throw new Error('single_fact_exceeds_batch_limit');
      }
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export async function loadFinanceInsightPublicationProjectionFacts(
  connectorId: string,
  transactionGenerationId: string,
): Promise<ProjectionFacts> {
  const scoped = (kind: string, value: string | null): string | null => (
    validateFinanceConnectorScopedReference(kind, value)
  );
  const { finance } = await getWorkerPersistenceRepositories();
  const rawTransactionFacts = await finance.insights.projection.readPromotedTransactionFacts(
    connectorId,
    transactionGenerationId,
  );
  const transaction = rawTransactionFacts.map((payload) => {
    const fact = transactionSourceFactSchema.parse(payload);
    return transactionSourceFactSchema.parse({
      ...fact,
      sourceRef: scoped('transaction', fact.sourceRef),
      categoryRef: scoped('category', fact.categoryRef),
      accountRef: scoped('account', fact.accountRef),
      recurringRef: scoped('recurring', fact.recurringRef),
      tagRefs: fact.tagRefs.map((value) => scoped('tag', value)!),
    });
  });
  const [recurring, category, account, tag] = await Promise.all([
    finance.insights.projection.readOperationalProjectionFacts(connectorId, '', 'recurring'),
    finance.insights.projection.readOperationalProjectionFacts(connectorId, '', 'category'),
    finance.insights.projection.readOperationalProjectionFacts(connectorId, '', 'account'),
    finance.insights.projection.readOperationalProjectionFacts(connectorId, '', 'tag'),
  ]);
  return {
    transaction,
    recurring: recurring.recurring,
    category: category.category,
    account: account.account,
    tag: tag.tag,
  };
}

async function preparePublication(
  config: ConnectorConfig,
  syncResult: DomainSyncResult,
  now: Date,
): Promise<PreparedPublication | { code: string }> {
  const providerType = normalizeFinanceProviderAlias(config.type);
  if (!providerType) return { code: 'unsupported_finance_provider' };
  if (syncResult.status !== 'fresh' || Object.keys(syncResult.datasetErrors ?? {}).length > 0) {
    return { code: 'partial_projection' };
  }
  const currency = currencySchema.safeParse(
    (config.settings as Record<string, unknown> | undefined)?.householdCurrency,
  );
  if (!currency.success) {
    return { code: 'household_currency_unavailable' };
  }
  const { finance } = await getWorkerPersistenceRepositories();
  await finance.identity.ensureNamespace({
    connectorId: config.id,
    candidate: createFinanceIdentityNamespace(),
    updatedAt: now.toISOString(),
  });
  const transactionState = await finance.insights.projection.readState(config.id);
  const transactionSuccessfulAt = Date.parse(transactionState?.lastSuccessfulAt ?? '');
  const transactionSourceAsOf = Date.parse(transactionState?.sourceAsOf ?? '');
  if (
    !transactionState
    || transactionState.status !== 'succeeded'
    || !transactionState.generationId
    || !transactionState.lastSuccessfulAt
    || !transactionState.sourceAsOf
    || transactionState.itemCount === null
    || !transactionState.contentDigest
    || !transactionState.coverageStart
    || !transactionState.coverageEnd
    || transactionState.windowCount !== FINANCE_INSIGHT_HISTORY_MONTHS
    || !transactionState.windowsDigest
    || transactionState.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
    || !Number.isFinite(transactionSuccessfulAt)
    || !Number.isFinite(transactionSourceAsOf)
    || transactionSuccessfulAt > now.getTime()
    || transactionSourceAsOf > now.getTime()
    || now.getTime() - transactionSourceAsOf > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
  ) {
    return { code: 'transaction_projection_unavailable' };
  }
  const requiredDatasets = new Map<SourceFactKindV1, string>([
    ['recurring', 'recurring'],
    ['category', 'categories'],
    ['account', 'accounts'],
    ['tag', 'tags'],
  ]);
  const datasetRows = await finance.insights.projection.readDatasetInsightState(config.id);
  const byDataset = new Map(datasetRows.map((row) => [row.dataset, row]));
  for (const dataset of requiredDatasets.values()) {
    const row = byDataset.get(dataset);
    const sourceAsOf = Date.parse(row?.sourceAsOf ?? '');
    const freshUntil = Date.parse(row?.freshUntil ?? '');
    if (
      !row
      || row.outcome !== 'succeeded'
      || !row.generationId
      || !row.sourceAsOf
      || !row.freshUntil
      || row.itemCount === null
      || !row.contentDigest
      || row.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
      || !Number.isFinite(sourceAsOf)
      || !Number.isFinite(freshUntil)
      || sourceAsOf > now.getTime()
      || freshUntil < now.getTime()
    ) {
      return { code: `${dataset}_projection_unavailable` };
    }
  }
  let facts: ProjectionFacts;
  let batches: SourceFactBatches;
  try {
    facts = await loadFinanceInsightPublicationProjectionFacts(
      config.id,
      transactionState.generationId,
    );
    const validators = {
      transaction: transactionSourceFactSchema,
      recurring: recurringSourceFactSchema,
      category: categorySourceFactSchema,
      account: accountSourceFactSchema,
      tag: tagSourceFactSchema,
    } as const;
    for (const kind of FINANCE_INSIGHT_FACT_KINDS) {
      if (facts[kind].length > FINANCE_INSIGHT_ITEM_LIMITS[kind]) {
        return { code: `${kind}_generation_too_large` };
      }
      if (facts[kind].some((fact) => !validators[kind].safeParse(fact).success)) {
        return { code: 'invalid_projection_fact' };
      }
    }
    batches = {
      transaction: partitionFacts('transaction', facts.transaction),
      recurring: partitionFacts('recurring', facts.recurring),
      category: partitionFacts('category', facts.category),
      account: partitionFacts('account', facts.account),
      tag: partitionFacts('tag', facts.tag),
    };
  } catch {
    return { code: 'invalid_projection_fact' };
  }
  const factDigests = Object.fromEntries(
    FINANCE_INSIGHT_FACT_KINDS.map((kind) => [
      kind,
      financeInsightDigestV1(facts[kind] as CanonicalJsonValue),
    ]),
  ) as Record<SourceFactKindV1, string>;
  if (
    facts.transaction.length !== transactionState.itemCount
    || factDigests.transaction !== transactionState.contentDigest
  ) {
    return { code: 'transaction_projection_changed' };
  }
  for (const [kind, datasetName] of requiredDatasets) {
    const proof = byDataset.get(datasetName)!;
    if (
      facts[kind].length !== proof.itemCount
      || factDigests[kind] !== proof.contentDigest
    ) {
      return { code: `${datasetName}_projection_changed` };
    }
  }
  const coverageStart = transactionState.coverageStart;
  const coverageEnd = transactionState.coverageEnd;
  let expectedWindows: ReturnType<typeof buildFinanceInsightHistoryWindows>;
  try {
    expectedWindows = buildFinanceInsightHistoryWindows(coverageEnd);
  } catch {
    return { code: 'transaction_projection_coverage_invalid' };
  }
  const windowProofs: TransactionWindowProof[] = await finance.insights.projection.readWindowProofs(
    config.id,
    transactionState.generationId,
  );
  const expectedWindowShape = expectedWindows.every((expected, index) => {
    const actual = windowProofs[index];
    return actual?.index === expected.index
      && actual.start === expected.start
      && actual.end === expected.end;
  });
  const windowSourceAsOf = windowProofs
    .map((window) => window.sourceAsOf)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const windowTimes = windowProofs.map((window) => Date.parse(window.sourceAsOf));
  const windowFactsValid = windowProofs.every((window) => {
    const values = facts.transaction.filter(
      (fact) => fact.occurredOn >= window.start && fact.occurredOn <= window.end,
    );
    return values.length === window.itemCount
      && financeInsightDigestV1(values as CanonicalJsonValue) === window.digest;
  });
  if (
    coverageStart !== expectedWindows[0]?.start
    || coverageEnd !== now.toISOString().slice(0, 10)
    || windowProofs.length !== FINANCE_INSIGHT_HISTORY_MONTHS
    || !expectedWindowShape
    || !windowFactsValid
    || windowProofs.reduce((sum, window) => sum + window.itemCount, 0) !== facts.transaction.length
    || financeInsightDigestV1(windowProofs as CanonicalJsonValue) !== transactionState.windowsDigest
    || windowSourceAsOf !== transactionState.sourceAsOf
    || windowTimes.some((value) => !Number.isFinite(value) || value > now.getTime())
    || Math.max(...windowTimes) - Math.min(...windowTimes) > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
    || transactionState.generationId !== financeInsightHistoryGenerationRef({
      connectorRef: config.id,
      sourceAsOf: transactionState.sourceAsOf,
      itemCount: transactionState.itemCount,
      contentDigest: transactionState.contentDigest,
      coverageStart,
      coverageEnd,
      windowCount: transactionState.windowCount,
      windowsDigest: transactionState.windowsDigest,
      bridgeContractVersion: transactionState.bridgeContractVersion,
    })
  ) {
    return { code: 'transaction_projection_coverage_invalid' };
  }
  const transactionAsOf = transactionState.sourceAsOf;
  const capturedConstituents = FINANCE_INSIGHT_FACT_KINDS.map((kind) => {
    const datasetName = requiredDatasets.get(kind);
    const dataset = datasetName ? byDataset.get(datasetName)! : null;
    const sourceAsOf = dataset?.sourceAsOf ?? transactionAsOf;
    const generationRef = dataset?.generationId ?? transactionState.generationId!;
    return {
      kind,
      generationRef,
      sourceAsOf,
      itemCount: facts[kind].length,
      digest: factDigests[kind],
    };
  });
  const constituentTimes = capturedConstituents.map((item) => Date.parse(item.sourceAsOf));
  if (
    Math.max(...constituentTimes) - Math.min(...constituentTimes)
    > FINANCE_INSIGHT_ALERT_MAX_AGE_MS
  ) {
    return { code: 'constituent_freshness_skew' };
  }
  const manifest = FINANCE_INSIGHT_FACT_KINDS.map((kind) => {
    return {
      kind,
      batchCount: batches[kind].length,
      itemCount: facts[kind].length,
      digest: financeInsightDigestV1(
        batches[kind].map((batch) => financeInsightDigestV1(batch as CanonicalJsonValue)),
      ),
    };
  });
  const sourceAsOf = [...capturedConstituents]
    .sort((left, right) => Date.parse(left.sourceAsOf) - Date.parse(right.sourceAsOf))[0]!.sourceAsOf;
  const requestWithoutSequence: PreparedPublication['requestWithoutSequence'] = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    connectorRef: config.id,
    sourceAsOf,
    coverageStart,
    coverageEnd,
    currency: currency.data,
    bridgeContractVersion: transactionState.bridgeContractVersion,
    capturedConstituents,
    manifest,
  };
  return {
    generationIdentity: financeInsightDigestV1(requestWithoutSequence as CanonicalJsonValue),
    facts,
    batches,
    requestWithoutSequence,
  };
}

async function recordCaptureOutcome(
  config: ConnectorConfig,
  now: string,
  outcome: 'refused' | 'failed',
  code: string,
): Promise<void> {
  const providerType = normalizeFinanceProviderAlias(config.type) ?? 'finance-manager';
  const { finance } = await getWorkerPersistenceRepositories();
  await finance.insights.publication.recordOutcome({
    connectorId: config.id,
    providerType,
    now,
    outcome,
    code,
  });
}

export async function captureFinanceInsightPublication(
  config: ConnectorConfig,
  syncResult: DomainSyncResult,
  clock: () => Date = () => new Date(),
): Promise<CaptureResult> {
  const now = clock();
  const capturedAt = now.toISOString();
  try {
    const prepared = await preparePublication(config, syncResult, now);
    if ('code' in prepared) {
      await recordCaptureOutcome(config, capturedAt, 'refused', prepared.code);
      return { status: 'refused' as const, code: prepared.code };
    }
    const { finance } = await getWorkerPersistenceRepositories();
    const state = await finance.insights.publication.readCurrentState(config.id);
    const sourceSequence = (state?.sourceSequence ?? 0) + 1;
    const publicationId = stableIdentifier('finance-publication-v1', prepared.generationIdentity);
    const idempotencyKey = stableIdentifier('finance-generation-v1', prepared.generationIdentity);
    const createRequest = sourceGenerationCreateRequestSchema.parse({
      ...prepared.requestWithoutSequence,
      sourceGeneration: publicationId,
      sourceSequence,
      idempotencyKey,
    });
    const manifestDigest = financeInsightDigestV1(createRequest.manifest as CanonicalJsonValue);
    const expiresAt = new Date(now.getTime() + FINANCE_INSIGHT_PUBLICATION_FALLBACK_MS).toISOString();
    const facts: Array<{
      kind: SourceFactKindV1;
      sourceRef: string;
      batchIndex: number;
      factIndex: number;
      payload: unknown;
    }> = [];
    for (const kind of FINANCE_INSIGHT_FACT_KINDS) {
      prepared.batches[kind].forEach((batch, batchIndex) => {
        batch.forEach((fact, factIndex) => {
          facts.push({ kind, sourceRef: fact.sourceRef, batchIndex, factIndex, payload: fact });
        });
      });
    }
    const result = await finance.insights.publication.capture({
      connectorId: config.id,
      providerType: normalizeFinanceProviderAlias(config.type)!,
      capturedAt,
      generationIdentity: prepared.generationIdentity,
      expectedSourceSequence: sourceSequence,
      publicationId,
      idempotencyKey,
      createRequest,
      contractVersion: createRequest.contractVersion,
      sourceAsOf: createRequest.sourceAsOf,
      coverageStart: createRequest.coverageStart,
      coverageEnd: createRequest.coverageEnd,
      currency: createRequest.currency,
      bridgeContractVersion: createRequest.bridgeContractVersion,
      capturedConstituents: createRequest.capturedConstituents,
      manifest: createRequest.manifest,
      manifestDigest,
      expiresAt,
      cacheCount: FINANCE_INSIGHT_PUBLICATION_CACHE_COUNT,
      facts,
    });
    if (result.status === 'conflict') {
      await recordCaptureOutcome(config, capturedAt, 'failed', 'publication_capture_failed');
      return { status: 'failed', code: 'publication_capture_failed' };
    }
    return result;
  } catch {
    try {
      await recordCaptureOutcome(config, capturedAt, 'failed', 'publication_capture_failed');
    } catch {
      logger.warn(
        { code: 'finance_insight_capture_state_unavailable', connectorId: config.id },
        'Finance insight publication capture state could not be recorded',
      );
    }
    return { status: 'failed', code: 'publication_capture_failed' };
  }
}

export async function loadFinanceInsightPublication(
  connectorId: string,
  publicationId?: string,
  clock: () => Date = () => new Date(),
): Promise<{
  createRequest: SourceGenerationCreateRequestV1;
  batches: SourceFactBatchV1[];
  commitRequest: SourceGenerationCommitRequestV1;
  alertCapable: boolean;
  cacheState: 'current' | 'stale-fallback';
} | null> {
  const { finance } = await getWorkerPersistenceRepositories();
  const now = clock();
  const loaded = await finance.insights.publication.loadLatest(
    connectorId,
    publicationId ?? null,
    now.toISOString(),
  );
  if (!loaded) return null;
  const { record, facts } = loaded;
  const createRequest = sourceGenerationCreateRequestSchema.parse(record.createRequest);
  const grouped = new Map<string, SourceFact[]>();
  for (const fact of facts) {
    const key = `${fact.kind}:${fact.batchIndex}`;
    const batch = grouped.get(key) ?? [];
    batch.push(fact.payload as SourceFact);
    grouped.set(key, batch);
  }
  const batches = [...grouped.entries()].map(([key, batch]) => {
    const [kind, batchIndexText] = key.split(':') as [SourceFactKindV1, string];
    const batchIndex = Number(batchIndexText);
    return sourceFactBatchSchema.parse(
      sourceFactBatchValue(record.id, kind, batchIndex, batch),
    );
  });
  const commitInput = {
    contractVersion: FINANCE_INSIGHTS_CONTRACT_VERSION,
    sourceGeneration: record.id,
    expectedSourceSequence: createRequest.sourceSequence,
    manifestDigest: record.manifestDigest,
  };
  const commitRequest = sourceGenerationCommitRequestSchema.parse({
    ...commitInput,
    idempotencyKey: stableIdentifier(
      'finance-commit-v1',
      financeInsightDigestV1(commitInput as CanonicalJsonValue),
    ),
  });
  const alertCapable = record.alertCapable
    && now.getTime() - Date.parse(record.sourceAsOf) <= FINANCE_INSIGHT_ALERT_MAX_AGE_MS;
  return {
    createRequest,
    batches,
    commitRequest,
    alertCapable,
    cacheState: alertCapable ? 'current' : 'stale-fallback',
  };
}
