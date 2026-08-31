import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceInsightPersistence } from '@/db/postgres/repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
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

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-insight-contract',
        }),
      }
    : {}),
});
let initialized = false;

const RESET_TABLES = [
  'finance_insight_transaction_projection_facts',
  'finance_insight_transaction_projection_windows',
  'finance_insight_transaction_projection_state',
  'finance_insight_transaction_window_proofs',
  'finance_insight_transaction_backfill_plans',
  'finance_insight_cutovers',
  'finance_insight_publication_delivery',
  'finance_insight_publication_state',
  'finance_insight_publications',
  'finance_insight_occurrence_cache_state',
  'finance_insight_occurrences',
] as const;
// finance_insight_publication_facts has no connector_id column; its rows cascade-delete
// (ON DELETE CASCADE) when the owning finance_insight_publications row above is removed.

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function createHarness(): Promise<FinanceInsightContractHarness> {
  await initialize();
  const pool = backend.context.pool;
  const repositories: FinanceInsightContractRepositories = createPostgresFinanceInsightPersistence(pool);

  return {
    repositories,

    async reset() {
      for (const table of RESET_TABLES) {
        await pool.query(`DELETE FROM ${table} WHERE connector_id = ANY($1)`, [
          [CONNECTOR_ID, `${CONNECTOR_ID}-second`],
        ]);
      }
      await pool.query(`DELETE FROM finance_transactions WHERE connector_instance_id = ANY($1)`, [
        [CONNECTOR_ID, `${CONNECTOR_ID}-second`],
      ]);
      await pool.query(`DELETE FROM connector_configs WHERE id = ANY($1)`, [
        [CONNECTOR_ID, `${CONNECTOR_ID}-second`],
      ]);
    },

    async seedConnector(overrides = {}) {
      const id = overrides.id ?? CONNECTOR_ID;
      const identityNamespace = overrides.identityNamespace === null
        ? undefined
        : overrides.identityNamespace ?? IDENTITY_NAMESPACE;
      const credentials = identityNamespace ? { identityNamespace } : {};
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, deleted_at, sync_mode, capabilities, credentials,
           settings, synced_lists, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'poll', $6::jsonb, $7::jsonb, $8::jsonb, '[]'::jsonb, $9, $9
         )`,
        [
          id,
          overrides.type ?? 'finance-manager',
          `Finance insight contract connector ${id}`,
          overrides.enabled !== false,
          overrides.deletedAt ?? null,
          JSON.stringify({
            read: true, write: true, delete: false, sync: true, subtasks: false,
            lists: false, tags: true, tagWriteBack: false, notificationOnly: true,
          }),
          JSON.stringify(credentials),
          JSON.stringify({ bridgeUrl: 'http://localhost:8100', householdCurrency: 'USD', maxRetries: 0 }),
          BASE_TIME,
        ],
      );
    },

    async setDeliveryEnabled(connectorId, enabled) {
      await pool.query(
        `INSERT INTO finance_insight_cutovers (
           connector_id, cutover_at, source_generation, source_sequence,
           delivery_enabled, created_at, updated_at
         ) VALUES ($1, $2, 'contract-cutover', 0, $3, $2, $2)
         ON CONFLICT (connector_id) DO UPDATE SET
           delivery_enabled = excluded.delivery_enabled,
           updated_at = excluded.updated_at`,
        [connectorId, BASE_TIME, enabled],
      );
    },

    async setProjectionCurrentAttempt(connectorId, attemptId) {
      await pool.query(
        `UPDATE finance_insight_transaction_projection_state
         SET current_attempt_id = $1 WHERE connector_id = $2`,
        [attemptId, connectorId],
      );
    },

    async deliveryRow(publicationId): Promise<FinanceInsightDeliveryRow | null> {
      const result = await pool.query<{
        stage: string;
        nextBatchOrdinal: number;
        detectorSetVersion: string | null;
        policyVersion: number | null;
        evaluationSequence: number | null;
        evaluationState: string | null;
        lastErrorCode: string | null;
        lastErrorRetryable: boolean;
      }>(
        `SELECT stage, next_batch_ordinal AS "nextBatchOrdinal",
                detector_set_version AS "detectorSetVersion", policy_version AS "policyVersion",
                evaluation_sequence AS "evaluationSequence", evaluation_state AS "evaluationState",
                last_error_code AS "lastErrorCode", last_error_retryable AS "lastErrorRetryable"
         FROM finance_insight_publication_delivery WHERE publication_id = $1`,
        [publicationId],
      );
      return result.rows[0] ?? null;
    },

    async occurrenceRow(connectorId, occurrenceId): Promise<FinanceInsightOccurrenceRow | null> {
      const result = await pool.query<{
        isTombstone: boolean;
        sourceLifecycle: string | null;
        sourceGeneration: string;
        sourceSequence: number;
        deliveryRevision: number;
        revisionDigest: string;
        entityLabel: string;
        headline: string;
        targetDescriptors: unknown;
        summaryPayload: unknown;
        sourceUpdatedAt: string;
        cachedAt: string;
      }>(
        `SELECT is_tombstone AS "isTombstone", source_lifecycle AS "sourceLifecycle",
                source_generation AS "sourceGeneration", source_sequence AS "sourceSequence",
                delivery_revision AS "deliveryRevision", revision_digest AS "revisionDigest",
                entity_label AS "entityLabel", headline, target_descriptors AS "targetDescriptors",
                summary_payload AS "summaryPayload", source_updated_at AS "sourceUpdatedAt",
                cached_at AS "cachedAt"
         FROM finance_insight_occurrences WHERE connector_id = $1 AND occurrence_id = $2`,
        [connectorId, occurrenceId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...row,
        targetDescriptors: row.targetDescriptors as FinanceInsightOccurrenceRow['targetDescriptors'],
        summaryPayload: row.summaryPayload as FinanceInsightOccurrenceRow['summaryPayload'],
      };
    },

    async occurrenceRowCount(connectorId) {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM finance_insight_occurrences WHERE connector_id = $1`,
        [connectorId],
      );
      return Number(result.rows[0].count);
    },

    async insertLegacyOccurrenceRow(input: FinanceInsightLegacyOccurrenceInput) {
      await pool.query(
        `INSERT INTO finance_insight_occurrences (
           connector_id, occurrence_id, source_generation, source_sequence, is_tombstone,
           insight_id, delivery_revision, revision_digest, kind, entity_kind, entity_source_ref,
           entity_label, analysis_state, source_lifecycle, severity, confidence,
           baseline_sufficiency, headline, freshness_state, source_as_of, target_descriptors,
           summary_payload, source_updated_at, cached_at
         ) VALUES (
           $1, $2, $3, $4, $5, 'insight-legacy', $6, $7, 'transaction-anomaly', 'transaction',
           'transaction-v1:legacy', 'Legacy entity', 'complete', $8, 'medium', 'high',
           'sufficient', 'Legacy headline', 'fresh', $9, '[]'::jsonb, $10, $9, $11
         )`,
        [
          input.connectorId,
          input.occurrenceId,
          input.sourceGeneration,
          input.sourceSequence,
          input.isTombstone,
          input.deliveryRevision,
          input.revisionDigest,
          input.sourceLifecycle,
          input.sourceUpdatedAt,
          input.summaryPayload === null ? null : JSON.stringify(input.summaryPayload),
          input.cachedAt,
        ],
      );
    },
  };
}

if (connectionString) {
  describeFinanceInsightPersistenceContract('PostgreSQL', createHarness);
} else {
  describe('PostgreSQL finance insight persistence contract', () => {
    it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
  });
}

afterAll(async () => {
  if (!initialized) return;
  const harness = await createHarness();
  await harness.reset();
  await backend.shutdown();
  initialized = false;
});
