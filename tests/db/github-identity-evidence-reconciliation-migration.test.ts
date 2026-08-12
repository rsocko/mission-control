import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub identity evidence reconciliation migration', () => {
  it('backfills only proven sub-issue generations and unambiguous write-cycle ownership', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE github_identity_comparison_runs (
        id text PRIMARY KEY NOT NULL,
        connector_instance_id text NOT NULL,
        sync_kind text NOT NULL,
        state text NOT NULL,
        evidence_eligible integer NOT NULL,
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
      CREATE TABLE github_identity_write_cycles (
        id text PRIMARY KEY NOT NULL,
        connector_instance_id text NOT NULL,
        comparison_run_id text,
        state text NOT NULL,
        started_at text NOT NULL,
        completed_at text
      );
      CREATE TABLE task_source_write_leases (
        id text PRIMARY KEY NOT NULL,
        comparison_run_id text,
        state text NOT NULL,
        updated_at text NOT NULL
      );

      INSERT INTO github_identity_comparison_runs
        (id, connector_instance_id, sync_kind, state, evidence_eligible, started_at)
      VALUES
        ('eligible-full', 'eligible', 'full', 'succeeded', 1, '2026-08-10T10:00:00.000Z'),
        ('ineligible-full', 'ineligible', 'full', 'succeeded', 0, '2026-08-10T10:00:00.000Z'),
        ('eligible-incremental', 'incremental', 'incremental', 'succeeded', 1, '2026-08-10T10:00:00.000Z');
      INSERT INTO github_identity_comparison_records
        (id, run_id, surface, candidate_key)
      VALUES
        ('child-1', 'eligible-full', 'sub_issue', 'sub_issue:acme/app:1:child'),
        ('child-2', 'eligible-full', 'sub_issue', 'sub_issue:acme/app:2:child'),
        ('child-3', 'eligible-full', 'sub_issue', 'sub_issue:acme/app:3:child'),
        ('parent-2', 'eligible-full', 'sub_issue', 'sub_issue:acme/app:2:parent'),
        ('ineligible-child', 'ineligible-full', 'sub_issue', 'sub_issue:acme/app:4:child'),
        ('incremental-child', 'eligible-incremental', 'sub_issue', 'sub_issue:acme/app:5:child'),
        ('write-record', 'single-cycle-run', 'write_route', 'write_route:task:update:single-lease');

      INSERT INTO github_identity_write_cycles
        (id, connector_instance_id, comparison_run_id, state, started_at)
      VALUES
        ('single-cycle', 'connector-a', 'single-cycle-run', 'interrupted', '2026-08-10T10:00:00.000Z'),
        ('shared-cycle-1', 'connector-b', 'shared-run', 'running', '2026-08-10T10:00:00.000Z'),
        ('shared-cycle-2', 'connector-b', 'shared-run', 'running', '2026-08-10T11:00:00.000Z');
      INSERT INTO task_source_write_leases
        (id, comparison_run_id, state, updated_at)
      VALUES
        ('single-lease', 'single-cycle-run', 'failed', '2026-08-10T12:00:00.000Z'),
        ('shared-lease', 'shared-run', 'claimed', '2026-08-10T12:00:00.000Z');
    `);

    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0083_github_identity_evidence_reconciliation.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT
        sub_issue_generation_complete AS generationComplete,
        sub_issue_expected_child_count AS expectedChildCount,
        sub_issue_expected_parent_count AS expectedParentCount
      FROM github_identity_comparison_runs
      WHERE id = 'eligible-full'
    `).get()).toEqual({
      generationComplete: 1,
      expectedChildCount: 3,
      expectedParentCount: 1,
    });
    expect(sqlite.prepare(`
      SELECT id, sub_issue_generation_complete AS generationComplete
      FROM github_identity_comparison_runs
      WHERE id IN ('eligible-incremental', 'ineligible-full')
      ORDER BY id
    `).all()).toEqual([
      { id: 'eligible-incremental', generationComplete: 0 },
      { id: 'ineligible-full', generationComplete: 0 },
    ]);
    expect(sqlite.prepare(`
      SELECT
        id,
        write_cycle_id AS writeCycleId,
        cycle_observed_at AS cycleObservedAt,
        cycle_outcome AS cycleOutcome
      FROM task_source_write_leases
      ORDER BY id
    `).all()).toEqual([
      {
        id: 'shared-lease',
        writeCycleId: null,
        cycleObservedAt: null,
        cycleOutcome: null,
      },
      {
        id: 'single-lease',
        writeCycleId: 'single-cycle',
        cycleObservedAt: '2026-08-10T12:00:00.000Z',
        cycleOutcome: 'failed',
      },
    ]);
    expect(sqlite.prepare(`
      SELECT id, state
      FROM github_identity_write_cycles
      WHERE connector_instance_id = 'connector-b'
      ORDER BY id
    `).all()).toEqual([
      { id: 'shared-cycle-1', state: 'interrupted' },
      { id: 'shared-cycle-2', state: 'running' },
    ]);
    expect(() => sqlite.exec(`
      INSERT INTO github_identity_write_cycles
        (id, connector_instance_id, state, started_at)
      VALUES
        ('shared-cycle-3', 'connector-b', 'running', '2026-08-10T12:00:00.000Z')
    `)).toThrow();
    expect(() => sqlite.exec(`
      UPDATE github_identity_write_cycles
      SET reconciliation_idempotency_key = 'same-key'
      WHERE id IN ('shared-cycle-1', 'shared-cycle-2')
    `)).toThrow();
    sqlite.close();
  });
});
