import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresCoreRepositories,
  createPostgresFinanceOperatorPersistence,
  createPostgresFinanceWorkerPersistence,
} from '@/db/postgres/repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

/**
 * L12b live-PostgreSQL proof for the finance connector/operator web surface.
 *
 * It exercises the real PostgreSQL adapters against the existing schema
 * (no DDL, no bootstrap) through the same ports the seven owned routes use:
 * the generic connection-test badge, the bounded health snapshot, cutover
 * readiness/rollback, and the API-shaped attribution list/decision/action
 * operations, including idempotent replay, conflicting reuse, CAS races, and
 * after-commit retry signalling.
 */

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const CONNECTOR_ID = 'finance-web-parity-connector';
const TRANSACTION_ID = `finance:${CONNECTOR_ID}:transaction-one`;
const EXCEPTION_ID = 'finance-web-parity-exception';
const NOW = '2026-09-01T12:00:00.000Z';

const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-connectors-web',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize() {
  if (!initialized) {
    if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
    assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    initialized = true;
  }
  return backend.context.pool;
}

async function reset(pool: Awaited<ReturnType<typeof initialize>>): Promise<void> {
  for (const statement of [
    `DELETE FROM finance_attribution_audit WHERE connector_id = $1`,
    `DELETE FROM finance_attribution_exceptions WHERE connector_id = $1`,
    `DELETE FROM finance_attribution_subjects WHERE connector_id = $1`,
    `DELETE FROM finance_transactions WHERE connector_instance_id = $1`,
    `DELETE FROM finance_sync_state WHERE connector_id = $1`,
    `DELETE FROM finance_insight_cutover_audit WHERE connector_id = $1`,
    `DELETE FROM finance_insight_cutovers WHERE connector_id = $1`,
    `DELETE FROM finance_insight_occurrences WHERE connector_id = $1`,
    `DELETE FROM finance_insight_occurrence_cache_state WHERE connector_id = $1`,
    `DELETE FROM finance_insight_publication_delivery WHERE connector_id = $1`,
    `DELETE FROM finance_insight_publication_facts
       WHERE publication_id IN (
         SELECT id FROM finance_insight_publications WHERE connector_id = $1
       )`,
    `DELETE FROM finance_insight_publications WHERE connector_id = $1`,
    `DELETE FROM connector_configs WHERE id = $1`,
  ]) {
    await pool.query(statement, [CONNECTOR_ID]);
  }
}

async function seed(pool: Awaited<ReturnType<typeof initialize>>): Promise<void> {
  await pool.query(
    `INSERT INTO connector_configs (
       id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
       credentials, settings, synced_lists, created_at, updated_at
     ) VALUES ($1, 'finance-manager', 'Tyrion parity', true, 'poll', 240,
       '{"read":true,"write":false,"delete":false}'::jsonb, '{}'::jsonb,
       '{"householdCurrency":"USD"}'::jsonb, '[]'::jsonb, $2, $2)`,
    [CONNECTOR_ID, NOW],
  );
  await pool.query(
    `INSERT INTO finance_sync_state (
       connector_id, status, last_attempt_at, last_successful_sync_at,
       attribution_status, attribution_policy_version, attribution_engine_version,
       created_at, updated_at
     ) VALUES ($1, 'succeeded', $2, $2, 'healthy', 7, '2.0.0', $2, $2)`,
    [CONNECTOR_ID, NOW],
  );
  await pool.query(
    `INSERT INTO finance_transactions (
       id, connector_instance_id, upstream_transaction_id, date, amount,
       merchant_name, account_id, card_last4, assigned_kid_id,
       kid_assignment_method, triage_status, is_pending, is_recurring, tags,
       lifecycle_status, source_fingerprint, first_seen_at, last_seen_at, synced_at,
       attribution_status, attribution_reasons, attribution_review_state,
       attribution_retryable
     ) VALUES ($1, $2, 'transaction-one', '2026-09-01', -25.5,
       'Invented merchant', 'account-one', '1234', 'kid-one',
       'merchant-rule', 'pending', false, false, '[]'::jsonb,
       'active', 'source-hash', $3, $3, $3,
       'pending', '["low-confidence"]'::jsonb, 'pending', false)`,
    [TRANSACTION_ID, CONNECTOR_ID, NOW],
  );
  await pool.query(
    `INSERT INTO finance_attribution_subjects (
       id, connector_id, kid_id, policy_version, engine_version, first_seen_at, last_seen_at
     ) VALUES ('finance-web-parity-subject', $1, 'kid-one', 7, '2.0.0', $2, $2)`,
    [CONNECTOR_ID, NOW],
  );
  await pool.query(
    `INSERT INTO finance_attribution_exceptions (
       id, connector_id, transaction_id, status, reason_code, retryable,
       review_state, source_fingerprint, policy_version, occurrence_count,
       created_at, first_observed_at, last_observed_at, updated_at
     ) VALUES ($1, $2, $3, 'open', 'low-confidence', true, 'pending',
       'source-hash', 7, 1, $4, $4, $4, $4)`,
    [EXCEPTION_ID, CONNECTOR_ID, TRANSACTION_ID, NOW],
  );
}

async function seedCompletedPublication(
  pool: Awaited<ReturnType<typeof initialize>>,
  sourceGeneration = 'generation-one',
  sourceSequence = 1,
): Promise<void> {
  await pool.query(
    `INSERT INTO finance_insight_publications (
       id, connector_id, source_sequence, generation_identity, contract_version,
       provider_type, source_as_of, coverage_start, coverage_end, currency,
       bridge_contract_version, captured_constituents, manifest, manifest_digest,
       create_request, idempotency_key, alert_capable, captured_at, expires_at
     ) VALUES (
       $1, $2, $3, $4, '1.0', 'finance-manager', $5, '2026-08-01',
       '2026-09-01', 'USD', 'bridge-v1', '[]'::jsonb, '[]'::jsonb,
       'invented-digest', '{}'::jsonb, $6, true, $5, '2026-09-08T12:00:00.000Z'
     )`,
    [
      sourceGeneration,
      CONNECTOR_ID,
      sourceSequence,
      `identity-${sourceSequence}`,
      NOW,
      `pg-publication-${sourceSequence}`,
    ],
  );
  await pool.query(
    `INSERT INTO finance_insight_publication_delivery (
       publication_id, connector_id, source_sequence, stage, next_batch_ordinal,
       evaluation_state, last_successful_at, created_at, updated_at
     ) VALUES ($1, $2, $3, 'evaluation-requested', 0, 'completed', $4, $4, $4)`,
    [sourceGeneration, CONNECTOR_ID, sourceSequence, NOW],
  );
  await pool.query(
    `INSERT INTO finance_insight_occurrence_cache_state (
       connector_id, source_generation, source_sequence, item_count, source_as_of,
       refreshed_at, summary_expires_at, purge_after, created_at, updated_at
     ) VALUES (
       $1, $2, $3, 0, $4, $4, '2026-09-02T12:00:00.000Z',
       '2026-09-08T12:00:00.000Z', $4, $4
     )`,
    [CONNECTOR_ID, sourceGeneration, sourceSequence, NOW],
  );
}

if (connectionString) {
  describe.sequential('PostgreSQL finance connector/operator web parity', () => {
    beforeEach(async () => {
      const pool = await initialize();
      await reset(pool);
      await seed(pool);
    });

    it('records connection-test badges and no-ops for unknown connectors', async () => {
      const pool = await initialize();
      const { connectors } = createPostgresCoreRepositories(backend.context.db);

      await expect(connectors.recordTestResult({
        connectorId: CONNECTOR_ID,
        status: 'failed',
        error: 'Tyrion bridge is unreachable',
        testedAt: NOW,
      })).resolves.toEqual({ recorded: true });
      let badge = await pool.query(
        `SELECT last_test_status AS "status", last_test_error AS "error",
                last_test_at AS "testedAt"
         FROM connector_configs WHERE id = $1`,
        [CONNECTOR_ID],
      );
      expect(badge.rows[0]).toEqual({
        status: 'failed',
        error: 'Tyrion bridge is unreachable',
        testedAt: NOW,
      });

      await expect(connectors.recordTestResult({
        connectorId: CONNECTOR_ID,
        status: 'success',
        error: 'ignored on success',
        testedAt: '2026-09-01T13:00:00.000Z',
      })).resolves.toEqual({ recorded: true });
      badge = await pool.query(
        `SELECT last_test_status AS "status", last_test_error AS "error",
                last_test_at AS "testedAt"
         FROM connector_configs WHERE id = $1`,
        [CONNECTOR_ID],
      );
      expect(badge.rows[0]).toEqual({
        status: 'success',
        error: null,
        testedAt: '2026-09-01T13:00:00.000Z',
      });

      await expect(connectors.recordTestResult({
        connectorId: 'connector-absent',
        status: 'failed',
        error: 'Connection test failed',
        testedAt: NOW,
      })).resolves.toEqual({ recorded: false });
    });

    it('reads a bounded, redacted health snapshot', async () => {
      const pool = await initialize();
      const operator = createPostgresFinanceOperatorPersistence(pool);

      const snapshot = await operator.readHealthSnapshot(CONNECTOR_ID);

      expect(snapshot.sync).toMatchObject({ status: 'succeeded', lastErrorCode: null });
      expect(snapshot.attribution).toMatchObject({
        status: 'healthy',
        policyVersion: 7,
        engineVersion: '2.0.0',
      });
      expect(snapshot.activeJob).toBeNull();
      expect(JSON.stringify(snapshot)).not.toMatch(
        /publicationId|sourceSequence|detectorSetVersion|accessToken|serviceToken/,
      );
      await expect(operator.readHealthSnapshot('connector-absent')).resolves.toEqual({
        sync: null,
        attribution: null,
        activeJob: null,
        capture: null,
        evaluation: null,
      });
    });

    it('reports cutover readiness and fences rollback on a stale generation', async () => {
      const pool = await initialize();
      const operator = createPostgresFinanceOperatorPersistence(pool);

      const readiness = await operator.readCutoverReadiness(CONNECTOR_ID);
      expect(readiness.connector).toMatchObject({ id: CONNECTOR_ID, enabled: true });
      expect(readiness.publication).toBeNull();
      expect(readiness.cutover).toBeNull();
      await expect(operator.isLegacyAnomalyProductionEnabled()).resolves.toBe(true);
      await expect(operator.readCutoverReadiness('connector-absent'))
        .rejects.toMatchObject({ code: 'finance_connector_not_found', status: 404 });
      await expect(operator.readCutoverGeneration({
        connectorId: CONNECTOR_ID,
        sourceGeneration: 'generation-absent',
      })).resolves.toBeNull();

      await expect(operator.rollbackCutover({
        connectorId: CONNECTOR_ID,
        sourceGeneration: 'generation-one',
        actorType: 'service',
        idempotencyKey: 'pg-rollback-idempotency-0001',
        now: NOW,
      })).rejects.toMatchObject({
        code: 'finance_insight_cutover_unavailable',
        status: 404,
      });

      await pool.query(
        `INSERT INTO finance_insight_cutovers (
           connector_id, cutover_at, source_generation, source_sequence,
           legacy_disabled, delivery_enabled, legacy_expired_count, imported_count,
           result, rolled_back_at, created_at, updated_at
         ) VALUES ($1, $2, 'generation-one', 3, true, true, 2, 5,
           '{"status":"enabled"}'::jsonb, NULL, $2, $2)`,
        [CONNECTOR_ID, NOW],
      );
      await expect(operator.isLegacyAnomalyProductionEnabled()).resolves.toBe(false);
      await expect(operator.rollbackCutover({
        connectorId: CONNECTOR_ID,
        sourceGeneration: 'generation-two',
        actorType: 'service',
        idempotencyKey: 'pg-rollback-idempotency-0002',
        now: NOW,
      })).rejects.toMatchObject({ code: 'finance_insight_cutover_generation_stale' });

      const rollback = {
        connectorId: CONNECTOR_ID,
        sourceGeneration: 'generation-one',
        actorType: 'service' as const,
        idempotencyKey: 'pg-rollback-idempotency-0003',
        now: NOW,
      };
      await expect(operator.rollbackCutover(rollback)).resolves.toMatchObject({
        outcome: 'rolled-back',
        replayed: false,
      });
      await expect(operator.rollbackCutover(rollback)).resolves.toMatchObject({
        outcome: 'rolled-back',
        replayed: true,
      });
      await expect(operator.rollbackCutover({
        ...rollback,
        sourceGeneration: 'generation-three',
      })).rejects.toMatchObject({ code: 'cutover_idempotency_conflict' });

      const state = await pool.query(
        `SELECT delivery_enabled AS "deliveryEnabled", rolled_back_at AS "rolledBackAt"
         FROM finance_insight_cutovers WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      expect(state.rows[0]).toEqual({ deliveryEnabled: false, rolledBackAt: NOW });
    });

    it('enables one exact cutover generation and replays before generation lookup', async () => {
      const pool = await initialize();
      const operator = createPostgresFinanceOperatorPersistence(pool);
      await seedCompletedPublication(pool);
      const command = {
        connectorId: CONNECTOR_ID,
        sourceGeneration: 'generation-one',
        sourceSequence: 1,
        actorType: 'service' as const,
        idempotencyKey: 'pg-enable-idempotency-0001',
        now: NOW,
        blockers: [] as readonly string[],
        reconcile: [],
        ingest: [],
      };

      await expect(operator.enableCutover(command)).resolves.toEqual({
        outcome: 'enabled',
        legacyExpiredCount: 0,
        importedCount: 0,
        suppressedDeliveryCount: 0,
        replayed: false,
        hasPendingDelivery: false,
      });
      await expect(operator.enableCutover(command)).resolves.toMatchObject({
        outcome: 'enabled',
        replayed: true,
      });
      await expect(operator.isLegacyAnomalyProductionEnabled()).resolves.toBe(false);

      await pool.query(
        `UPDATE finance_insight_occurrence_cache_state
         SET source_generation = 'generation-newer', source_sequence = 2
         WHERE connector_id = $1`,
        [CONNECTOR_ID],
      );
      await expect(operator.enableCutover({
        ...command,
        idempotencyKey: null,
        sourceSequence: 0,
        blockers: ['finance_insight_cutover_generation_unavailable'],
      })).resolves.toMatchObject({
        outcome: 'enabled',
        replayed: false,
      });
    });

    it('lists, decides, and acts on attribution exceptions with real CAS and idempotency', async () => {
      const pool = await initialize();
      const { attribution } = createPostgresFinanceWorkerPersistence(pool);

      const page = await attribution.listExceptions({
        connectorId: CONNECTOR_ID,
        status: 'current',
        limit: 10,
        cursor: null,
      });
      expect(page.hasMore).toBe(false);
      expect(page.exceptions[0]).toMatchObject({
        id: EXCEPTION_ID,
        reasonCode: 'low-confidence',
        retryable: true,
        reasons: ['low-confidence'],
      });
      expect(page.exceptions[0]).not.toHaveProperty('transactionId');
      expect(page.subjects).toEqual([
        expect.objectContaining({ kidId: 'kid-one' }),
      ]);
      await expect(attribution.listExceptions({
        connectorId: 'connector-absent',
        status: 'all',
        limit: 10,
        cursor: null,
      })).rejects.toMatchObject({ code: 'connector_not_found', status: 404 });

      const expectedUpdatedAt = page.exceptions[0]!.updatedAt;
      await expect(attribution.actOnException({
        connectorId: CONNECTOR_ID,
        exceptionId: EXCEPTION_ID,
        action: 'dismiss',
        kidId: null,
        expectedUpdatedAt: '1999-01-01T00:00:00.000Z',
        idempotencyKey: 'pg-action-stale-0001',
        actorType: 'service',
        now: NOW,
      })).rejects.toMatchObject({ code: 'exception_conflict', status: 409 });

      const retry = {
        connectorId: CONNECTOR_ID,
        exceptionId: EXCEPTION_ID,
        action: 'retry' as const,
        kidId: null,
        expectedUpdatedAt,
        idempotencyKey: 'pg-action-retry-0001',
        actorType: 'service' as const,
        now: NOW,
      };
      await expect(attribution.actOnException(retry)).resolves.toMatchObject({
        status: 'retry_requested',
        replayed: false,
        retryScheduled: true,
      });
      // The replay must never re-signal the retry wake.
      await expect(attribution.actOnException(retry)).resolves.toMatchObject({
        status: 'retry_requested',
        replayed: true,
        retryScheduled: false,
      });
      await expect(attribution.actOnException({
        ...retry,
        action: 'dismiss',
      })).rejects.toMatchObject({ code: 'idempotency_conflict', status: 409 });

      const decision = {
        connectorId: CONNECTOR_ID,
        transactionId: TRANSACTION_ID,
        action: 'assign-kid' as const,
        kidId: 'kid-one',
        idempotencyKey: 'pg-manual-decision-0001',
        auditAction: 'manual-resolve' as const,
        actorType: 'service' as const,
        exceptionId: null,
        expectedExceptionUpdatedAt: null,
        expectedTransactionVersion: null,
        now: NOW,
      };
      await expect(attribution.applyManualDecision(decision)).resolves.toMatchObject({
        status: 'resolved',
        replayed: false,
      });
      await expect(attribution.applyManualDecision(decision)).resolves.toMatchObject({
        status: 'resolved',
        replayed: true,
      });
      await expect(attribution.applyManualDecision({
        ...decision,
        kidId: 'kid-one',
        action: 'parent-expense',
      })).rejects.toMatchObject({ code: 'invalid_manual_decision', status: 400 });
      await expect(attribution.applyManualDecision({
        ...decision,
        idempotencyKey: 'pg-manual-decision-0002',
        kidId: 'kid-unknown',
      })).rejects.toMatchObject({ code: 'unknown_attribution_subject', status: 409 });
      await expect(attribution.applyManualDecision({
        ...decision,
        idempotencyKey: 'pg-manual-decision-0003',
        transactionId: 'transaction-absent',
      })).rejects.toMatchObject({ code: 'transaction_not_found', status: 404 });

      const stored = await pool.query(
        `SELECT assigned_kid_id AS "assignedKidId",
                kid_assignment_method AS "kidAssignmentMethod",
                manual_decision_action AS "manualDecisionAction",
                attribution_status AS "attributionStatus"
         FROM finance_transactions WHERE id = $1`,
        [TRANSACTION_ID],
      );
      expect(stored.rows[0]).toEqual({
        assignedKidId: 'kid-one',
        kidAssignmentMethod: 'manual',
        manualDecisionAction: 'assign-kid',
        attributionStatus: 'attributed',
      });
    });

    it('fences a stale expected transaction version', async () => {
      const pool = await initialize();
      const { attribution } = createPostgresFinanceWorkerPersistence(pool);

      await expect(attribution.applyManualDecision({
        connectorId: CONNECTOR_ID,
        transactionId: TRANSACTION_ID,
        action: 'parent-expense',
        kidId: null,
        idempotencyKey: 'pg-manual-cas-0001',
        auditAction: 'approve',
        actorType: 'service',
        exceptionId: null,
        expectedExceptionUpdatedAt: null,
        expectedTransactionVersion: {
          sourceFingerprint: 'stale-hash',
          lastSeenAt: NOW,
          assignedKidId: 'kid-one',
          confirmedCategory: null,
          manualDecidedAt: null,
        },
        now: NOW,
      })).rejects.toMatchObject({ code: 'transaction_conflict', status: 409 });
    });
  });
} else {
  describe('PostgreSQL finance connector/operator web parity', () => {
    it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
  });
}

afterAll(async () => {
  if (!initialized) return;
  await reset(backend.context.pool);
  await backend.shutdown();
  initialized = false;
});
