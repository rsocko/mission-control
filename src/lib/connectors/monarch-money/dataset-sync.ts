import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import {
  FINANCE_DATASETS,
  type FinanceDataset,
  type FinanceFreshnessState,
} from '@/db/finance-schema';
import { financeInsightDigestV1, type CanonicalJsonValue } from '@/lib/finance-insights/canonical';
import {
  type SourceFactKindV1,
} from '@/lib/finance-insights/contract';
import { loadFinanceInsightProjectionFacts } from '@/lib/finance-insights/publication';
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
  type MonarchCategoryGroup,
  type MonarchRecurringObligation,
  type MonarchTag,
} from './client';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from './constants';

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
const FINANCE_INSIGHT_KIND_BY_DATASET: Partial<Record<FinanceDataset, SourceFactKindV1>> = {
  accounts: 'account',
  categories: 'category',
  tags: 'tag',
  recurring: 'recurring',
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

type ReferenceDefinition<T> = {
  table: 'finance_accounts' | 'finance_category_groups' | 'finance_categories' | 'finance_tags';
  sourceIdColumn: string;
  localPrefix: string;
  values(item: T): readonly unknown[];
  insertColumns: string;
  insertPlaceholders: string;
  updateAssignments: string;
  comparable(item: T): string;
};

function stableValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function localId(prefix: string, connectorId: string, upstreamId: string): string {
  return `finance:${prefix}:${connectorId}:${upstreamId}`;
}

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
    const existing = sqlite.prepare(`
      SELECT dataset, last_attempt_outcome AS lastAttemptOutcome,
             current_generation_id AS currentGenerationId,
             source_as_of AS sourceAsOf, fresh_until AS freshUntil
      FROM finance_dataset_sync_state
      WHERE connector_id = ?
    `).all(this.config.id) as DatasetStateRow[];
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
        const result = await this.syncDataset(dataset, context.signal);
        itemsAdded += result.added;
        itemsUpdated += result.updated;
        itemsRemoved += result.removed;
      } catch (error) {
        this.recordFailure(dataset, error);
        failures[dataset] = failureDetails(error).code;
        if (context.signal?.aborted) throw error;
      }
    }

    const statuses = this.getStatuses(this.clock());
    return {
      itemsAdded,
      itemsUpdated,
      itemsRemoved,
      status: Object.keys(failures).length > 0 ? 'partial' : aggregateFreshness(statuses),
      datasetErrors: failures,
    };
  }

  private async syncDataset(dataset: FinanceDataset, signal?: AbortSignal): Promise<DatasetRunResult> {
    const attemptAt = this.clock().toISOString();
    this.recordAttempt(dataset, attemptAt);
    switch (dataset) {
      case 'accounts': {
        const response = await this.client.getAccounts(signal);
        return this.publishReference(
          dataset,
          response.accounts,
          response.provenance.fetchedAt,
          {
            table: 'finance_accounts',
            sourceIdColumn: 'upstream_account_id',
            localPrefix: 'account',
            values: (item) => [
              item.displayName,
              item.type,
              item.institution,
              item.mask,
              item.isActive ? 1 : 0,
              item.isActive ? 1 : 0,
            ],
            insertColumns: 'display_name, type, institution, mask, is_active, source_is_active',
            insertPlaceholders: '?, ?, ?, ?, ?, ?',
            updateAssignments: `display_name = excluded.display_name, type = excluded.type,
              institution = excluded.institution, mask = excluded.mask,
              is_active = excluded.is_active, source_is_active = excluded.source_is_active`,
            comparable: (item) => stableValue({
              displayName: item.displayName,
              type: item.type,
              institution: item.institution,
              mask: item.mask,
              isActive: item.isActive,
            }),
          },
        );
      }
      case 'category-groups': {
        const response = await this.client.getCategoryGroups(signal);
        return this.publishReference(
          dataset,
          response.categoryGroups,
          response.provenance.fetchedAt,
          simpleReferenceDefinition('finance_category_groups', 'upstream_group_id', 'category-group'),
        );
      }
      case 'categories': {
        const response = await this.client.getCategories(signal);
        return this.publishReference(
          dataset,
          response.categories,
          response.provenance.fetchedAt,
          {
            table: 'finance_categories',
            sourceIdColumn: 'upstream_category_id',
            localPrefix: 'category',
            values: (item) => [
              item.name,
              item.groupId,
              item.group,
              item.icon,
              item.isActive ? 1 : 0,
              item.isActive ? 1 : 0,
            ],
            insertColumns: 'name, upstream_group_id, group_name, icon, is_active, source_is_active',
            insertPlaceholders: '?, ?, ?, ?, ?, ?',
            updateAssignments: `name = excluded.name, upstream_group_id = excluded.upstream_group_id,
              group_name = excluded.group_name, icon = excluded.icon,
              is_active = excluded.is_active, source_is_active = excluded.source_is_active`,
            comparable: (item) => stableValue(item),
          },
        );
      }
      case 'tags': {
        const response = await this.client.getTags(signal);
        return this.publishReference(
          dataset,
          response.tags,
          response.provenance.fetchedAt,
          simpleReferenceDefinition('finance_tags', 'upstream_tag_id', 'tag'),
        );
      }
      case 'recurring': {
        const response = await this.client.getRecurring(signal);
        return this.publishRecurring(
          response.recurring,
          response.provenance.fetchedAt,
        );
      }
      case 'budgets': {
        const response = await this.client.getBudgets(signal);
        return this.publishBudgets(
          response.budgets,
          response.periodStart,
          response.periodEnd,
          response.provenance.fetchedAt,
        );
      }
    }
  }

  private publishReference<T extends { id: string }>(
    dataset: FinanceDataset,
    items: T[],
    sourceAsOf: string,
    definition: ReferenceDefinition<T>,
  ): DatasetRunResult {
    assertCompleteCollection(items);
    const generationId = randomUUID();
    const now = this.clock();
    const sourceDate = validateSourceAsOf(sourceAsOf, now);
    const completedAt = this.clock().toISOString();
    return sqlite.transaction(() => {
      const existingRows = sqlite.prepare(`
        SELECT *
        FROM ${definition.table}
        WHERE connector_id = ?
      `).all(this.config.id) as Array<Record<string, unknown>>;
      const existing = new Map(existingRows.map((row) => [
        String(row[definition.sourceIdColumn]),
        stableReferenceRow(dataset, row),
      ]));
      let added = 0;
      let updated = 0;
      const upsert = sqlite.prepare(`
        INSERT INTO ${definition.table} (
          id, connector_id, ${definition.sourceIdColumn}, ${definition.insertColumns},
          last_seen_generation_id, first_seen_at, last_seen_at, deactivated_at
        ) VALUES (?, ?, ?, ${definition.insertPlaceholders}, ?, ?, ?, NULL)
        ON CONFLICT(connector_id, ${definition.sourceIdColumn}) DO UPDATE SET
          ${definition.updateAssignments},
          last_seen_generation_id = excluded.last_seen_generation_id,
          last_seen_at = excluded.last_seen_at,
          deactivated_at = CASE WHEN excluded.is_active = 1 THEN NULL ELSE COALESCE(${definition.table}.deactivated_at, excluded.last_seen_at) END
      `);
      for (const item of items) {
        const next = definition.comparable(item);
        const previous = existing.get(item.id);
        if (previous === undefined) added++;
        else if (previous !== next) updated++;
        upsert.run(
          localId(definition.localPrefix, this.config.id, item.id),
          this.config.id,
          item.id,
          ...definition.values(item),
          generationId,
          completedAt,
          completedAt,
        );
      }
      const removed = sqlite.prepare(`
        UPDATE ${definition.table}
        SET is_active = 0, deactivated_at = COALESCE(deactivated_at, ?)
        WHERE connector_id = ? AND is_active = 1 AND last_seen_generation_id <> ?
      `).run(completedAt, this.config.id, generationId).changes;
      this.recordSuccess(
        dataset,
        generationId,
        sourceDate,
        completedAt,
        items.length,
        null,
        null,
      );
      return { added, updated, removed, count: items.length };
    }).immediate();
  }

  private publishRecurring(
    items: MonarchRecurringObligation[],
    sourceAsOf: string,
  ): DatasetRunResult {
    assertCompleteCollection(items);
    const sourceDate = validateSourceAsOf(sourceAsOf, this.clock());
    const completedAt = this.clock().toISOString();
    const current = this.currentGeneration('recurring');
    const nextFingerprint = stableValue(items
      .map((item) => recurringComparable(item))
      .sort(binaryIdCompare));
    const currentFingerprint = stableValue((sqlite.prepare(`
      SELECT upstream_recurring_id AS id, merchant, amount, frequency,
             next_expected_date AS nextExpectedDate,
             upstream_account_id AS accountId, account_name AS accountName,
             upstream_category_id AS categoryId, category_name AS categoryName
      FROM finance_recurring_obligations
      WHERE connector_id = ? AND is_current = 1
    `).all(this.config.id) as Array<{ id: string }>).sort(binaryIdCompare));
    if (current.currentGenerationId && currentFingerprint === nextFingerprint) {
      this.recordSuccess(
        'recurring',
        current.currentGenerationId,
        sourceDate,
        completedAt,
        items.length,
        null,
        null,
      );
      return { added: 0, updated: 0, removed: 0, count: items.length };
    }
    const generationId = randomUUID();
    return sqlite.transaction(() => {
      const previousCount = currentSnapshotCount('finance_recurring_obligations', this.config.id);
      const insert = sqlite.prepare(`
        INSERT INTO finance_recurring_obligations (
          id, connector_id, generation_id, upstream_recurring_id, merchant,
          amount, frequency, next_expected_date, upstream_account_id, account_name,
          upstream_category_id, category_name, is_current, source_as_of, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const item of items) {
        insert.run(
          localId('recurring', this.config.id, `${generationId}:${item.id}`),
          this.config.id,
          generationId,
          item.id,
          item.merchant,
          item.amount,
          item.frequency,
          item.nextExpectedDate,
          item.account?.id ?? null,
          item.account?.displayName ?? null,
          item.category?.id ?? null,
          item.category?.name ?? null,
          sourceAsOf,
          completedAt,
        );
      }
      rotateSnapshots(
        'finance_recurring_obligations',
        this.config.id,
        generationId,
        current.currentGenerationId,
      );
      this.recordSuccess('recurring', generationId, sourceDate, completedAt, items.length, null, null);
      return {
        added: items.length,
        updated: 0,
        removed: Math.max(0, previousCount - items.length),
        count: items.length,
      };
    }).immediate();
  }

  private publishBudgets(
    items: MonarchBudget[],
    periodStart: string,
    periodEnd: string,
    sourceAsOf: string,
  ): DatasetRunResult {
    assertCompleteCollection(items.map((item) => ({ id: item.category.id })));
    assertFullCalendarMonth(periodStart, periodEnd);
    const sourceDate = validateSourceAsOf(sourceAsOf, this.clock());
    const completedAt = this.clock().toISOString();
    const current = this.currentGeneration('budgets');
    const nextFingerprint = stableValue(items
      .map((item) => budgetComparable(item, periodStart, periodEnd))
      .sort(binaryIdCompare));
    const currentFingerprint = stableValue((sqlite.prepare(`
      SELECT upstream_category_id AS id, category_name AS categoryName,
             period_start AS periodStart, period_end AS periodEnd,
             budgeted, spent, remaining, percent_used AS percentUsed
      FROM finance_budget_snapshots
      WHERE connector_id = ? AND is_current = 1
    `).all(this.config.id) as Array<{ id: string }>).sort(binaryIdCompare));
    if (current.currentGenerationId && currentFingerprint === nextFingerprint) {
      this.recordSuccess(
        'budgets',
        current.currentGenerationId,
        sourceDate,
        completedAt,
        items.length,
        periodStart,
        periodEnd,
      );
      return { added: 0, updated: 0, removed: 0, count: items.length };
    }
    const generationId = randomUUID();
    return sqlite.transaction(() => {
      const previousCount = currentSnapshotCount('finance_budget_snapshots', this.config.id);
      const insert = sqlite.prepare(`
        INSERT INTO finance_budget_snapshots (
          id, connector_id, generation_id, period_start, period_end,
          upstream_category_id, category_name, budgeted, spent, remaining,
          percent_used, is_current, source_as_of, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `);
      for (const item of items) {
        insert.run(
          localId('budget', this.config.id, `${generationId}:${periodStart}:${item.category.id}`),
          this.config.id,
          generationId,
          periodStart,
          periodEnd,
          item.category.id,
          item.category.name,
          item.budgeted,
          item.spent,
          item.remaining,
          item.percentUsed,
          sourceAsOf,
          completedAt,
        );
      }
      rotateSnapshots(
        'finance_budget_snapshots',
        this.config.id,
        generationId,
        current.currentGenerationId,
      );
      this.recordSuccess(
        'budgets',
        generationId,
        sourceDate,
        completedAt,
        items.length,
        periodStart,
        periodEnd,
      );
      return {
        added: items.length,
        updated: 0,
        removed: Math.max(0, previousCount - items.length),
        count: items.length,
      };
    }).immediate();
  }

  private recordAttempt(dataset: FinanceDataset, attemptAt: string): void {
    sqlite.prepare(`
      INSERT INTO finance_dataset_sync_state (
        connector_id, dataset, last_attempt_at, source_limit,
        schema_version, config_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, dataset) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        updated_at = excluded.updated_at
    `).run(
      this.config.id,
      dataset,
      attemptAt,
      MONARCH_DATASET_LIMITS[dataset],
      DATASET_SCHEMA_VERSION,
      DATASET_CONFIG_VERSION,
      attemptAt,
      attemptAt,
    );
  }

  private recordSuccess(
    dataset: FinanceDataset,
    generationId: string,
    sourceAsOf: Date,
    completedAt: string,
    count: number,
    coverageStart: string | null,
    coverageEnd: string | null,
  ): void {
    const current = sqlite.prepare(`
      SELECT current_generation_id AS generationId,
             previous_generation_id AS previousGenerationId
      FROM finance_dataset_sync_state
      WHERE connector_id = ? AND dataset = ?
    `).get(this.config.id, dataset) as {
      generationId: string | null;
      previousGenerationId: string | null;
    } | undefined;
    const freshUntil = new Date(
      sourceAsOf.getTime() + freshnessHours(this.config, dataset) * 3_600_000,
    ).toISOString();
    const insightKind = FINANCE_INSIGHT_KIND_BY_DATASET[dataset];
    const insightFacts = insightKind
      ? loadFinanceInsightProjectionFacts(this.config.id, '0000-01-01', insightKind)[insightKind]
      : null;
    const insightItemCount = insightFacts?.length ?? null;
    const insightContentDigest = insightFacts
      ? financeInsightDigestV1(insightFacts as CanonicalJsonValue)
      : null;
    sqlite.prepare(`
      UPDATE finance_dataset_sync_state
      SET last_attempt_outcome = 'succeeded', last_successful_at = ?,
          source_as_of = ?, fresh_until = ?, coverage_start = ?, coverage_end = ?,
          previous_generation_id = ?, current_generation_id = ?,
          schema_version = ?, config_version = ?, published_item_count = ?,
          insight_item_count = ?, insight_content_digest = ?,
          insight_bridge_contract_version = ?,
          source_limit = ?, last_error_code = NULL, updated_at = ?
      WHERE connector_id = ? AND dataset = ?
    `).run(
      completedAt,
      sourceAsOf.toISOString(),
      freshUntil,
      coverageStart,
      coverageEnd,
      current?.generationId === generationId
        ? current.previousGenerationId
        : current?.generationId ?? null,
      generationId,
      DATASET_SCHEMA_VERSION,
      DATASET_CONFIG_VERSION,
      count,
      insightItemCount,
      insightContentDigest,
      insightKind ? MONARCH_BRIDGE_CONTRACT_VERSION : null,
      MONARCH_DATASET_LIMITS[dataset],
      completedAt,
      this.config.id,
      dataset,
    );
  }

  private recordFailure(dataset: FinanceDataset, error: unknown): void {
    const failedAt = this.clock().toISOString();
    const failure = failureDetails(error);
    sqlite.prepare(`
      INSERT INTO finance_dataset_sync_state (
        connector_id, dataset, last_attempt_at, last_attempt_outcome,
        source_limit, schema_version, config_version, last_error_code,
        created_at, updated_at
      ) VALUES (?, ?, ?, 'failed', ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connector_id, dataset) DO UPDATE SET
        last_attempt_at = excluded.last_attempt_at,
        last_attempt_outcome = 'failed',
        last_error_code = excluded.last_error_code,
        updated_at = excluded.updated_at
    `).run(
      this.config.id,
      dataset,
      failedAt,
      MONARCH_DATASET_LIMITS[dataset],
      DATASET_SCHEMA_VERSION,
      DATASET_CONFIG_VERSION,
      failure.code,
      failedAt,
      failedAt,
    );
  }

  private currentGeneration(dataset: FinanceDataset): {
    currentGenerationId: string | null;
    previousGenerationId: string | null;
  } {
    return (sqlite.prepare(`
      SELECT current_generation_id AS currentGenerationId,
             previous_generation_id AS previousGenerationId
      FROM finance_dataset_sync_state
      WHERE connector_id = ? AND dataset = ?
    `).get(this.config.id, dataset) as {
      currentGenerationId: string | null;
      previousGenerationId: string | null;
    } | undefined) ?? {
      currentGenerationId: null,
      previousGenerationId: null,
    };
  }

  private getStatuses(now: Date): DatasetStatus[] {
    const rows = sqlite.prepare(`
      SELECT dataset, last_attempt_outcome AS lastAttemptOutcome,
             current_generation_id AS currentGenerationId,
             source_as_of AS sourceAsOf, fresh_until AS freshUntil,
             last_error_code AS lastErrorCode
      FROM finance_dataset_sync_state
      WHERE connector_id = ?
    `).all(this.config.id) as Array<DatasetStateRow & { lastErrorCode: string | null }>;
    const byDataset = new Map(rows.map((row) => [row.dataset, row]));
    return FINANCE_DATASETS.map((dataset) => {
      const row = byDataset.get(dataset);
      return {
        dataset,
        state: financeDatasetFreshness(row, now),
        warning: row?.lastAttemptOutcome === 'failed' ? row.lastErrorCode : null,
      };
    });
  }
}

function simpleReferenceDefinition<T extends MonarchCategoryGroup | MonarchTag>(
  table: 'finance_category_groups' | 'finance_tags',
  sourceIdColumn: 'upstream_group_id' | 'upstream_tag_id',
  localPrefix: string,
): ReferenceDefinition<T> {
  return {
    table,
    sourceIdColumn,
    localPrefix,
    values: (item) => [item.name, item.isActive ? 1 : 0, item.isActive ? 1 : 0],
    insertColumns: 'name, is_active, source_is_active',
    insertPlaceholders: '?, ?, ?',
    updateAssignments: `name = excluded.name, is_active = excluded.is_active,
      source_is_active = excluded.source_is_active`,
    comparable: (item) => stableValue(item),
  };
}

function recurringComparable(item: MonarchRecurringObligation) {
  return {
    id: item.id,
    merchant: item.merchant,
    amount: item.amount,
    frequency: item.frequency,
    nextExpectedDate: item.nextExpectedDate,
    accountId: item.account?.id ?? null,
    accountName: item.account?.displayName ?? null,
    categoryId: item.category?.id ?? null,
    categoryName: item.category?.name ?? null,
  };
}

function budgetComparable(item: MonarchBudget, periodStart: string, periodEnd: string) {
  return {
    id: item.category.id,
    categoryName: item.category.name,
    periodStart,
    periodEnd,
    budgeted: item.budgeted,
    spent: item.spent,
    remaining: item.remaining,
    percentUsed: item.percentUsed,
  };
}

function binaryIdCompare(left: { id: string }, right: { id: string }): number {
  return Buffer.compare(Buffer.from(left.id, 'utf8'), Buffer.from(right.id, 'utf8'));
}

function stableReferenceRow(dataset: FinanceDataset, row: Record<string, unknown>): string {
  switch (dataset) {
    case 'accounts':
      return stableValue({
        displayName: row.display_name,
        type: row.type,
        institution: row.institution,
        mask: row.mask,
        isActive: row.source_is_active === 1,
      });
    case 'categories':
      return stableValue({
        id: row.upstream_category_id,
        name: row.name,
        groupId: row.upstream_group_id,
        group: row.group_name,
        icon: row.icon,
        isActive: row.source_is_active === 1,
      });
    default:
      return stableValue({
        id: dataset === 'category-groups'
          ? row.upstream_group_id
          : row.upstream_tag_id,
        name: row.name,
        isActive: row.source_is_active === 1,
      });
  }
}

function currentSnapshotCount(table: string, connectorId: string): number {
  return (sqlite.prepare(`
    SELECT count(*) AS count FROM ${table}
    WHERE connector_id = ? AND is_current = 1
  `).get(connectorId) as { count: number }).count;
}

function rotateSnapshots(
  table: 'finance_recurring_obligations' | 'finance_budget_snapshots',
  connectorId: string,
  generationId: string,
  previousGenerationId: string | null,
): void {
  sqlite.prepare(`
    UPDATE ${table} SET is_current = 0
    WHERE connector_id = ? AND generation_id <> ?
  `).run(connectorId, generationId);
  sqlite.prepare(`
    DELETE FROM ${table}
    WHERE connector_id = ? AND generation_id NOT IN (?, ?)
  `).run(connectorId, generationId, previousGenerationId ?? generationId);
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
