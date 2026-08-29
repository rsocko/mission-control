import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  resolve(process.cwd(), 'drizzle/0117_simplify_tyrion_identities.sql'),
  'utf8',
).replaceAll('--> statement-breakpoint', '');

describe('Tyrion connector identity migration', () => {
  it('adds protected identity state and removes obsolete parity settings', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE connector_configs (
        id text PRIMARY KEY,
        type text NOT NULL,
        credentials text,
        settings text,
        updated_at text NOT NULL
      );
      CREATE TABLE finance_insight_publications (id text PRIMARY KEY, connector_id text NOT NULL);
      CREATE TABLE finance_insight_publication_facts (publication_id text NOT NULL);
      CREATE TABLE finance_insight_publication_delivery (publication_id text NOT NULL);
      CREATE TABLE finance_insight_cutovers (
        connector_id text PRIMARY KEY,
        delivery_enabled integer NOT NULL,
        rolled_back_at text,
        result text NOT NULL,
        updated_at text NOT NULL
      );
      CREATE TABLE finance_insight_publication_state (
        connector_id text PRIMARY KEY,
        latest_publication_id text,
        last_capture_outcome text,
        last_error_code text,
        updated_at text NOT NULL
      );
      CREATE TABLE finance_insight_transaction_projection_facts (connector_id text NOT NULL);
      CREATE TABLE finance_insight_transaction_projection_windows (connector_id text NOT NULL);
      CREATE TABLE finance_insight_transaction_projection_state (connector_id text NOT NULL);
      CREATE TABLE finance_insight_transaction_backfill_plans (
        id text PRIMARY KEY,
        connector_id text NOT NULL
      );
      CREATE TABLE finance_insight_transaction_window_proofs (plan_id text NOT NULL);
      CREATE TABLE finance_dataset_sync_state (connector_id text NOT NULL);
      CREATE TABLE finance_insight_occurrences (connector_id text NOT NULL);
      CREATE TABLE finance_insight_occurrence_cache_state (connector_id text NOT NULL);
      CREATE TABLE finance_attribution_exceptions (connector_id text NOT NULL);
      CREATE TABLE finance_attribution_subjects (connector_id text NOT NULL);
      CREATE TABLE finance_transactions (
        id text PRIMARY KEY,
        connector_instance_id text NOT NULL,
        assigned_kid_id text,
        kid_assignment_method text,
        manual_decision_action text,
        attribution_source_ref text,
        attribution_contract_version text,
        attribution_status text NOT NULL,
        attribution_confidence text,
        attribution_method text,
        attribution_explanation text,
        attribution_reasons text NOT NULL,
        attribution_decision_source text,
        attribution_policy_version integer,
        attribution_engine_version text,
        attribution_evaluated_at text,
        attribution_review_state text NOT NULL,
        attribution_provenance text,
        attribution_last_error_code text,
        attribution_retryable integer NOT NULL,
        attribution_updated_at text
      );
      CREATE TABLE finance_sync_state (
        connector_id text PRIMARY KEY,
        attribution_status text NOT NULL,
        attribution_last_attempt_at text,
        attribution_last_successful_at text,
        attribution_last_error_code text,
        attribution_policy_version integer,
        attribution_engine_version text,
        updated_at text NOT NULL
      );
      INSERT INTO connector_configs VALUES (
        'finance-one',
        'finance-manager',
        '{"serviceToken":"invented-token"}',
        '{"householdCurrency":"USD","cardRuleFingerprintParityProven":true,"cardRuleFingerprintParityProvenAt":"2026-08-22T00:00:00.000Z"}',
        '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO connector_configs VALUES (
        'other-one',
        'custom-rest',
        '{}',
        '{"cardRuleFingerprintParityProven":true}',
        '2026-08-22T00:00:00.000Z'
      );
      INSERT INTO finance_insight_publications VALUES
        ('finance-publication', 'finance-one'),
        ('other-publication', 'other-one');
      INSERT INTO finance_insight_publication_facts VALUES
        ('finance-publication'),
        ('other-publication');
      INSERT INTO finance_insight_publication_delivery VALUES
        ('finance-publication'),
        ('other-publication');
      INSERT INTO finance_insight_cutovers VALUES
        ('finance-one', 1, NULL, '{"status":"enabled"}', '2026-08-22T00:00:00.000Z'),
        ('other-one', 1, NULL, '{"status":"enabled"}', '2026-08-22T00:00:00.000Z');
      INSERT INTO finance_insight_publication_state VALUES
        ('finance-one', 'finance-publication', 'captured', NULL, '2026-08-22T00:00:00.000Z'),
        ('other-one', 'other-publication', 'captured', NULL, '2026-08-22T00:00:00.000Z');
      INSERT INTO finance_insight_transaction_projection_facts VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_insight_transaction_projection_windows VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_insight_transaction_projection_state VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_insight_transaction_backfill_plans VALUES
        ('finance-plan', 'finance-one'),
        ('other-plan', 'other-one');
      INSERT INTO finance_insight_transaction_window_proofs VALUES ('finance-plan'), ('other-plan');
      INSERT INTO finance_dataset_sync_state VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_insight_occurrences VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_insight_occurrence_cache_state VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_attribution_exceptions VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_attribution_subjects VALUES ('finance-one'), ('other-one');
      INSERT INTO finance_transactions VALUES
        (
          'automated', 'finance-one', 'kid-one', 'card-rule', NULL,
          'source-v1:legacy', '1.0', 'attributed', 'definite', 'card-rule',
          'Legacy rule', '["card-rule-conflict"]', 'automated', 2, '1.0.0',
          '2026-08-22T00:00:00.000Z', 'pending', 'mission-control-normalized-v1',
          NULL, 0, '2026-08-22T00:00:00.000Z'
        ),
        (
          'manual', 'finance-one', 'kid-two', 'manual', 'assign-kid',
          'source-v1:manual', '1.0', 'attributed', 'definite', 'manual',
          'Manual decision', '[]', 'manual', 2, '1.0.0',
          '2026-08-22T00:00:00.000Z', 'resolved', 'mission-control-legacy-manual-v1',
          NULL, 0, '2026-08-22T00:00:00.000Z'
        );
      INSERT INTO finance_sync_state VALUES
        (
          'finance-one', 'succeeded', '2026-08-22T00:00:00.000Z',
          '2026-08-22T00:00:00.000Z', NULL, 2, '1.0.0',
          '2026-08-22T00:00:00.000Z'
        ),
        (
          'other-one', 'succeeded', '2026-08-22T00:00:00.000Z',
          '2026-08-22T00:00:00.000Z', NULL, 2, '1.0.0',
          '2026-08-22T00:00:00.000Z'
        );
    `);

    sqlite.exec(migration);

    const finance = sqlite.prepare(`
      SELECT credentials, settings FROM connector_configs WHERE id = 'finance-one'
    `).get() as { credentials: string; settings: string };
    expect(JSON.parse(finance.credentials)).toEqual({
      serviceToken: 'invented-token',
      identityNamespace: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.parse(finance.settings)).toEqual({ householdCurrency: 'USD' });
    expect(JSON.parse((sqlite.prepare(`
      SELECT settings FROM connector_configs WHERE id = 'other-one'
    `).get() as { settings: string }).settings)).toEqual({
      cardRuleFingerprintParityProven: true,
    });
    expect(sqlite.prepare(`
      SELECT latest_publication_id AS latestPublicationId
      FROM finance_insight_publication_state WHERE connector_id = 'finance-one'
    `).get()).toEqual({ latestPublicationId: null });
    for (const [table, column] of [
      ['finance_insight_publications', 'connector_id'],
      ['finance_insight_transaction_projection_facts', 'connector_id'],
      ['finance_insight_transaction_projection_windows', 'connector_id'],
      ['finance_insight_transaction_projection_state', 'connector_id'],
      ['finance_insight_transaction_backfill_plans', 'connector_id'],
      ['finance_dataset_sync_state', 'connector_id'],
      ['finance_insight_occurrences', 'connector_id'],
      ['finance_insight_occurrence_cache_state', 'connector_id'],
      ['finance_attribution_subjects', 'connector_id'],
    ]) {
      expect((sqlite.prepare(`
        SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = 'finance-one'
      `).get() as { count: number }).count).toBe(0);
      expect((sqlite.prepare(`
        SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = 'other-one'
      `).get() as { count: number }).count).toBe(1);
    }
    expect((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_publication_facts
      WHERE publication_id = 'finance-publication'
    `).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_publication_delivery
      WHERE publication_id = 'finance-publication'
    `).get() as { count: number }).count).toBe(0);
    expect(sqlite.prepare(`
      SELECT delivery_enabled AS deliveryEnabled, result
      FROM finance_insight_cutovers WHERE connector_id = 'finance-one'
    `).get()).toEqual({
      deliveryEnabled: 0,
      result: '{"status":"rolled-back","reason":"identity-contract-upgraded"}',
    });
    expect(sqlite.prepare(`
      SELECT delivery_enabled AS deliveryEnabled
      FROM finance_insight_cutovers WHERE connector_id = 'other-one'
    `).get()).toEqual({ deliveryEnabled: 1 });
    expect((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_transaction_window_proofs
      WHERE plan_id = 'finance-plan'
    `).get() as { count: number }).count).toBe(0);
    expect((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_insight_transaction_window_proofs
      WHERE plan_id = 'other-plan'
    `).get() as { count: number }).count).toBe(1);
    expect((sqlite.prepare(`
      SELECT COUNT(*) AS count FROM finance_attribution_exceptions
      WHERE connector_id = 'finance-one'
    `).get() as { count: number }).count).toBe(0);
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, kid_assignment_method AS method,
             attribution_source_ref AS sourceRef,
             attribution_contract_version AS contractVersion,
             attribution_status AS status, attribution_reasons AS reasons
      FROM finance_transactions WHERE id = 'automated'
    `).get()).toEqual({
      kidId: null,
      method: null,
      sourceRef: null,
      contractVersion: null,
      status: 'pending',
      reasons: '[]',
    });
    expect(sqlite.prepare(`
      SELECT assigned_kid_id AS kidId, kid_assignment_method AS method,
             attribution_source_ref AS sourceRef,
             attribution_contract_version AS contractVersion,
             attribution_status AS status
      FROM finance_transactions WHERE id = 'manual'
    `).get()).toEqual({
      kidId: 'kid-two',
      method: 'manual',
      sourceRef: 'source-v1:manual',
      contractVersion: '1.0',
      status: 'attributed',
    });
    expect(sqlite.prepare(`
      SELECT attribution_status AS status,
             attribution_policy_version AS policyVersion,
             attribution_engine_version AS engineVersion
      FROM finance_sync_state WHERE connector_id = 'finance-one'
    `).get()).toEqual({
      status: 'idle',
      policyVersion: null,
      engineVersion: null,
    });
    expect(sqlite.prepare(`
      SELECT attribution_status AS status FROM finance_sync_state
      WHERE connector_id = 'other-one'
    `).get()).toEqual({ status: 'succeeded' });
    sqlite.close();
  });

  it('is recorded in the migration journal', () => {
    const journal = JSON.parse(readFileSync(
      resolve(process.cwd(), 'drizzle/meta/_journal.json'),
      'utf8',
    )) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries).toContainEqual({
      idx: 117,
      version: '6',
      when: 1787505600000,
      tag: '0117_simplify_tyrion_identities',
      breakpoints: true,
    });
  });
});
