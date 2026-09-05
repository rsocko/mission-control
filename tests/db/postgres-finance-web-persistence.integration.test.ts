import { afterAll, describe } from 'vitest';
import type { Pool, QueryResultRow } from 'pg';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresFinanceWebPersistence } from '@/db/postgres/repositories/finance-web-repository';
import {
  describeFinanceWebPersistenceContract,
  FINANCE_WEB_BASE_TIME,
  FINANCE_WEB_CONNECTOR_ID,
  FINANCE_WEB_TRANSACTION_ID,
  type FinanceWebContractHarness,
} from '../contracts/finance-web-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-finance-web-contract',
        }),
      }
    : {}),
});
let initialized = false;

async function pool(): Promise<Pool> {
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  if (!initialized) {
    assertSafeIntegrationTestTarget(connectionString);
    await backend.initialize();
    initialized = true;
  }
  return backend.context.pool;
}

async function row<T extends QueryResultRow>(
  sql: string,
  params: readonly unknown[],
): Promise<T | null> {
  return ((await (await pool()).query(sql, [...params])).rows[0] as T | undefined) ?? null;
}

async function createHarness(): Promise<FinanceWebContractHarness> {
  const database = await pool();
  return {
    persistence: createPostgresFinanceWebPersistence(database),
    async reset() {
      await database.query(
        `DELETE FROM notifications
         WHERE connector_instance_id = $1 OR id = 'finance-web-notification-other'`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_attribution_exceptions WHERE connector_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_mutation_audit WHERE connector_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_attribution_subjects WHERE connector_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_categories WHERE connector_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_transactions WHERE connector_instance_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM finance_sync_state WHERE connector_id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM connector_configs WHERE id = $1`,
        [FINANCE_WEB_CONNECTOR_ID],
      );
      await database.query(
        `DELETE FROM kid_profiles WHERE id IN ('finance-web-kid', 'finance-web-kid-empty')`,
      );
    },
    async seed() {
      await database.query(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES ($1, 'finance-manager', 'Finance web contract', true, 'poll',
          '{}', '{}', '{}', '[]', $2, $2)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO kid_profiles (id, name, color)
        VALUES ('finance-web-kid', 'Alex', '#111111'),
               ('finance-web-kid-empty', 'Blair', '#222222')
      `);
      await database.query(`
        INSERT INTO finance_sync_state (
          connector_id, status, attribution_status, attribution_policy_version,
          created_at, updated_at
        ) VALUES ($1, 'succeeded', 'healthy', 7, $2, $2)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO finance_attribution_subjects (
          id, connector_id, kid_id, policy_version, engine_version, first_seen_at, last_seen_at
        ) VALUES ('finance-web-subject', $1, 'finance-web-kid', 7, '1.0', $2, $2)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO finance_categories (
          id, connector_id, upstream_category_id, name, group_name,
          is_active, source_is_active, first_seen_at, last_seen_at
        ) VALUES ('finance-web-category', $1, 'category-groceries', 'Groceries', 'Food',
          true, true, $2, $2)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO finance_transactions (
          id, connector_instance_id, upstream_transaction_id, date, amount,
          merchant_name, assigned_kid_id, triage_status, is_pending, is_recurring,
          tags, tag_references, lifecycle_status, source_fingerprint,
          attribution_reasons, attribution_retryable,
          first_seen_at, last_seen_at, synced_at
        ) VALUES ($1, $2, 'upstream-transaction', '2026-08-10', -25,
          'Invented merchant', 'finance-web-kid', 'pending', false, false,
          '["Household"]'::jsonb, '["tag-1"]'::jsonb, 'active', 'source-fingerprint',
          '["account-rule"]'::jsonb, false, $3, $3, $3)
      `, [FINANCE_WEB_TRANSACTION_ID, FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO finance_transactions (
          id, connector_instance_id, upstream_transaction_id, date, amount,
          merchant_name, assigned_kid_id, confirmed_category, triage_status,
          is_pending, is_recurring, tags, tag_references, lifecycle_status,
          source_fingerprint, attribution_reasons, attribution_retryable,
          first_seen_at, last_seen_at, synced_at
        ) VALUES ('finance:web-contract:transaction-z', $1, 'upstream-transaction-z',
          '2026-08-10', -25, 'Second merchant', 'finance-web-kid-empty', 'Dining',
          'confirmed', false, false, '[]'::jsonb, '[]'::jsonb, 'active',
          'source-fingerprint-z', '[]'::jsonb, false, $2, $2, $2)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME]);
      await database.query(`
        INSERT INTO finance_attribution_exceptions (
          id, connector_id, transaction_id, status, reason_code, retryable,
          review_state, source_fingerprint, occurrence_count,
          created_at, first_observed_at, last_observed_at, updated_at
        ) VALUES ('finance-web-exception', $1, $2, 'open', 'needs-review', true,
          'pending', 'source-fingerprint', 1, $3, $3, $3, $3)
      `, [FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_TRANSACTION_ID, FINANCE_WEB_BASE_TIME]);
      const insertNotification = `
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, body,
          level, level_rank, category, template_key, state, read_state,
          disposition, source_state, sync_state, is_actionable,
          received_at, sort_at, reconcile_attempts, metadata, presentation
        ) VALUES ($1, $2, 'finance-manager', $3, $4, $5, $6, $7, $8, $9, $10, $11,
          $12, 'active', 'synced', true, $13, $13, 0, '{}'::jsonb, '{}'::jsonb)
      `;
      await database.query(insertNotification, [
        'finance-web-notification-action',
        'source-action',
        FINANCE_WEB_CONNECTOR_ID,
        'Needs action',
        'Review the transaction',
        'action_needed',
        1,
        'finance',
        'budget_warning',
        'unread',
        'unread',
        'inbox',
        '2026-08-20T12:00:00.000Z',
      ]);
      await database.query(insertNotification, [
        'finance-web-notification-dismissed',
        'source-dismissed',
        FINANCE_WEB_CONNECTOR_ID,
        'Dismissed',
        null,
        'fyi',
        3,
        'finance',
        'digest',
        'dismissed',
        'read',
        'dismissed',
        '2026-08-20T12:00:00.000Z',
      ]);
      await database.query(insertNotification, [
        'finance-web-notification-other',
        'source-other',
        FINANCE_WEB_CONNECTOR_ID,
        'Other',
        null,
        'heads_up',
        2,
        'development',
        null,
        'unread',
        'unread',
        'inbox',
        '2026-08-20T10:00:00.000Z',
      ]);
    },
    notification: (id) => row(
      `SELECT state, read_state AS "readState", disposition FROM notifications WHERE id = $1`,
      [id],
    ),
    async transactionCategory() {
      const result = await row<{ category: string | null }>(
        `SELECT confirmed_category AS category FROM finance_transactions WHERE id = $1`,
        [FINANCE_WEB_TRANSACTION_ID],
      );
      return result?.category ?? null;
    },
    mutation: (idempotencyKey) => row(
      `SELECT status, attempt_count AS "attemptCount"
       FROM finance_mutation_audit WHERE connector_id = $1 AND idempotency_key = $2`,
      [FINANCE_WEB_CONNECTOR_ID, idempotencyKey],
    ),
  };
}

describePostgres('PostgreSQL finance web persistence integration', () => {
  describeFinanceWebPersistenceContract('PostgreSQL', createHarness);
});

afterAll(async () => {
  if (initialized) {
    const harness = await createHarness();
    await harness.reset();
    await backend.shutdown();
  }
});
