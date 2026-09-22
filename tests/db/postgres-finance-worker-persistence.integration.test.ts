import { afterAll, describe, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceWorkerPersistence } from '@/db/postgres/repositories';
import { MONARCH_BRIDGE_CONTRACT_VERSION } from '@/lib/connectors/monarch-money/constants';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  BASE_TIME,
  CONNECTOR_ID,
  describeFinanceWorkerPersistenceContract,
  type FinanceWorkerContractHarness,
} from '../contracts/finance-worker-persistence.contract';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-worker-contract',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function createHarness(): Promise<FinanceWorkerContractHarness> {
  await initialize();
  const pool = backend.context.pool;
  const repositories = createPostgresFinanceWorkerPersistence(pool, {
    idFactory: (() => {
      let id = 0;
      return () => `finance-contract-id-${++id}`;
    })(),
  });
  return {
    repositories,
    async reset() {
      await pool.query(
        `DELETE FROM finance_attribution_audit WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      await pool.query(
        `DELETE FROM finance_attribution_exceptions WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      await pool.query(
        `DELETE FROM finance_attribution_subjects WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      await pool.query(
        `DELETE FROM finance_transactions WHERE connector_instance_id = $1`,
        [CONNECTOR_ID],
      );
      await pool.query(`DELETE FROM finance_sync_state WHERE connector_id = $1`, [CONNECTOR_ID]);
      for (const table of [
        'finance_accounts',
        'finance_category_groups',
        'finance_categories',
        'finance_tags',
        'finance_recurring_obligations',
        'finance_budget_snapshots',
        'finance_dataset_sync_state',
      ]) {
        await pool.query(`DELETE FROM ${table} WHERE connector_id = $1`, [CONNECTOR_ID]);
      }
      await pool.query(`DELETE FROM connector_configs WHERE id = $1`, [CONNECTOR_ID]);
    },
    async seedConnector(credentials: unknown = {}) {
      await pool.query(
        `INSERT INTO connector_configs (
           id, type, name, enabled, sync_mode, capabilities, credentials,
           settings, synced_lists, created_at, updated_at
         ) VALUES (
           $1, 'finance-manager', $1, true, 'poll',
           '{}'::jsonb, $2::jsonb, '{}'::jsonb, '[]'::jsonb, $3, $3
         )`,
        [CONNECTOR_ID, JSON.stringify(credentials), BASE_TIME],
      );
    },
    async credentials() {
      const result = await pool.query<{ credentials: Record<string, unknown> }>(
        `SELECT credentials FROM connector_configs WHERE id = $1`,
        [CONNECTOR_ID],
      );
      return result.rows[0].credentials;
    },
    async transaction(upstreamId) {
      const result = await pool.query<{
        id: string;
        lifecycleStatus: string;
        assignedKidId: string | null;
        kidAssignmentMethod: string | null;
        manualDecisionAction: string | null;
        manualDecidedAt: string | null;
        attributionStatus: string;
        attributionReasons: unknown;
        attributionRetryable: boolean;
        isPending: boolean;
        tags: unknown;
        tagReferences: unknown;
        lastSeenAt: string;
      }>(
        `SELECT id, lifecycle_status AS "lifecycleStatus",
                assigned_kid_id AS "assignedKidId",
                kid_assignment_method AS "kidAssignmentMethod",
                manual_decision_action AS "manualDecisionAction",
                manual_decided_at AS "manualDecidedAt",
                attribution_status AS "attributionStatus",
                attribution_reasons AS "attributionReasons",
                attribution_retryable AS "attributionRetryable",
                is_pending AS "isPending", tags,
                tag_references AS "tagReferences",
                last_seen_at AS "lastSeenAt"
         FROM finance_transactions
         WHERE connector_instance_id = $1 AND upstream_transaction_id = $2`,
        [CONNECTOR_ID, upstreamId],
      );
      return result.rows[0] ?? null;
    },
    async transactionCount() {
      const result = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM finance_transactions
         WHERE connector_instance_id = $1`,
        [CONNECTOR_ID],
      );
      return Number(result.rows[0].count);
    },
    async setManualDecision(input) {
      await pool.query(
        `UPDATE finance_transactions
         SET assigned_kid_id = $1, kid_assignment_method = 'manual',
             manual_decision_action = $2, manual_decided_at = $3,
             attribution_status = $4, attribution_confidence = 'definite',
             attribution_method = 'manual', attribution_decision_source = 'manual',
             attribution_review_state = 'resolved', attribution_retryable = false
         WHERE connector_instance_id = $5 AND upstream_transaction_id = $6`,
        [
          input.kidId,
          input.action,
          input.decidedAt,
          input.action === 'assign-kid' ? 'attributed' : 'unassigned',
          CONNECTOR_ID,
          input.upstreamId,
        ],
      );
    },
    async syncState() {
      const result = await pool.query<{
        status: string;
        generationId: string | null;
        lastSuccessfulGenerationId: string | null;
        lastErrorCode: string | null;
      }>(
        `SELECT status, current_generation_id AS "generationId",
                last_successful_generation_id AS "lastSuccessfulGenerationId",
                last_error_code AS "lastErrorCode"
         FROM finance_sync_state WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      return result.rows[0] ?? null;
    },
    async attributionException(upstreamId) {
      const result = await pool.query<{ occurrenceCount: number; status: string }>(
        `SELECT occurrence_count AS "occurrenceCount", status
         FROM finance_attribution_exceptions
         WHERE connector_id = $1 AND transaction_id = $2`,
        [CONNECTOR_ID, `finance:${CONNECTOR_ID}:${upstreamId}`],
      );
      return result.rows[0] ?? null;
    },
    async referenceAccount() {
      const result = await pool.query<{
        id: string;
        isActive: boolean;
        sourceIsActive: boolean;
        institution: string | null;
      }>(
        `SELECT id, is_active AS "isActive", source_is_active AS "sourceIsActive",
                institution
         FROM finance_accounts
         WHERE connector_id = $1 AND upstream_account_id = 'account-1'`,
        [CONNECTOR_ID],
      );
      return result.rows[0] ?? null;
    },
    async recurringGenerations() {
      const result = await pool.query<{ generationId: string; isCurrent: boolean }>(
        `SELECT DISTINCT generation_id AS "generationId", is_current AS "isCurrent"
         FROM finance_recurring_obligations
         WHERE connector_id = $1
         ORDER BY generation_id`,
        [CONNECTOR_ID],
      );
      return result.rows;
    },
  };
}

if (connectionString) {
  describeFinanceWorkerPersistenceContract('PostgreSQL', createHarness);

  describe('PostgreSQL finance projection checkpoint proofs', () => {
    it('persists canonical recurring proof state in the publication transaction', async () => {
      const harness = await createHarness();
      await harness.reset();
      await harness.seedConnector();
      await harness.repositories.identity.ensureNamespace({
        connectorId: CONNECTOR_ID,
        candidate: 'a'.repeat(64),
        updatedAt: BASE_TIME,
      });
      await harness.repositories.datasets.recordAttempt({
        connectorId: CONNECTOR_ID,
        dataset: 'recurring',
        attemptAt: BASE_TIME,
        sourceLimit: 10_000,
        schemaVersion: '1.0',
        configVersion: 1,
      });
      await harness.repositories.datasets.publishRecurring({
        connectorId: CONNECTOR_ID,
        dataset: 'recurring',
        attemptAt: BASE_TIME,
        generationId: 'recurring-proof',
        completedAt: BASE_TIME,
        sourceAsOf: BASE_TIME,
        freshUntil: '2026-08-31T12:00:00.000Z',
        coverageStart: null,
        coverageEnd: null,
        sourceLimit: 10_000,
        schemaVersion: '1.0',
        configVersion: 1,
        items: [{
          id: 'recurring-proof-item',
          merchant: 'Synthetic Merchant',
          amount: -12.5,
          frequency: 'monthly',
          nextExpectedDate: null,
          account: null,
          category: null,
        }],
      });

      const proof = await backend.context.pool.query<{
        itemCount: number;
        contentDigest: string;
        bridgeContractVersion: string;
      }>(
        `SELECT insight_item_count AS "itemCount",
                insight_content_digest AS "contentDigest",
                insight_bridge_contract_version AS "bridgeContractVersion"
         FROM finance_dataset_sync_state
         WHERE connector_id = $1 AND dataset = 'recurring'`,
        [CONNECTOR_ID],
      );
      expect(proof.rows[0]).toEqual({
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
      });
    });

    it('persists canonical transaction proof state with snapshot completion', async () => {
      const harness = await createHarness();
      await harness.reset();
      await harness.seedConnector({ identityNamespace: 'a'.repeat(64) });
      await harness.repositories.snapshots.start({
        connectorId: CONNECTOR_ID,
        generationId: 'snapshot-proof',
        windowStart: '2026-08-01',
        windowEnd: '2026-08-31',
        mode: 'backfill',
        attemptAt: BASE_TIME,
      });
      await harness.repositories.snapshots.upsertPage({
        connectorId: CONNECTOR_ID,
        generationId: 'snapshot-proof',
        transactions: [{
          id: 'transaction-proof',
          date: '2026-08-15',
          amount: -12.5,
          merchant: { name: 'Synthetic Merchant', logoUrl: null },
          category: null,
          account: { id: 'account-1', displayName: 'Checking', mask: null },
          isPending: false,
          isRecurring: false,
          notes: null,
          tags: [],
          tagReferences: [],
        }],
        provenance: { provider: 'demo', fetchedAt: BASE_TIME },
        observedAt: BASE_TIME,
      });
      await harness.repositories.snapshots.complete({
        connectorId: CONNECTOR_ID,
        generationId: 'snapshot-proof',
        windowStart: '2026-08-01',
        windowEnd: '2026-08-31',
        projectionStartDate: '2026-08-01',
        sourceAsOf: BASE_TIME,
        completedAt: BASE_TIME,
        added: 1,
        updated: 0,
      });

      const proof = await backend.context.pool.query<{
        itemCount: number;
        contentDigest: string;
        projectionStartDate: string;
        coverageStart: string;
        coverageEnd: string;
        bridgeContractVersion: string;
      }>(
        `SELECT last_successful_item_count AS "itemCount",
                last_successful_content_digest AS "contentDigest",
                last_successful_projection_start_date AS "projectionStartDate",
                last_successful_projection_coverage_start AS "coverageStart",
                last_successful_projection_coverage_end AS "coverageEnd",
                last_successful_bridge_contract_version AS "bridgeContractVersion"
         FROM finance_sync_state
         WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      expect(proof.rows[0]).toEqual({
        itemCount: 1,
        contentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        projectionStartDate: '2026-08-01',
        coverageStart: '2026-08-15',
        coverageEnd: '2026-08-15',
        bridgeContractVersion: MONARCH_BRIDGE_CONTRACT_VERSION,
      });
    });
  });
} else {
  describe('PostgreSQL finance worker persistence contract', () => {
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
