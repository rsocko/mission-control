import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll } from 'vitest';
import { createSqliteFinanceWebPersistence } from '@/db/persistence/sqlite-finance-web-repository';
import {
  describeFinanceWebPersistenceContract,
  FINANCE_WEB_BASE_TIME,
  FINANCE_WEB_CONNECTOR_ID,
  FINANCE_WEB_TRANSACTION_ID,
  type FinanceWebContractHarness,
} from '../contracts/finance-web-persistence.contract';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

const tempDirectory = mkdtempSync(join(tmpdir(), 'mc-finance-web-contract-'));
const databasePath = join(tempDirectory, 'finance-web.db');
let sqlite: Database.Database;

async function createHarness(): Promise<FinanceWebContractHarness> {
  process.env.MC_DB_PATH = databasePath;
  const dbModule = await importInitializedSqliteDatabase();
  sqlite = dbModule.sqlite;
  return {
    persistence: createSqliteFinanceWebPersistence(sqlite),
    async reset() {
      sqlite.exec(`
        DELETE FROM notifications;
        DELETE FROM finance_attribution_exceptions;
        DELETE FROM finance_mutation_audit;
        DELETE FROM finance_attribution_subjects;
        DELETE FROM finance_categories;
        DELETE FROM finance_transactions;
        DELETE FROM finance_sync_state;
        DELETE FROM kid_profiles;
        DELETE FROM connector_configs;
      `);
    },
    async seed() {
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at
        ) VALUES (?, 'finance-manager', 'Finance web contract', 1, 'poll',
          '{}', '{}', '{}', '[]', ?, ?)
      `).run(FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME, FINANCE_WEB_BASE_TIME);
      sqlite.exec(`
        INSERT INTO kid_profiles (id, name, color)
        VALUES ('finance-web-kid', 'Alex', '#111111'),
               ('finance-web-kid-empty', 'Blair', '#222222');
      `);
      sqlite.prepare(`
        INSERT INTO finance_sync_state (
          connector_id, status, attribution_status, attribution_policy_version,
          created_at, updated_at
        ) VALUES (?, 'succeeded', 'healthy', 7, ?, ?)
      `).run(FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME, FINANCE_WEB_BASE_TIME);
      sqlite.prepare(`
        INSERT INTO finance_attribution_subjects (
          id, connector_id, kid_id, policy_version, engine_version, first_seen_at, last_seen_at
        ) VALUES ('finance-web-subject', ?, 'finance-web-kid', 7, '1.0', ?, ?)
      `).run(FINANCE_WEB_CONNECTOR_ID, FINANCE_WEB_BASE_TIME, FINANCE_WEB_BASE_TIME);
      sqlite.prepare(`
        INSERT INTO finance_categories (
          id, connector_id, upstream_category_id, name, group_name,
          is_active, source_is_active, first_seen_at, last_seen_at
        ) VALUES ('finance-web-category', ?, 'category-groceries', 'Groceries', 'Food',
          1, 1, ?, ?)
      `).run(
        FINANCE_WEB_CONNECTOR_ID,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
      );
      sqlite.prepare(`
        INSERT INTO finance_transactions (
          id, connector_instance_id, upstream_transaction_id, date, amount,
          merchant_name, assigned_kid_id, triage_status, is_pending, is_recurring,
          tags, tag_references, lifecycle_status, source_fingerprint,
          attribution_reasons, attribution_retryable,
          first_seen_at, last_seen_at, synced_at
        ) VALUES (?, ?, 'upstream-transaction', '2026-08-10', -25,
          'Invented merchant', 'finance-web-kid', 'pending', 0, 0,
          '["Household"]', '["tag-1"]', 'active', 'source-fingerprint',
          '["account-rule"]', 0, ?, ?, ?)
      `).run(
        FINANCE_WEB_TRANSACTION_ID,
        FINANCE_WEB_CONNECTOR_ID,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
      );
      sqlite.prepare(`
        INSERT INTO finance_transactions (
          id, connector_instance_id, upstream_transaction_id, date, amount,
          merchant_name, assigned_kid_id, confirmed_category, triage_status,
          is_pending, is_recurring, tags, tag_references, lifecycle_status,
          source_fingerprint, attribution_reasons, attribution_retryable,
          first_seen_at, last_seen_at, synced_at
        ) VALUES ('finance:web-contract:transaction-z', ?, 'upstream-transaction-z',
          '2026-08-10', -25, 'Second merchant', 'finance-web-kid-empty', 'Dining',
          'confirmed', 0, 0, '[]', '[]', 'active', 'source-fingerprint-z',
          '[]', 0, ?, ?, ?)
      `).run(
        FINANCE_WEB_CONNECTOR_ID,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
      );
      sqlite.prepare(`
        INSERT INTO finance_attribution_exceptions (
          id, connector_id, transaction_id, status, reason_code, retryable,
          review_state, source_fingerprint, occurrence_count,
          created_at, first_observed_at, last_observed_at, updated_at
        ) VALUES ('finance-web-exception', ?, ?, 'open', 'needs-review', 1,
          'pending', 'source-fingerprint', 1, ?, ?, ?, ?)
      `).run(
        FINANCE_WEB_CONNECTOR_ID,
        FINANCE_WEB_TRANSACTION_ID,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
        FINANCE_WEB_BASE_TIME,
      );
      const insertNotification = sqlite.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, body,
          level, level_rank, category, template_key, state, read_state,
          disposition, source_state, sync_state, is_actionable,
          received_at, sort_at, reconcile_attempts, metadata, presentation
        ) VALUES (?, ?, 'finance-manager', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active',
          'synced', 1, ?, ?, 0, '{}', '{}')
      `);
      insertNotification.run(
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
        '2026-08-20T12:00:00.000Z',
      );
      insertNotification.run(
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
        '2026-08-20T12:00:00.000Z',
      );
      insertNotification.run(
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
        '2026-08-20T10:00:00.000Z',
      );
    },
    async notification(id) {
      return (sqlite.prepare(`
        SELECT state, read_state AS readState, disposition
        FROM notifications WHERE id = ?
      `).get(id) as Awaited<ReturnType<FinanceWebContractHarness['notification']>>) ?? null;
    },
    async transactionCategory() {
      const row = sqlite.prepare(`
        SELECT confirmed_category AS category FROM finance_transactions WHERE id = ?
      `).get(FINANCE_WEB_TRANSACTION_ID) as { category: string | null } | undefined;
      return row?.category ?? null;
    },
    async mutation(idempotencyKey) {
      return (sqlite.prepare(`
        SELECT status, attempt_count AS attemptCount
        FROM finance_mutation_audit WHERE connector_id = ? AND idempotency_key = ?
      `).get(
        FINANCE_WEB_CONNECTOR_ID,
        idempotencyKey,
      ) as Awaited<ReturnType<FinanceWebContractHarness['mutation']>>) ?? null;
    },
  };
}

describeFinanceWebPersistenceContract('SQLite', createHarness);

afterAll(() => {
  delete process.env.MC_DB_PATH;
  sqlite?.close();
  rmSync(tempDirectory, { recursive: true, force: true });
});
