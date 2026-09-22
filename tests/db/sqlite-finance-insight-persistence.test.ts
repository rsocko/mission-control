import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, vi } from 'vitest';
import {
  BASE_TIME,
  CONNECTOR_ID,
  IDENTITY_NAMESPACE,
  describeFinanceInsightPersistenceContract,
  type FinanceInsightContractHarness,
  type FinanceInsightContractRepositories,
  type FinanceInsightDeliveryRow,
  type FinanceInsightLegacyOccurrenceInput,
  type FinanceInsightOccurrenceRow,
} from '../contracts/finance-insight-persistence.contract';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-insight-persistence-'));
const databasePath = join(tempDirectory, 'finance-insight-persistence.db');

let sqlite: Database.Database;
let createSqliteFinanceInsightPersistence:
  typeof import('@/db/persistence/sqlite-finance-insights-repositories')['createSqliteFinanceInsightPersistence'];

const RESET_TABLES = [
  'finance_insight_transaction_projection_facts',
  'finance_insight_transaction_projection_windows',
  'finance_insight_transaction_projection_state',
  'finance_insight_transaction_window_proofs',
  'finance_insight_transaction_backfill_plans',
  'finance_insight_cutovers',
  'finance_insight_publication_facts',
  'finance_insight_publication_delivery',
  'finance_insight_publication_state',
  'finance_insight_publications',
  'finance_insight_occurrence_cache_state',
  'finance_insight_occurrences',
  'finance_transactions',
  'connector_configs',
] as const;

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.resetModules();
  sqlite = (await import('@/db')).sqlite;
  ({ createSqliteFinanceInsightPersistence } = await import(
    '@/db/persistence/sqlite-finance-insights-repositories'
  ));
});

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});

async function createHarness(): Promise<FinanceInsightContractHarness> {
  const repositories: FinanceInsightContractRepositories = createSqliteFinanceInsightPersistence(sqlite);

  return {
    repositories,

    async reset() {
      for (const table of RESET_TABLES) {
        sqlite.exec(`DELETE FROM ${table}`);
      }
    },

    async seedConnector(overrides = {}) {
      const id = overrides.id ?? CONNECTOR_ID;
      const identityNamespace = overrides.identityNamespace === null
        ? undefined
        : overrides.identityNamespace ?? IDENTITY_NAMESPACE;
      const credentials = identityNamespace ? { identityNamespace } : {};
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, deleted_at, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'poll', ?, ?, ?, '[]', ?, ?)
      `).run(
        id,
        overrides.type ?? 'finance-manager',
        `Finance insight contract connector ${id}`,
        overrides.enabled === false ? 0 : 1,
        overrides.deletedAt ?? null,
        JSON.stringify({
          read: true, write: true, delete: false, sync: true, subtasks: false,
          lists: false, tags: true, tagWriteBack: false, notificationOnly: true,
        }),
        JSON.stringify(credentials),
        JSON.stringify({ bridgeUrl: 'http://localhost:8100', householdCurrency: 'USD', maxRetries: 0 }),
        BASE_TIME,
        BASE_TIME,
      );
    },

    async setDeliveryEnabled(connectorId, enabled) {
      sqlite.prepare(`
        INSERT INTO finance_insight_cutovers (
          connector_id, cutover_at, source_generation, source_sequence,
          delivery_enabled, created_at, updated_at
        ) VALUES (?, ?, 'contract-cutover', 0, ?, ?, ?)
        ON CONFLICT(connector_id) DO UPDATE SET
          delivery_enabled = excluded.delivery_enabled,
          updated_at = excluded.updated_at
      `).run(connectorId, BASE_TIME, enabled ? 1 : 0, BASE_TIME, BASE_TIME);
    },

    async setProjectionCurrentAttempt(connectorId, attemptId) {
      sqlite.prepare(`
        UPDATE finance_insight_transaction_projection_state
        SET current_attempt_id = ? WHERE connector_id = ?
      `).run(attemptId, connectorId);
    },

    async deliveryRow(publicationId): Promise<FinanceInsightDeliveryRow | null> {
      const row = sqlite.prepare(`
        SELECT stage, next_batch_ordinal AS nextBatchOrdinal,
               detector_set_version AS detectorSetVersion, policy_version AS policyVersion,
               evaluation_sequence AS evaluationSequence, evaluation_state AS evaluationState,
               last_error_code AS lastErrorCode, last_error_retryable AS lastErrorRetryable
        FROM finance_insight_publication_delivery WHERE publication_id = ?
      `).get(publicationId) as {
        stage: string;
        nextBatchOrdinal: number;
        detectorSetVersion: string | null;
        policyVersion: number | null;
        evaluationSequence: number | null;
        evaluationState: string | null;
        lastErrorCode: string | null;
        lastErrorRetryable: number;
      } | undefined;
      if (!row) return null;
      return { ...row, lastErrorRetryable: row.lastErrorRetryable === 1 };
    },

    async occurrenceRow(connectorId, occurrenceId): Promise<FinanceInsightOccurrenceRow | null> {
      const row = sqlite.prepare(`
        SELECT is_tombstone AS isTombstone, source_lifecycle AS sourceLifecycle,
               source_generation AS sourceGeneration, source_sequence AS sourceSequence,
               delivery_revision AS deliveryRevision, revision_digest AS revisionDigest,
               entity_label AS entityLabel, headline, target_descriptors AS targetDescriptors,
               summary_payload AS summaryPayload, source_updated_at AS sourceUpdatedAt,
               cached_at AS cachedAt
        FROM finance_insight_occurrences WHERE connector_id = ? AND occurrence_id = ?
      `).get(connectorId, occurrenceId) as {
        isTombstone: number;
        sourceLifecycle: string | null;
        sourceGeneration: string;
        sourceSequence: number;
        deliveryRevision: number;
        revisionDigest: string;
        entityLabel: string;
        headline: string;
        targetDescriptors: string;
        summaryPayload: string | null;
        sourceUpdatedAt: string;
        cachedAt: string;
      } | undefined;
      if (!row) return null;
      return {
        ...row,
        isTombstone: row.isTombstone === 1,
        targetDescriptors: JSON.parse(row.targetDescriptors),
        summaryPayload: row.summaryPayload === null ? null : JSON.parse(row.summaryPayload),
      };
    },

    async occurrenceRowCount(connectorId) {
      const row = sqlite.prepare(`
        SELECT COUNT(*) AS count FROM finance_insight_occurrences WHERE connector_id = ?
      `).get(connectorId) as { count: number };
      return row.count;
    },

    async insertLegacyOccurrenceRow(input: FinanceInsightLegacyOccurrenceInput) {
      sqlite.prepare(`
        INSERT INTO finance_insight_occurrences (
          connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
          insight_id, delivery_revision, revision_digest, kind, entity_kind, entity_source_ref,
          entity_label, analysis_state, source_lifecycle, severity, confidence,
          baseline_sufficiency, headline, freshness_state, source_as_of, target_descriptors,
          summary_payload, source_updated_at, cached_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'insight-legacy', ?, ?, 'transaction-anomaly', 'transaction',
          'transaction-v1:legacy', 'Legacy entity', 'complete', ?, 'medium', 'high',
          'sufficient', 'Legacy headline', 'fresh', ?, '[]', ?, ?, ?
        )
      `).run(
        input.connectorId,
        input.occurrenceId,
        input.sourceGeneration,
        input.sourceSequence,
        input.isTombstone ? 1 : 0,
        input.deliveryRevision,
        input.revisionDigest,
        input.sourceLifecycle,
        input.sourceUpdatedAt,
        input.summaryPayload === null ? null : JSON.stringify(input.summaryPayload),
        input.sourceUpdatedAt,
        input.cachedAt,
      );
    },
  };
}

describeFinanceInsightPersistenceContract('SQLite', createHarness);
