import 'server-only';

import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import {
  FINANCE_DATASETS,
  type FinanceDataset,
  type FinanceFreshnessState,
  type FinanceDatasetPersistence,
  type FinanceDatasetPublicationMetadata,
  type FinanceReferenceDataset,
  type FinanceReferenceDatasetItem,
} from '@/db/persistence/finance-datasets';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import type {
  ConnectorConfig,
  DomainSyncContext,
  DomainSyncResult,
} from '@/types';
import {
  MONARCH_DATASET_LIMITS,
  MonarchBridgeClient,
  MonarchBridgeError,
  type MonarchAccount,
  type MonarchBudget,
  type MonarchCategory,
  type MonarchRecurringObligation,
} from './client';
import { financeReferenceDatasetGenerationRef } from './dataset-generation';

const DATASET_SCHEMA_VERSION = '1.0';
const DATASET_CONFIG_VERSION = 1;
const MAX_SOURCE_CLOCK_SKEW_MS = 5 * 60_000;
const DEFAULT_FRESHNESS_HOURS: Record<FinanceDataset, number> = {
  accounts: 24,
  'category-groups': 24,
  categories: 24,
  tags: 24,
  recurring: 6,
  budgets: 6,
};

type DatasetRunResult = {
  added: number;
  updated: number;
  removed: number;
  count: number;
};

type DatasetStatus = {
  dataset: FinanceDataset;
  state: FinanceFreshnessState;
  warning: string | null;
};

export type FinanceDatasetHealth = {
  dataset: FinanceDataset;
  provenance: 'monarch-bridge';
  state: FinanceFreshnessState;
  itemCount: number;
  sourceLimit: number;
  coverage: { start: string; end: string } | null;
  lastAttemptAt: string | null;
  lastSuccessfulAt: string | null;
  sourceAsOf: string | null;
  freshUntil: string | null;
  generationId: string | null;
  schemaVersion: string;
  configVersion: number;
  warning: string | null;
};

type DatasetStateRow = {
  dataset: FinanceDataset;
  lastAttemptOutcome: 'succeeded' | 'failed' | null;
  currentGenerationId: string | null;
  sourceAsOf: string | null;
  freshUntil: string | null;
};

function failureDetails(error: unknown): { code: string; message: string } {
  if (error instanceof MonarchBridgeError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error && /cancel|abort/i.test(error.message)) {
    return { code: 'sync_cancelled', message: 'Finance dataset sync was cancelled' };
  }
  return { code: 'dataset_sync_failed', message: 'Finance dataset synchronization failed' };
}

function assertCompleteCollection(items: Array<{ id: string }>): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new MonarchBridgeError(
      'invalid_contract',
      'Monarch Bridge returned duplicate dataset identifiers',
      false,
      502,
    );
  }
}

function freshnessHours(config: ConnectorConfig, dataset: FinanceDataset): number {
  const settings = (config.settings ?? {}) as Record<string, unknown>;
  const configured = settings.datasetFreshnessHours;
  const raw = configured && typeof configured === 'object'
    ? (configured as Record<string, unknown>)[dataset]
    : undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 168
    ? parsed
    : DEFAULT_FRESHNESS_HOURS[dataset];
}

function validateSourceAsOf(sourceAsOf: string, now: Date): Date {
  const parsed = new Date(sourceAsOf);
  if (
    !Number.isFinite(parsed.getTime())
    || parsed.getTime() > now.getTime() + MAX_SOURCE_CLOCK_SKEW_MS
  ) {
    throw new MonarchBridgeError(
      'invalid_source_timestamp',
      'Monarch Bridge returned an invalid dataset timestamp',
      false,
      502,
    );
  }
  return parsed;
}

export function financeDatasetFreshness(
  state: Pick<DatasetStateRow, 'currentGenerationId' | 'sourceAsOf' | 'freshUntil'> | undefined,
  now = new Date(),
): FinanceFreshnessState {
  if (!state?.currentGenerationId || !state.sourceAsOf || !state.freshUntil) {
    return 'unavailable';
  }
  const sourceTime = Date.parse(state.sourceAsOf);
  return sourceTime <= now.getTime() && Date.parse(state.freshUntil) >= now.getTime()
    ? 'fresh'
    : 'stale';
}

function aggregateFreshness(states: DatasetStatus[]): FinanceFreshnessState {
  if (states.length === 0 || states.every((state) => state.state === 'unavailable')) {
    return 'unavailable';
  }
  const uniqueStates = new Set(states.map((state) => state.state));
  if (uniqueStates.size === 1) return states[0].state;
  return 'partial';
}

export function getFinanceDatasetHealth(
    connectorId: string,
    now = new Date(),
  ): { aggregate: FinanceFreshnessState; datasets: FinanceDatasetHealth[] } {
    const rows = sqlite.prepare(`
      SELECT dataset, last_attempt_at AS lastAttemptAt,
             last_attempt_outcome AS lastAttemptOutcome,
             last_successful_at AS lastSuccessfulAt,
             source_as_of AS sourceAsOf, fresh_until AS freshUntil,
             coverage_start AS coverageStart, coverage_end AS coverageEnd,
             current_generation_id AS currentGenerationId,
             schema_version AS schemaVersion, config_version AS configVersion,
             published_item_count AS publishedItemCount, source_limit AS sourceLimit,
             last_error_code AS lastErrorCode
      FROM finance_dataset_sync_state
      WHERE connector_id = ?
    `).all(connectorId) as Array<{
      dataset: FinanceDataset;
      lastAttemptAt: string | null;
      lastAttemptOutcome: 'succeeded' | 'failed' | null;
      lastSuccessfulAt: string | null;
      sourceAsOf: string | null;
      freshUntil: string | null;
      coverageStart: string | null;
      coverageEnd: string | null;
      currentGenerationId: string | null;
      schemaVersion: string;
      configVersion: number;
      publishedItemCount: number;
      sourceLimit: number;
      lastErrorCode: string | null;
    }>;
    const byDataset = new Map(rows.map((row) => [row.dataset, row]));
    const datasets = FINANCE_DATASETS.map((dataset): FinanceDatasetHealth => {
      const row = byDataset.get(dataset);
      return {
        dataset,
        provenance: 'monarch-bridge',
        state: financeDatasetFreshness(row, now),
        itemCount: row?.publishedItemCount ?? 0,
        sourceLimit: row?.sourceLimit ?? MONARCH_DATASET_LIMITS[dataset],
        coverage: row?.coverageStart && row.coverageEnd
          ? { start: row.coverageStart, end: row.coverageEnd }
          : null,
        lastAttemptAt: row?.lastAttemptAt ?? null,
        lastSuccessfulAt: row?.lastSuccessfulAt ?? null,
        sourceAsOf: row?.sourceAsOf ?? null,
        freshUntil: row?.freshUntil ?? null,
        generationId: row?.currentGenerationId ?? null,
        schemaVersion: row?.schemaVersion ?? DATASET_SCHEMA_VERSION,
        configVersion: row?.configVersion ?? DATASET_CONFIG_VERSION,
        warning: row?.lastAttemptOutcome === 'failed' ? row.lastErrorCode : null,
      };
    });
    const statuses = datasets.map((dataset) => ({
      dataset: dataset.dataset,
      state: dataset.state,
      warning: dataset.warning,
    }));
    return {
      aggregate: statuses.some((status) => status.warning)
        ? 'partial'
        : aggregateFreshness(statuses),
      datasets,
    };
}

export class FinanceDatasetSynchronizer {
  private readonly client: MonarchBridgeClient;

  constructor(
    private readonly config: ConnectorConfig,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.client = new MonarchBridgeClient(config);
  }

  async sync(context: DomainSyncContext): Promise<DomainSyncResult> {
    const persistence = (await getWorkerPersistenceRepositories()).finance.datasets;
    const existing = await persistence.listState(this.config.id);
    const failed = new Set(
      existing
        .filter((state) => state.lastAttemptOutcome === 'failed')
        .map((state) => state.dataset),
    );
    const selected = !context.full && failed.size > 0
      ? FINANCE_DATASETS.filter((dataset) => failed.has(dataset))
      : FINANCE_DATASETS;

    let itemsAdded = 0;
    let itemsUpdated = 0;
    let itemsRemoved = 0;
    const failures: Partial<Record<FinanceDataset, string>> = {};

    for (const dataset of selected) {
      if (context.signal?.aborted) {
        throw context.signal.reason instanceof Error
          ? context.signal.reason
          : new Error('Finance dataset sync cancelled');
      }
      try {
        const result = await this.syncDataset(dataset, persistence, context.signal);
        itemsAdded += result.added;
        itemsUpdated += result.updated;
        itemsRemoved += result.removed;
      } catch (error) {
        failures[dataset] = failureDetails(error).code;
        if (context.signal?.aborted) throw error;
      }
    }

    const finalState = await persistence.listState(this.config.id);
    const stateByDataset = new Map(finalState.map((state) => [state.dataset, state]));
    const statuses = FINANCE_DATASETS.map((dataset) => {
      const state = stateByDataset.get(dataset);
      return {
        dataset,
        state: financeDatasetFreshness(state, this.clock()),
        warning: state?.lastAttemptOutcome === 'failed'
          ? state.lastErrorCode
          : null,
      };
    });
    return {
      itemsAdded,
      itemsUpdated,
      itemsRemoved,
      status: Object.keys(failures).length > 0 ? 'partial' : aggregateFreshness(statuses),
      datasetErrors: failures,
    };
  }

  private async syncDataset(
    dataset: FinanceDataset,
    persistence: FinanceDatasetPersistence,
    signal?: AbortSignal,
  ): Promise<DatasetRunResult> {
    const attemptAt = this.clock().toISOString();
    await persistence.recordAttempt({
      connectorId: this.config.id,
      dataset,
      attemptAt,
      sourceLimit: MONARCH_DATASET_LIMITS[dataset],
      schemaVersion: DATASET_SCHEMA_VERSION,
      configVersion: DATASET_CONFIG_VERSION,
    });
    try {
      switch (dataset) {
      case 'accounts': {
        const response = await this.client.getAccounts(signal);
        return this.publishReference(
          persistence,
          dataset,
          response.accounts,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      case 'category-groups': {
        const response = await this.client.getCategoryGroups(signal);
        return this.publishReference(
          persistence,
          dataset,
          response.categoryGroups,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      case 'categories': {
        const response = await this.client.getCategories(signal);
        return this.publishReference(
          persistence,
          dataset,
          response.categories,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      case 'tags': {
        const response = await this.client.getTags(signal);
        return this.publishReference(
          persistence,
          dataset,
          response.tags,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      case 'recurring': {
        const response = await this.client.getRecurring(signal);
        return this.publishRecurring(
          persistence,
          response.recurring,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      case 'budgets': {
        const response = await this.client.getBudgets(signal);
        return this.publishBudgets(
          persistence,
          response.budgets,
          response.periodStart,
          response.periodEnd,
          response.provenance.fetchedAt,
          attemptAt,
        );
      }
      }
    } catch (error) {
      const failedAt = this.clock().toISOString();
      await persistence.recordFailure({
        connectorId: this.config.id,
        dataset,
        attemptAt,
        failedAt,
        errorCode: failureDetails(error).code,
        sourceLimit: MONARCH_DATASET_LIMITS[dataset],
        schemaVersion: DATASET_SCHEMA_VERSION,
        configVersion: DATASET_CONFIG_VERSION,
      });
      throw error;
    }
  }

  private async publishReference<T extends { id: string }>(
    persistence: FinanceDatasetPersistence,
    dataset: FinanceReferenceDataset,
    items: T[],
    sourceAsOf: string,
    attemptAt: string,
  ): Promise<DatasetRunResult> {
    assertCompleteCollection(items);
    const now = this.clock();
    const sourceDate = validateSourceAsOf(sourceAsOf, now);
    const completedAt = this.clock().toISOString();
    const generationId = financeReferenceDatasetGenerationRef({
      connectorId: this.config.id,
      dataset,
      sourceAsOf: sourceDate.toISOString(),
      schemaVersion: DATASET_SCHEMA_VERSION,
      configVersion: DATASET_CONFIG_VERSION,
      items: items as unknown as FinanceReferenceDatasetItem[],
    });
    return persistence.publishReference({
      ...this.publicationMetadata(
        dataset,
        attemptAt,
        generationId,
        sourceDate,
        completedAt,
        null,
        null,
      ),
      dataset: dataset as 'accounts' | 'category-groups' | 'categories' | 'tags',
      items: items as unknown as FinanceReferenceDatasetItem[],
    });
  }

  private async publishRecurring(
    persistence: FinanceDatasetPersistence,
    items: MonarchRecurringObligation[],
    sourceAsOf: string,
    attemptAt: string,
  ): Promise<DatasetRunResult> {
    assertCompleteCollection(items);
    const sourceDate = validateSourceAsOf(sourceAsOf, this.clock());
    const completedAt = this.clock().toISOString();
    const generationId = randomUUID();
    return persistence.publishRecurring({
      ...this.publicationMetadata(
        'recurring',
        attemptAt,
        generationId,
        sourceDate,
        completedAt,
        null,
        null,
      ),
      dataset: 'recurring',
      items,
    });
  }

  private async publishBudgets(
    persistence: FinanceDatasetPersistence,
    items: MonarchBudget[],
    periodStart: string,
    periodEnd: string,
    sourceAsOf: string,
    attemptAt: string,
  ): Promise<DatasetRunResult> {
    assertCompleteCollection(items.map((item) => ({ id: item.category.id })));
    assertFullCalendarMonth(periodStart, periodEnd);
    const sourceDate = validateSourceAsOf(sourceAsOf, this.clock());
    const completedAt = this.clock().toISOString();
    const generationId = randomUUID();
    return persistence.publishBudgets({
      ...this.publicationMetadata(
        'budgets',
        attemptAt,
        generationId,
        sourceDate,
        completedAt,
        periodStart,
        periodEnd,
      ),
      dataset: 'budgets',
      periodStart,
      periodEnd,
      items,
    });
  }

  private publicationMetadata(
    dataset: FinanceDataset,
    attemptAt: string,
    generationId: string,
    sourceAsOf: Date,
    completedAt: string,
    coverageStart: string | null,
    coverageEnd: string | null,
  ): FinanceDatasetPublicationMetadata {
    return {
      connectorId: this.config.id,
      dataset,
      attemptAt,
      generationId,
      completedAt,
      sourceAsOf: sourceAsOf.toISOString(),
      freshUntil: new Date(
        sourceAsOf.getTime() + freshnessHours(this.config, dataset) * 3_600_000,
      ).toISOString(),
      coverageStart,
      coverageEnd,
      sourceLimit: MONARCH_DATASET_LIMITS[dataset],
      schemaVersion: DATASET_SCHEMA_VERSION,
      configVersion: DATASET_CONFIG_VERSION,
    };
  }

}

function assertFullCalendarMonth(periodStart: string, periodEnd: string): void {
  const start = new Date(`${periodStart}T00:00:00.000Z`);
  const end = new Date(`${periodEnd}T00:00:00.000Z`);
  const expectedEnd = new Date(Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth() + 1,
    0,
  )).toISOString().slice(0, 10);
  if (
    !Number.isFinite(start.getTime())
    || !Number.isFinite(end.getTime())
    || start.getUTCDate() !== 1
    || periodEnd !== expectedEnd
  ) {
    throw new MonarchBridgeError(
      'invalid_budget_period',
      'Monarch Bridge returned an invalid budget period',
      false,
      502,
    );
  }
}

export type {
  MonarchAccount,
  MonarchCategory,
};
