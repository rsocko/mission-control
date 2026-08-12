import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('finance snapshot migration', () => {
  it('preserves legacy attribution and enforces connector-scoped upstream identity', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id text PRIMARY KEY NOT NULL, type text NOT NULL, name text NOT NULL,
        enabled integer DEFAULT true NOT NULL, sync_mode text DEFAULT 'poll' NOT NULL,
        poll_interval_minutes integer, capabilities text NOT NULL,
        credentials text DEFAULT '{}' NOT NULL, settings text DEFAULT '{}' NOT NULL,
        synced_lists text DEFAULT '[]' NOT NULL, created_at text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE finance_transactions (
        id text PRIMARY KEY NOT NULL, date text NOT NULL, amount real NOT NULL,
        merchant_name text, original_category text, confirmed_category text,
        account_id text, account_name text, card_last4 text, assigned_kid_id text,
        kid_assignment_method text, triage_status text DEFAULT 'pending' NOT NULL,
        flag_reason text, is_recurring integer DEFAULT false NOT NULL, notes text,
        tags text DEFAULT '[]' NOT NULL, synced_at text NOT NULL
      );
      INSERT INTO finance_transactions (
        id, date, amount, assigned_kid_id, triage_status, confirmed_category, synced_at
      ) VALUES (
        'legacy-1', '2026-08-01', -5, 'kid-1', 'confirmed', 'category-local',
        '2026-08-02T00:00:00.000Z'
      );
      INSERT INTO finance_transactions (
        id, date, amount, assigned_kid_id, kid_assignment_method,
        triage_status, synced_at
      ) VALUES (
        'automated-legacy', '2026-08-01', -5, 'kid-2', 'card_rule',
        'pending', '2026-08-02T00:00:00.000Z'
      );
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0062_melodic_squirrel_girl.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT connector_instance_id AS connectorId,
             upstream_transaction_id AS upstreamId,
             assigned_kid_id AS kidId,
             triage_status AS triageStatus,
             confirmed_category AS confirmedCategory
      FROM finance_transactions WHERE id = 'legacy-1'
    `).get()).toEqual({
      connectorId: 'finance-manager-default',
      upstreamId: 'legacy-1',
      kidId: 'kid-1',
      triageStatus: 'confirmed',
      confirmedCategory: 'category-local',
    });
    expect(sqlite.prepare(`
      SELECT id, enabled, settings FROM connector_configs WHERE type = 'finance-manager'
    `).get()).toEqual({
      id: 'finance-manager-default',
      enabled: 1,
      settings: '{"bridgeUrl":"http://localhost:8100"}',
    });
    const originMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0079_clear_legacy_tyrion_origin.sql'),
      'utf8',
    );
    sqlite.exec(originMigration);
    expect(sqlite.prepare(`
      SELECT settings FROM connector_configs WHERE id = 'finance-manager-default'
    `).get()).toEqual({ settings: '{}' });
    const upstreamColumn = sqlite.prepare(`PRAGMA table_info(finance_transactions)`)
      .all()
      .find((column) => (column as { name: string }).name === 'upstream_transaction_id') as
      | { notnull: number }
      | undefined;
    expect(upstreamColumn?.notnull).toBe(1);
    expect(() => sqlite.prepare(`
      INSERT INTO finance_transactions (
        id, connector_instance_id, upstream_transaction_id, date, amount,
        triage_status, is_pending, is_recurring, tags, lifecycle_status,
        source_fingerprint, first_seen_at, last_seen_at, synced_at
      ) VALUES (
        'duplicate', 'finance-manager-default', 'legacy-1', '2026-08-01', -5,
        'pending', 0, 0, '[]', 'active', '', CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run()).toThrow();
    const attributionMigration = readFileSync(
      resolve(process.cwd(), 'drizzle/0063_brown_avengers.sql'),
      'utf8',
    );
    for (const statement of attributionMigration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }
    expect(sqlite.prepare(`
      SELECT manual_decision_action AS action,
             attribution_status AS status,
             attribution_method AS method,
             attribution_review_state AS reviewState
      FROM finance_transactions WHERE id = 'legacy-1'
    `).get()).toEqual({
      action: 'assign-kid',
      status: 'attributed',
      method: 'manual',
      reviewState: 'resolved',
    });
    expect(sqlite.prepare(`
      SELECT kid_assignment_method AS method, attribution_status AS status
      FROM finance_transactions WHERE id = 'automated-legacy'
    `).get()).toEqual({ method: 'card_rule', status: 'pending' });
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all())
      .toEqual(expect.arrayContaining([
        { name: 'finance_sync_state' },
        { name: 'finance_mutation_audit' },
        { name: 'finance_attribution_subjects' },
        { name: 'finance_attribution_exceptions' },
        { name: 'finance_attribution_audit' },
      ]));
    sqlite.close();
  });
});
