import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceOperatorPersistence } from '@/db/postgres/repositories';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const connectorId = 'finance-clean-bootstrap-postgres';
const now = '2026-10-10T04:00:00.000Z';
const leaseOwner = 'retention:finance-clean-bootstrap:postgres-contract';
const identityNamespace = 'b'.repeat(64);
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-clean-bootstrap',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize() {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function reset() {
  if (!initialized) return;
  const pool = backend.context.pool;
  await pool.query(
    `DELETE FROM finance_clean_bootstrap_audit WHERE connector_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM finance_attribution_exceptions WHERE connector_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM finance_accounts WHERE connector_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM finance_transactions WHERE connector_instance_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM connector_operation_leases WHERE connector_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM connector_sync_controls WHERE connector_id = $1`,
    [connectorId],
  );
  await pool.query(
    `DELETE FROM connector_configs WHERE id = $1`,
    [connectorId],
  );
}

async function seed() {
  const pool = backend.context.pool;
  await pool.query(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials,
      settings, synced_lists, created_at, updated_at
    ) VALUES (
      $1, 'finance-manager', 'Tyrion', false, 'poll', '{}'::jsonb, $2::jsonb,
      $3::jsonb, '[]'::jsonb, $4, $4
    )
  `, [
    connectorId,
    JSON.stringify({ identityNamespace, token: 'preserved-secret' }),
    JSON.stringify({ bridgeUrl: 'https://tyrion.example/api/connector/v1' }),
    now,
  ]);
  await pool.query(`
    INSERT INTO connector_sync_controls (
      connector_id, scheduler_state, quarantine_id, quarantined_at,
      created_at, updated_at
    ) VALUES ($1, 'quarantined', 'quarantine-postgres', $2, $2, $2)
  `, [connectorId, now]);
  await pool.query(`
    INSERT INTO connector_operation_leases (
      connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
    ) VALUES ($1, 'retention', $2, '2099-01-01T00:00:00.000Z', $3, $3)
  `, [connectorId, leaseOwner, now]);
  await pool.query(`
    INSERT INTO finance_transactions (
      id, connector_instance_id, upstream_transaction_id, date, amount,
      merchant_name, account_id, synced_at
    ) VALUES (
      'postgres-transaction', $1, 'private-upstream', '2026-10-01', 42,
      'Private merchant', 'private-account', $2
    )
  `, [connectorId, now]);
  await pool.query(`
    INSERT INTO finance_accounts (
      id, connector_id, upstream_account_id, display_name, type,
      last_seen_generation_id, first_seen_at, last_seen_at
    ) VALUES (
      'postgres-account', $1, 'private-account', 'Private account', 'credit',
      'legacy-generation', $2, $2
    )
  `, [connectorId, now]);
  await pool.query(`
    INSERT INTO finance_attribution_exceptions (
      id, connector_id, transaction_id, status, reason_code, retryable,
      review_state, source_fingerprint, created_at, first_observed_at,
      last_observed_at, updated_at
    ) VALUES (
      'postgres-exception', $1, 'postgres-transaction', 'open', 'no-match',
      true, 'pending', 'private-fingerprint', $2, $2, $2, $2
    )
  `, [connectorId, now]);
}

if (connectionString) {
  describe.sequential('PostgreSQL finance clean bootstrap', () => {
    beforeEach(async () => {
      await initialize();
      await reset();
      await seed();
    });

    it('matches SQLite inventory/apply semantics and preserves connector identity', async () => {
      const repository = createPostgresFinanceOperatorPersistence(backend.context.pool);
      const dryRun = await repository.inventoryCleanBootstrap({
        connectorId,
        actorType: 'service',
        idempotencyKey: 'postgres-clean-dry-run-12345',
        leaseOwner,
        now,
      });
      expect(dryRun.inventory).toMatchObject({
        manualAttributionDecisions: 0,
        automatedAttributionExceptions: 1,
        accountProjections: 1,
        transactionProjections: 1,
      });
      const applied = await repository.applyCleanBootstrap({
        connectorId,
        actorType: 'service',
        idempotencyKey: 'postgres-clean-apply-123456',
        leaseOwner,
        dryRunId: dryRun.dryRunId,
        scopeDigest: dryRun.scopeDigest,
        confirmationToken: dryRun.confirmationToken,
        now,
      });
      expect(applied.retired).toMatchObject({
        automatedAttributionExceptions: 1,
        accountProjections: 1,
        transactionProjections: 1,
      });
      const connector = await backend.context.pool.query<{
        credentials: { identityNamespace: string; token: string };
        settings: { bridgeUrl: string };
        enabled: boolean;
      }>(
        `SELECT credentials, settings, enabled FROM connector_configs WHERE id = $1`,
        [connectorId],
      );
      expect(connector.rows[0]).toEqual({
        credentials: { identityNamespace, token: 'preserved-secret' },
        settings: { bridgeUrl: 'https://tyrion.example/api/connector/v1' },
        enabled: false,
      });
    });

    it('detects PostgreSQL scope drift under the connector lock', async () => {
      const repository = createPostgresFinanceOperatorPersistence(backend.context.pool);
      const dryRun = await repository.inventoryCleanBootstrap({
        connectorId,
        actorType: 'service',
        idempotencyKey: 'postgres-drift-dry-run-1234',
        leaseOwner,
        now,
      });
      await backend.context.pool.query(
        `DELETE FROM finance_accounts WHERE id = 'postgres-account'`,
      );
      await backend.context.pool.query(`
        INSERT INTO finance_accounts (
          id, connector_id, upstream_account_id, display_name, type,
          last_seen_generation_id, first_seen_at, last_seen_at
        ) VALUES (
          'postgres-account-drift', $1, 'private-account-drift',
          'Private account drift', 'credit', 'legacy-generation', $2, $2
        )
      `, [connectorId, now]);
      const accountCount = await backend.context.pool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM finance_accounts WHERE connector_id = $1`,
        [connectorId],
      );
      expect(accountCount.rows[0]?.count).toBe('1');
      await expect(repository.applyCleanBootstrap({
        connectorId,
        actorType: 'service',
        idempotencyKey: 'postgres-drift-apply-12345',
        leaseOwner,
        dryRunId: dryRun.dryRunId,
        scopeDigest: dryRun.scopeDigest,
        confirmationToken: dryRun.confirmationToken,
        now,
      })).rejects.toThrowError(expect.objectContaining({
        code: 'finance_clean_bootstrap_scope_drift',
      }));
    });
  });
} else {
  describe('PostgreSQL finance clean bootstrap', () => {
    it.skip('requires MC_TEST_POSTGRES_URL to run', () => undefined);
  });
}

afterAll(async () => {
  if (!initialized) return;
  await reset();
  await backend.shutdown();
  initialized = false;
});
