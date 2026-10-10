import 'server-only';

import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type { FinanceWorkerPersistence } from '@/db/persistence/finance-worker';
import {
  FinanceInsightBackfillDeliveryEnabledError,
  FinanceInsightBackfillPlanUnavailableError,
  FinanceInsightBackfillProjectionConflictError,
  FinanceInsightBackfillTooLargeError,
  FinanceInsightBackfillWindowIncompleteError,
  type FinanceInsightBackfillPlan,
  type FinanceInsightBackfillPromotionCommand,
  type FinanceInsightBackfillWindowProof,
  type FinanceInsightPersistence,
} from '@/db/persistence/finance-insights';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import {
  FINANCE_INSIGHT_ITEM_LIMITS,
} from '@/lib/finance-insights/contract';
import logger from '@/lib/logger';
import type { ConnectorConfig } from '@/types';
import { FinanceAttributionCoordinator } from './attribution-coordinator';
import {
  resolveTyrionHouseholdCurrency,
  TyrionAttributionError,
} from './attribution-client';
import { MonarchBridgeClient, MonarchBridgeError } from './client';
import {
  buildFinanceInsightHistoryWindows,
  financeInsightHistoryGenerationRef,
  FINANCE_INSIGHT_HISTORY_MONTHS,
} from './finance-insight-history-sync';
import {
  MONARCH_BRIDGE_CONTRACT_VERSION,
  MONARCH_TRANSACTION_MAX_BACKFILL_DAYS,
} from './constants';
import { createFinanceIdentityNamespace } from './identity';
import { FinanceInsightProjectionRepairError } from './projection-repair-safety';

export const FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS = 37;
export const FINANCE_INSIGHT_BACKFILL_MAX_WINDOWS_PER_RUN = 4;
const BACKFILL_PAGE_SIZE = 500;
const BACKFILL_MAX_PAGES_PER_WINDOW = 100;

export interface FinanceInsightBackfillWindow {
  ordinal: number;
  start: string;
  end: string;
}

export class FinanceInsightBackfillError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'FinanceInsightBackfillError';
  }
}

type FinanceInsightBackfillStage =
  | 'configuration'
  | 'identity'
  | 'plan'
  | 'safety'
  | 'provider'
  | 'persistence'
  | 'proof'
  | 'promotion';

const UNKNOWN_BACKFILL_ERROR_CODES: Record<
  FinanceInsightBackfillStage,
  string
> = {
  configuration: 'finance_insight_backfill_configuration_failed',
  identity: 'finance_insight_backfill_identity_failed',
  plan: 'finance_insight_backfill_plan_failed',
  safety: 'finance_insight_backfill_safety_check_failed',
  provider: 'finance_insight_backfill_provider_failed',
  persistence: 'finance_insight_backfill_persistence_failed',
  proof: 'finance_insight_backfill_proof_failed',
  promotion: 'finance_insight_backfill_promotion_failed',
};

function dateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function dateValue(value: string): number {
  return Date.parse(`${value}T00:00:00.000Z`);
}

function addDays(value: string, days: number): string {
  const date = new Date(dateValue(value));
  date.setUTCDate(date.getUTCDate() + days);
  return dateOnly(date);
}

function historyCoverageStart(end: string, months: number): string {
  if (months === FINANCE_INSIGHT_HISTORY_MONTHS) {
    return buildFinanceInsightHistoryWindows(end)[0]!.start;
  }
  const endDate = new Date(dateValue(end));
  const targetMonth = endDate.getUTCMonth() - months;
  const firstOfTargetMonth = new Date(Date.UTC(
    endDate.getUTCFullYear(),
    targetMonth,
    1,
  ));
  const lastTargetDay = new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth() + 1,
    0,
  )).getUTCDate();
  const clamped = new Date(Date.UTC(
    firstOfTargetMonth.getUTCFullYear(),
    firstOfTargetMonth.getUTCMonth(),
    Math.min(endDate.getUTCDate(), lastTargetDay),
  ));
  return addDays(dateOnly(clamped), 1);
}

export function planFinanceInsightBackfillWindows(
  coverageEnd: string,
  horizonMonths: number,
): FinanceInsightBackfillWindow[] {
  if (
    !Number.isSafeInteger(horizonMonths)
    || horizonMonths < 1
    || horizonMonths > FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS
    || !Number.isFinite(dateValue(coverageEnd))
    || dateOnly(new Date(dateValue(coverageEnd))) !== coverageEnd
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_request_invalid', 400);
  }
  const coverageStart = historyCoverageStart(coverageEnd, horizonMonths);
  const windows: FinanceInsightBackfillWindow[] = [];
  let start = coverageStart;
  while (start <= coverageEnd) {
    const boundedEnd = addDays(start, MONARCH_TRANSACTION_MAX_BACKFILL_DAYS - 1);
    const end = boundedEnd < coverageEnd ? boundedEnd : coverageEnd;
    windows.push({ ordinal: windows.length, start, end });
    start = addDays(end, 1);
  }
  return windows;
}

async function resolveBackfillCurrency(
  config: ConnectorConfig,
  signal?: AbortSignal,
): Promise<string> {
  try {
    return await resolveTyrionHouseholdCurrency(config, signal);
  } catch (error) {
    if (error instanceof TyrionAttributionError) {
      throw new FinanceInsightBackfillError(error.code, error.status ?? 503);
    }
    throw error;
  }
}

function normalizedBackfillError(
  error: unknown,
  stage: FinanceInsightBackfillStage,
): FinanceInsightBackfillError {
  if (error instanceof FinanceInsightBackfillError) return error;
  if (error instanceof FinanceInsightProjectionRepairError) {
    return new FinanceInsightBackfillError(error.code, error.status);
  }
  if (
    error instanceof FinanceInsightBackfillDeliveryEnabledError
    || error instanceof FinanceInsightBackfillWindowIncompleteError
    || error instanceof FinanceInsightBackfillTooLargeError
    || error instanceof FinanceInsightBackfillPlanUnavailableError
    || error instanceof FinanceInsightBackfillProjectionConflictError
  ) {
    return new FinanceInsightBackfillError(error.code, 409);
  }
  if (error instanceof MonarchBridgeError) {
    return new FinanceInsightBackfillError(error.code, error.status ?? 502);
  }
  const code = UNKNOWN_BACKFILL_ERROR_CODES[stage];
  logger.error(
    { module: 'finance-insight-backfill', stage, code },
    'Finance insight backfill stage failed',
  );
  return new FinanceInsightBackfillError(code, 500);
}

async function runBackfillStage<T>(
  stage: FinanceInsightBackfillStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw normalizedBackfillError(error, stage);
  }
}

async function assertDeliveryDisabled(
  finance: FinanceInsightPersistence,
  connectorId: string,
): Promise<void> {
  await runBackfillStage('persistence', async () => {
    await finance.backfill.assertDeliveryDisabled(connectorId);
  });
}

async function createOrLoadPlan(
  finance: FinanceInsightPersistence,
  input: {
    connectorId: string;
    idempotencyKey: string;
    horizonMonths: number;
    currency: string;
    coverageEnd: string;
    now: string;
  },
): Promise<FinanceInsightBackfillPlan> {
  const windows = planFinanceInsightBackfillWindows(input.coverageEnd, input.horizonMonths);
  const coverageStart = windows[0]!.start;
  const plan = await runBackfillStage('plan', () => finance.backfill.createPlan({
      connectorId: input.connectorId,
      idempotencyKey: input.idempotencyKey,
      horizonMonths: input.horizonMonths,
      currency: input.currency,
      coverageStart,
      coverageEnd: input.coverageEnd,
      bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
      windowCount: windows.length,
      now: input.now,
    }));
  if (
    plan.horizonMonths !== input.horizonMonths
    || plan.currency !== input.currency
    || plan.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_idempotency_conflict', 409);
  }
  return plan;
}

async function verifyProof(
  finance: FinanceInsightPersistence,
  connectorId: string,
  proof: FinanceInsightBackfillWindowProof,
  expected: FinanceInsightBackfillWindow,
  currency: string,
): Promise<void> {
  if (
    proof.windowOrdinal !== expected.ordinal
    || proof.windowStart !== expected.start
    || proof.windowEnd !== expected.end
    || proof.currency !== currency
    || proof.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
  }
  const facts = (await runBackfillStage(
    'proof',
    () => finance.projection.readOperationalProjectionFacts(
      connectorId,
      expected.start,
      'transaction',
      expected.end,
    ),
  )).transaction;
  if (
    facts.length !== proof.itemCount
    || financeInsightDigestV1(facts as unknown as CanonicalJsonValue) !== proof.contentDigest
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_changed', 409);
  }
}

function stableWindowGeneration(
  planId: string,
  window: FinanceInsightBackfillWindow,
): string {
  return `finance-insight-window-v1:${
    financeInsightDigestV1({
      planId,
      ordinal: window.ordinal,
      start: window.start,
      end: window.end,
    }).replace('sha256:', '')
  }`;
}

type ProjectionWindowProof = {
  index: number;
  start: string;
  end: string;
  sourceAsOf: string;
  itemCount: number;
  digest: string;
};

async function buildCompletedPlanPromotion(
  finance: FinanceInsightPersistence,
  connectorId: string,
  plan: FinanceInsightBackfillPlan,
  completedAt: Date,
): Promise<FinanceInsightBackfillPromotionCommand | null> {
  if (plan.horizonMonths !== FINANCE_INSIGHT_HISTORY_MONTHS) return null;
  const operationalProofs = await runBackfillStage(
    'proof',
    () => finance.backfill.loadWindowProofs(plan.id),
  );
  const operationalWindows = planFinanceInsightBackfillWindows(
    plan.coverageEnd,
    plan.horizonMonths,
  );
  if (
    operationalProofs.length !== operationalWindows.length
    || plan.coverageStart !== buildFinanceInsightHistoryWindows(plan.coverageEnd)[0]?.start
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
  }
  for (const [index, proof] of operationalProofs.entries()) {
    await verifyProof(finance, connectorId, proof, operationalWindows[index]!, plan.currency);
  }
  const facts = (await runBackfillStage(
    'proof',
    () => finance.projection.readOperationalProjectionFacts(
      connectorId,
      plan.coverageStart,
      'transaction',
      plan.coverageEnd,
    ),
  )).transaction;
  if (facts.length > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
    throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
  }
  const expectedWindows = buildFinanceInsightHistoryWindows(plan.coverageEnd);
  const windowProofs: ProjectionWindowProof[] = expectedWindows.map((window) => {
    const overlappingProofs = operationalProofs.filter(
      (proof) => proof.windowStart <= window.end && proof.windowEnd >= window.start,
    );
    const sourceAsOf = overlappingProofs
      .map((proof) => proof.sourceAsOf)
      .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
    if (!sourceAsOf) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
    }
    const windowFacts = facts.filter(
      (fact) => fact.occurredOn >= window.start && fact.occurredOn <= window.end,
    );
    return {
      ...window,
      sourceAsOf,
      itemCount: windowFacts.length,
      digest: financeInsightDigestV1(windowFacts as unknown as CanonicalJsonValue),
    };
  });
  const completedTime = completedAt.getTime();
  const sourceTimes = windowProofs.map((proof) => Date.parse(proof.sourceAsOf));
  if (
    sourceTimes.some((value) => !Number.isFinite(value) || value > completedTime)
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_provenance_invalid', 409);
  }
  const sourceAsOf = windowProofs[
    sourceTimes.indexOf(Math.min(...sourceTimes))
  ]!.sourceAsOf;
  const contentDigest = financeInsightDigestV1(facts as unknown as CanonicalJsonValue);
  const windowsDigest = financeInsightDigestV1(windowProofs as CanonicalJsonValue);
  const generationId = financeInsightHistoryGenerationRef({
    connectorRef: connectorId,
    sourceAsOf,
    itemCount: facts.length,
    contentDigest,
    coverageStart: plan.coverageStart,
    coverageEnd: plan.coverageEnd,
    windowCount: windowProofs.length,
    windowsDigest,
    bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
  });
  const completedAtValue = completedAt.toISOString();

  return {
    connectorId,
    planId: plan.id,
    idempotencyKey: plan.idempotencyKey,
    generationId,
    sourceAsOf,
    itemCount: facts.length,
    contentDigest,
    coverageStart: plan.coverageStart,
    coverageEnd: plan.coverageEnd,
    windowCount: windowProofs.length,
    windowsDigest,
    bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
    completedAt: completedAtValue,
    facts,
    windows: windowProofs,
  };
}

async function assertCompletedPlanPromotion(
  finance: FinanceInsightPersistence,
  command: FinanceInsightBackfillPromotionCommand,
): Promise<void> {
  const [state, storedFacts, storedWindows] = await runBackfillStage(
    'proof',
    () => Promise.all([
      finance.projection.readState(command.connectorId),
      finance.projection.readPromotedTransactionFacts(
        command.connectorId,
        command.generationId,
      ),
      finance.projection.readWindowProofs(command.connectorId, command.generationId),
    ]),
  );
  if (
    state?.status !== 'succeeded'
    || state.generationId !== command.generationId
    || state.sourceAsOf !== command.sourceAsOf
    || state.itemCount !== command.itemCount
    || state.contentDigest !== command.contentDigest
    || state.coverageStart !== command.coverageStart
    || state.coverageEnd !== command.coverageEnd
    || state.windowCount !== command.windowCount
    || state.windowsDigest !== command.windowsDigest
    || state.bridgeContractVersion !== command.bridgeContractVersion
    || financeInsightDigestV1(storedFacts as CanonicalJsonValue) !== command.contentDigest
    || financeInsightDigestV1(storedWindows as unknown as CanonicalJsonValue)
      !== command.windowsDigest
  ) {
    throw new FinanceInsightBackfillProjectionConflictError();
  }
}

async function promoteCompletedPlan(
  finance: FinanceInsightPersistence,
  connectorId: string,
  plan: FinanceInsightBackfillPlan,
  completedAt: Date,
): Promise<void> {
  const command = await buildCompletedPlanPromotion(finance, connectorId, plan, completedAt);
  if (!command) return;
  await runBackfillStage(
    'promotion',
    () => finance.backfill.promoteCompletedPlan(command),
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_cancelled', 409);
  }
}

async function captureWindow(input: {
  finance: FinanceWorkerPersistence;
  config: ConnectorConfig;
  plan: FinanceInsightBackfillPlan;
  window: FinanceInsightBackfillWindow;
  projectionOnly?: boolean;
  assertSafe?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<{ added: number; updated: number; itemCount: number }> {
  const connectorId = input.config.id;
  const generationRef = stableWindowGeneration(input.plan.id, input.window);
  const insights = input.finance.insights;
  const client = new MonarchBridgeClient(input.config);
  const attribution = input.projectionOnly
    ? null
    : new FinanceAttributionCoordinator(connectorId, {
        financeConfig: input.config,
        persistence: input.finance,
        generationId: generationRef,
        fenceMode: 'row-generation',
      });
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  let expectedTotal: number | null = null;
  let sourceAsOf: string | null = null;
  let added = 0;
  let updated = 0;
  try {
    for (let pageNumber = 0; pageNumber < BACKFILL_MAX_PAGES_PER_WINDOW; pageNumber++) {
      await runBackfillStage('safety', async () => input.assertSafe?.());
      throwIfAborted(input.signal);
      const page = await runBackfillStage(
        'provider',
        () => client.getTransactionsPage({
          startDate: input.window.start,
          endDate: input.window.end,
          limit: BACKFILL_PAGE_SIZE,
          cursor,
        }, input.signal),
      );
      if (
        page.page.limit > BACKFILL_PAGE_SIZE
        || page.transactions.length > BACKFILL_PAGE_SIZE
        || page.total > FINANCE_INSIGHT_ITEM_LIMITS.transaction
      ) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_limit', 409);
      }
      if (expectedTotal === null) {
        expectedTotal = page.total;
      } else if (page.total !== expectedTotal) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
      }
      for (const transaction of page.transactions) {
        const priorWindowDate = await runBackfillStage(
          'persistence',
          () => insights.backfill.findPriorWindowTransactionDate(
            connectorId,
            input.plan.id,
            transaction.id,
          ),
        );
        if (
          transaction.date < input.window.start
          || transaction.date > input.window.end
          || seenIds.has(transaction.id)
          || (
            priorWindowDate !== null
            && (priorWindowDate < input.window.start || priorWindowDate > input.window.end)
          )
        ) {
          throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
        }
        seenIds.add(transaction.id);
      }
      if (seenIds.size > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
        throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
      }
      if (seenIds.size > expectedTotal) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_page_conflict', 409);
      }
      const fetchedAt = new Date(page.provenance.fetchedAt).toISOString();
      if (sourceAsOf === null || Date.parse(fetchedAt) < Date.parse(sourceAsOf)) {
        sourceAsOf = fetchedAt;
      }
      const counts = await runBackfillStage(
        'persistence',
        () => insights.backfill.upsertTransactionPage({
          connectorId,
          generationRef,
          transactions: page.transactions,
          provenance: { ...page.provenance, fetchedAt },
          now: new Date().toISOString(),
        }),
      );
      added += counts.added;
      updated += counts.updated;
      await attribution?.attributePage(page.transactions, fetchedAt, input.signal);
      if (!page.page.nextCursor) break;
      if (
        seenCursors.has(page.page.nextCursor)
        || pageNumber === BACKFILL_MAX_PAGES_PER_WINDOW - 1
      ) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_pagination_limit', 409);
      }
      seenCursors.add(page.page.nextCursor);
      cursor = page.page.nextCursor;
    }
    if (sourceAsOf === null) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_provenance_invalid', 409);
    }
    if (expectedTotal === null || seenIds.size !== expectedTotal) {
      throw new FinanceInsightBackfillError('finance_insight_backfill_window_incomplete', 409);
    }
    const capturedSourceAsOf = sourceAsOf;
    throwIfAborted(input.signal);
    const completedAt = new Date().toISOString();
    const result = await runBackfillStage(
      'persistence',
      () => insights.backfill.recordWindowCapture({
        connectorId,
        planId: input.plan.id,
        windowOrdinal: input.window.ordinal,
        planWindowCount: input.plan.windowCount,
        windowStart: input.window.start,
        windowEnd: input.window.end,
        generationRef,
        sourceAsOf: capturedSourceAsOf,
        currency: input.plan.currency,
        bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
        completedAt,
        expectedItemCount: seenIds.size,
        maxTotalItemCount: FINANCE_INSIGHT_ITEM_LIMITS.transaction,
      }),
    );
    const itemCount = result.itemCount;
    await runBackfillStage('safety', async () => input.assertSafe?.());
    await runBackfillStage('persistence', async () => attribution?.finish(completedAt));
    return { added, updated, itemCount };
  } catch (error) {
    const normalized = normalizedBackfillError(error, 'persistence');
    try {
      await attribution?.finish(new Date().toISOString());
    } catch (finishError) {
      normalizedBackfillError(finishError, 'persistence');
    }
    throw normalized;
  }
}

type FinanceInsightTransactionBackfillInput = {
  config: ConnectorConfig;
  idempotencyKey: string;
  horizonMonths?: number;
  maxWindows?: number;
  signal?: AbortSignal;
  clock?: () => Date;
};

type FinanceInsightTransactionBackfillResult = {
  planId: string;
  status: 'running' | 'completed';
  completedWindows: number;
  totalWindows: number;
  coverageStart: string;
  coverageEnd: string;
  itemCount: number;
};

async function runTransactionBackfill(
  input: FinanceInsightTransactionBackfillInput & {
    projectionOnly?: boolean;
    assertSafe?: () => Promise<void>;
  },
): Promise<FinanceInsightTransactionBackfillResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const horizonMonths = input.horizonMonths
    ?? FINANCE_INSIGHT_TRANSACTION_HISTORY_MAX_MONTHS;
  const maxWindows = input.maxWindows ?? 1;
  if (
    idempotencyKey.length < 8
    || idempotencyKey.length > 192
    || !Number.isSafeInteger(maxWindows)
    || maxWindows < 1
    || maxWindows > FINANCE_INSIGHT_BACKFILL_MAX_WINDOWS_PER_RUN
  ) {
    throw new FinanceInsightBackfillError('finance_insight_backfill_request_invalid', 400);
  }
  const clock = input.clock ?? (() => new Date());
  const startedAt = clock();
  await runBackfillStage('safety', async () => input.assertSafe?.());
  const repositories = await runBackfillStage(
    'configuration',
    () => getWorkerPersistenceRepositories(),
  );
  await runBackfillStage('configuration', async () => {
    repositories.execution.support.assertConfigSupported(input.config);
  });
  const { finance } = repositories;
  const financeInsights = finance.insights;
  const existingPlan = await runBackfillStage(
    'plan',
    () => financeInsights.backfill.loadPlan(input.config.id, idempotencyKey),
  );
  if (existingPlan?.status === 'completed') {
    try {
      if (
        existingPlan.horizonMonths !== horizonMonths
        || existingPlan.bridgeContractVersion !== MONARCH_BRIDGE_CONTRACT_VERSION
        || existingPlan.nextWindowOrdinal !== existingPlan.windowCount
        || existingPlan.completedAt === null
      ) {
        throw new FinanceInsightBackfillError(
          'finance_insight_backfill_idempotency_conflict',
          409,
        );
      }
      await assertDeliveryDisabled(financeInsights, input.config.id);
      const windows = planFinanceInsightBackfillWindows(
        existingPlan.coverageEnd,
        existingPlan.horizonMonths,
      );
      const proofs = await runBackfillStage(
        'proof',
        () => financeInsights.backfill.loadWindowProofs(existingPlan.id),
      );
      if (
        proofs.length !== existingPlan.windowCount
        || windows.length !== existingPlan.windowCount
      ) {
        throw new FinanceInsightBackfillError(
          'finance_insight_backfill_window_conflict',
          409,
        );
      }
      let totalItemCount = 0;
      for (const [index, proof] of proofs.entries()) {
        await verifyProof(
          financeInsights,
          input.config.id,
          proof,
          windows[index]!,
          existingPlan.currency,
        );
        totalItemCount += proof.itemCount;
      }
      if (totalItemCount > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
        throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
      }
      const command = await buildCompletedPlanPromotion(
        financeInsights,
        input.config.id,
        existingPlan,
        new Date(existingPlan.completedAt),
      );
      if (command) {
        await assertCompletedPlanPromotion(financeInsights, command);
      }
      return {
        planId: existingPlan.id,
        status: 'completed',
        completedWindows: proofs.length,
        totalWindows: existingPlan.windowCount,
        coverageStart: existingPlan.coverageStart,
        coverageEnd: existingPlan.coverageEnd,
        itemCount: totalItemCount,
      };
    } catch (error) {
      throw normalizedBackfillError(error, 'proof');
    }
  }
  const currency = await resolveBackfillCurrency(input.config, input.signal);
  await runBackfillStage(
    'identity',
    () => finance.identity.ensureNamespace({
      connectorId: input.config.id,
      candidate: createFinanceIdentityNamespace(),
      updatedAt: startedAt.toISOString(),
    }),
  );
  const plan = await createOrLoadPlan(financeInsights, {
    connectorId: input.config.id,
    idempotencyKey,
    horizonMonths,
    currency,
    coverageEnd: dateOnly(startedAt),
    now: startedAt.toISOString(),
  });
  try {
    const windows = planFinanceInsightBackfillWindows(plan.coverageEnd, plan.horizonMonths);
    const existingProofs = await runBackfillStage(
      'proof',
      () => financeInsights.backfill.loadWindowProofs(plan.id),
    );
    let totalItemCount = 0;
    for (const [index, proof] of existingProofs.entries()) {
      const expected = windows[index];
      if (!expected || proof.windowOrdinal !== index) {
        throw new FinanceInsightBackfillError('finance_insight_backfill_window_conflict', 409);
      }
      await verifyProof(financeInsights, input.config.id, proof, expected, currency);
      totalItemCount += proof.itemCount;
    }
    if (totalItemCount > FINANCE_INSIGHT_ITEM_LIMITS.transaction) {
      throw new FinanceInsightBackfillError('transaction_generation_too_large', 409);
    }
    let completedWindows = existingProofs.length;
    let remaining = maxWindows;
    while (completedWindows < windows.length && remaining > 0) {
      await runBackfillStage('safety', async () => input.assertSafe?.());
      await assertDeliveryDisabled(financeInsights, input.config.id);
      const result = await captureWindow({
        finance,
        config: input.config,
        plan,
        window: windows[completedWindows]!,
        projectionOnly: input.projectionOnly,
        assertSafe: input.assertSafe,
        signal: input.signal,
      });
      totalItemCount += result.itemCount;
      completedWindows++;
      remaining--;
    }
    if (completedWindows === windows.length) {
      await runBackfillStage('safety', async () => input.assertSafe?.());
      await promoteCompletedPlan(financeInsights, input.config.id, {
        ...plan,
        status: 'completed',
        nextWindowOrdinal: completedWindows,
      }, clock());
    }
    return {
      planId: plan.id,
      status: completedWindows === windows.length ? 'completed' : 'running',
      completedWindows,
      totalWindows: windows.length,
      coverageStart: plan.coverageStart,
      coverageEnd: plan.coverageEnd,
      itemCount: totalItemCount,
    };
  } catch (error) {
    const normalized = normalizedBackfillError(error, 'persistence');
    try {
      await financeInsights.backfill.recordPlanFailure(
        plan.id,
        normalized.code,
        new Date().toISOString(),
      );
    } catch {
      logger.error(
        {
          module: 'finance-insight-backfill',
          stage: 'failure-recording',
          code: 'finance_insight_backfill_failure_recording_failed',
          primaryCode: normalized.code,
        },
        'Finance insight backfill failure recording failed',
      );
    }
    throw normalized;
  }
}

export function runFinanceInsightTransactionBackfill(
  input: FinanceInsightTransactionBackfillInput,
): Promise<FinanceInsightTransactionBackfillResult> {
  return runTransactionBackfill(input);
}

export function runFinanceInsightTransactionProjectionRepair(
  input: FinanceInsightTransactionBackfillInput & {
    assertSafe: () => Promise<void>;
  },
): Promise<FinanceInsightTransactionBackfillResult> {
  return runTransactionBackfill({
    ...input,
    projectionOnly: true,
  });
}
