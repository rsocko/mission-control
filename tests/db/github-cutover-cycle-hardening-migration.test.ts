import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('GitHub cutover cycle hardening migration', () => {
  it('invalidates 0083 self-attested full evidence without replacing audit history', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id text PRIMARY KEY NOT NULL);
      CREATE TABLE github_identity_comparison_runs (
        id text PRIMARY KEY NOT NULL,
        connector_instance_id text NOT NULL,
        job_id text,
        identity_mode text NOT NULL,
        identity_mode_revision integer NOT NULL,
        sync_kind text NOT NULL,
        state text DEFAULT 'running' NOT NULL,
        page_count integer DEFAULT 0 NOT NULL,
        query_count integer DEFAULT 0 NOT NULL,
        outcome_counts text DEFAULT '{}' NOT NULL,
        lookup_latency_p50_ms integer,
        lookup_latency_p95_ms integer,
        lookup_latency_p99_ms integer,
        evidence_eligible integer DEFAULT false NOT NULL,
        started_at text NOT NULL,
        completed_at text,
        error_code text
      );
      CREATE TABLE github_identity_comparison_records (
        id text PRIMARY KEY NOT NULL,
        run_id text NOT NULL,
        surface text NOT NULL,
        candidate_key text NOT NULL
      );
      CREATE TABLE github_write_outcome_events (id text PRIMARY KEY NOT NULL);
      INSERT INTO connector_configs (id) VALUES ('connector');
      INSERT INTO github_write_outcome_events (id) VALUES ('preserved-audit');
      INSERT INTO github_identity_comparison_runs (
        id, connector_instance_id, identity_mode, identity_mode_revision,
        sync_kind, state, evidence_eligible, started_at, completed_at
      ) VALUES (
        'legacy-self-attested', 'connector', 'comparison', 1,
        'full', 'succeeded', 1,
        '2026-08-10T17:00:00.000Z', '2026-08-10T17:05:00.000Z'
      );
      INSERT INTO github_identity_comparison_records
        (id, run_id, surface, candidate_key)
      VALUES
        ('legacy-child', 'legacy-self-attested', 'sub_issue', 'sub_issue:issue:child'),
        ('legacy-parent', 'legacy-self-attested', 'sub_issue', 'sub_issue:issue:parent');
    `);

    applyStatements(sqlite, 'drizzle/0083_github_identity_evidence_reconciliation.sql', 4);
    expect(sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_expected_child_count AS expectedChildCount,
        sub_issue_expected_parent_count AS expectedParentCount
      FROM github_identity_comparison_runs
    `).get()).toEqual({
      generationComplete: 1,
      expectedChildCount: 1,
      expectedParentCount: 1,
    });
    applyMigration(sqlite);

    expect(sqlite.prepare(`
      SELECT
        evidence_eligible AS evidenceEligible,
        sub_issue_generation_complete AS generationComplete,
        sub_issue_expected_child_count AS expectedChildCount,
        sub_issue_expected_parent_count AS expectedParentCount,
        sub_issue_population_count AS populationCount,
        sub_issue_population_digest AS populationDigest,
        interruption_state AS interruptionState
      FROM github_identity_comparison_runs
      WHERE id = 'legacy-self-attested'
    `).get()).toEqual({
      evidenceEligible: 0,
      generationComplete: 0,
      expectedChildCount: 0,
      expectedParentCount: 0,
      populationCount: 0,
      populationDigest: null,
      interruptionState: 'none',
    });
    expect(sqlite.prepare('SELECT id FROM github_write_outcome_events').all())
      .toEqual([{ id: 'preserved-audit' }]);
    sqlite.close();
  });

  it('turns a running pre-migration comparison into an explicit blocker', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(`
      CREATE TABLE connector_configs (id text PRIMARY KEY NOT NULL);
      CREATE TABLE github_identity_comparison_runs (
        id text PRIMARY KEY NOT NULL,
        connector_instance_id text NOT NULL,
        job_id text,
        identity_mode text NOT NULL,
        identity_mode_revision integer NOT NULL,
        sync_kind text NOT NULL,
        state text DEFAULT 'running' NOT NULL,
        page_count integer DEFAULT 0 NOT NULL,
        query_count integer DEFAULT 0 NOT NULL,
        outcome_counts text DEFAULT '{}' NOT NULL,
        lookup_latency_p50_ms integer,
        lookup_latency_p95_ms integer,
        lookup_latency_p99_ms integer,
        evidence_eligible integer DEFAULT false NOT NULL,
        sub_issue_generation_complete integer DEFAULT false NOT NULL,
        sub_issue_expected_child_count integer DEFAULT 0 NOT NULL,
        sub_issue_expected_parent_count integer DEFAULT 0 NOT NULL,
        started_at text NOT NULL,
        completed_at text,
        error_code text
      );
      INSERT INTO connector_configs (id) VALUES ('connector');
      INSERT INTO github_identity_comparison_runs (
        id, connector_instance_id, identity_mode, identity_mode_revision,
        sync_kind, state, started_at
      ) VALUES (
        'interrupted-running', 'connector', 'comparison', 1,
        'incremental', 'running', '2026-08-10T17:00:00.000Z'
      );
    `);

    applyMigration(sqlite);

    expect(sqlite.prepare(`
      SELECT
        state,
        evidence_eligible AS evidenceEligible,
        interruption_state AS interruptionState,
        interruption_surface AS interruptionSurface,
        interruption_reason AS interruptionReason,
        completed_at AS completedAt,
        error_code AS errorCode
      FROM github_identity_comparison_runs
      WHERE id = 'interrupted-running'
    `).get()).toEqual({
      state: 'cancelled',
      evidenceEligible: 0,
      interruptionState: 'unresolved',
      interruptionSurface: 'comparison',
      interruptionReason: 'migration_interrupted_running_cycle',
      completedAt: '2026-08-10T17:00:00.000Z',
      errorCode: 'migration_interrupted',
    });
    sqlite.close();
  });
});

function applyMigration(sqlite: Database.Database): void {
  applyStatements(sqlite, 'drizzle/0086_red_greymalkin.sql');
}

function applyStatements(
  sqlite: Database.Database,
  path: string,
  limit?: number,
): void {
  const statements = readFileSync(
    resolve(process.cwd(), path),
    'utf8',
  ).split('--> statement-breakpoint');
  for (const statement of statements.slice(0, limit)) {
    if (statement.trim()) sqlite.exec(statement);
  }
}
