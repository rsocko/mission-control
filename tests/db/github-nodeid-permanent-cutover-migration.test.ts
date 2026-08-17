import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const JOURNAL = JSON.parse(
  readFileSync(resolve(process.cwd(), 'drizzle/meta/_journal.json'), 'utf8'),
) as { entries: Array<{ idx: number; tag: string }> };

const CUTOVER_TAG = '0102_github_nodeid_permanent_cutover';

function applyMigration(
  sqlite: Database.Database,
  tag: string,
  options: { tolerateExisting?: boolean } = {},
): void {
  const sql = readFileSync(resolve(process.cwd(), `drizzle/${tag}.sql`), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (!statement.trim()) continue;
    try {
      sqlite.exec(statement);
    } catch (error) {
      // The production runner tolerates historical idempotency errors in older
      // migrations; the cutover migration itself is always applied strictly.
      const message = error instanceof Error ? error.message : String(error);
      if (
        !options.tolerateExisting
        || !/duplicate column name|already exists|no such table|no such column|DROP COLUMN/
          .test(message)
      ) throw error;
    }
  }
}

/**
 * Builds the real production schema by replaying every migration up to (but not
 * including) the permanent cutover, so the rebuild is exercised against the same
 * foreign keys, checks, and indexes production has.
 */
function openPreCutoverDatabase(): Database.Database {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const entry of JOURNAL.entries) {
    if (entry.tag === CUTOVER_TAG) break;
    applyMigration(sqlite, entry.tag, { tolerateExisting: true });
  }
  return sqlite;
}

function seedPreCutoverFixture(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials, settings,
      synced_lists, created_at, updated_at
    ) VALUES (
      'github-1', 'github-issues', 'GitHub', 1, 'bidirectional', '{}', '{}', '{}',
      '[]', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'
    );
    INSERT INTO github_identity_migrations (connector_instance_id, phase, updated_at)
    VALUES ('github-1', 'complete', '2026-08-01T00:00:00.000Z');
    INSERT INTO github_identity_controls (
      connector_instance_id, stable_primary_enabled, mode_revision, updated_at
    ) VALUES ('github-1', 1, 7, '2026-08-01T00:00:00.000Z');

    INSERT INTO tasks (
      id, title, status, source_id, connector_type, connector_instance_id,
      last_synced_at, created_at, updated_at
    ) VALUES
      ('task-parent', 'Parent', 'todo', 'octo/repo:1', 'github-issues', 'github-1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('task-child', 'Child', 'todo', 'octo/repo:2', 'github-issues', 'github-1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z'),
      ('task-gone', 'Gone', 'cancelled', 'octo/repo:3', 'github-issues', 'github-1', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z');
    UPDATE tasks SET parent_id = 'task-parent', depth = 1 WHERE id = 'task-child';

    INSERT INTO github_identity_comparison_runs (
      id, connector_instance_id, identity_mode, identity_mode_revision, sync_kind,
      state, evidence_eligible, started_at
    ) VALUES
      ('run-old', 'github-1', 'stable', 7, 'full', 'succeeded', 1, '2026-08-02T00:00:00.000Z'),
      ('run-new', 'github-1', 'stable', 7, 'incremental', 'succeeded', 0, '2026-08-03T00:00:00.000Z');
    INSERT INTO github_identity_comparison_records (
      id, run_id, surface, candidate_key, local_task_id, legacy_action, stable_action,
      outcome, reason, created_at
    ) VALUES
      ('record-1', 'run-old', 'sub_issue', 'sub_issue:octo/repo:2:child', 'task-child',
       'present', 'present', 'agreement', 'exact_match', '2026-08-02T00:00:00.000Z'),
      ('record-2', 'run-old', 'deletion', 'task:octo/repo:3', 'task-gone',
       'delete_candidate', 'none', 'inaccessible', 'access_denied', '2026-08-02T00:00:00.000Z');
    INSERT INTO github_identity_sub_issue_population_members (
      id, run_id, local_task_id, source_id_digest, issue_number, member_digest, observed, created_at
    ) VALUES (
      'member-1', 'run-old', 'task-child', '${'a'.repeat(64)}', 2, '${'b'.repeat(64)}', 1,
      '2026-08-02T00:00:00.000Z'
    );

    INSERT INTO github_identity_write_cycles (
      id, connector_instance_id, comparison_run_id, effective_mode, mode_revision,
      pending_candidate_count, observed_route_count, legacy_applied_count,
      blocked_count, failed_count, unknown_count, state, reconciliation_state, started_at
    ) VALUES (
      'cycle-1', 'github-1', 'run-new', 'stable', 7, 2, 2, 1, 0, 0, 1,
      'interrupted', 'unresolved', '2026-08-03T00:00:00.000Z'
    );
    INSERT INTO task_source_write_leases (
      id, token, connector_instance_id, task_id, operation, task_version, idempotency_key,
      effective_mode, mode_revision, comparison_run_id, write_cycle_id, route, identity_route,
      state, cycle_observed_at, cycle_outcome, dispatched_at, expires_at, created_at, updated_at
    ) VALUES
      ('lease-unknown', 'token-unknown', 'github-1', 'task-parent', 'update', 'v1', 'task-parent:update:v1',
       'stable', 7, 'run-new', 'cycle-1', 'legacy', 'stable', 'unknown', '2026-08-03T00:00:01.000Z',
       'unknown', '2026-08-03T00:00:02.000Z', '2026-08-03T00:01:00.000Z',
       '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:03.000Z'),
      ('lease-done', 'token-done', 'github-1', 'task-child', 'complete', 'v1', 'task-child:complete:v1',
       'stable', 7, 'run-new', 'cycle-1', 'legacy', 'stable', 'succeeded', '2026-08-03T00:00:01.000Z',
       'succeeded', '2026-08-03T00:00:02.000Z', '2026-08-03T00:01:00.000Z',
       '2026-08-03T00:00:00.000Z', '2026-08-03T00:00:04.000Z');
    INSERT INTO task_source_write_lease_targets (lease_id, role, owner, repository, issue_number)
    VALUES ('lease-unknown', 'primary_issue', 'octo', 'repo', 1);
    INSERT INTO github_write_outcome_events (
      id, connector_instance_id, cycle_id, lease_id, task_id, operation, task_version,
      expected_mode_revision, outcome, proof_kind, proof_digest, remote_state, actor, reason,
      idempotency_key, created_at
    ) VALUES (
      'outcome-1', 'github-1', 'cycle-1', 'lease-done', 'task-child', 'complete', 'v1', 7,
      'proven_applied', 'issue_state', '${'c'.repeat(64)}', 'closed', 'operator',
      'proven applied by readback', 'outcome-key-1', '2026-08-03T00:02:00.000Z'
    );

    INSERT INTO github_identity_backfill_items (
      connector_instance_id, binding_type, local_id, state, observed_at, updated_at
    ) VALUES (
      'github-1', 'task', 'task-gone', 'bound', '2026-08-02T00:00:00.000Z', '2026-08-02T00:00:00.000Z'
    );
    INSERT INTO github_identity_exception_events (
      connector_instance_id, binding_type, local_id, category, action, idempotency_key,
      actor, reason, proof_type, comparison_run_id, created_at
    ) VALUES (
      'github-1', 'task', 'task-gone', 'terminal_inaccessible', 'accept', 'exception-key-1',
      'operator', 'issue deleted upstream', 'post_backfill_authoritative_deletion', 'run-old',
      '2026-08-04T00:00:00.000Z'
    ), (
      'github-1', 'task', 'task-vanished', 'terminal_inaccessible', 'accept', 'exception-key-2',
      'operator', 'accepted on comparison evidence', NULL, 'run-old',
      '2026-08-04T00:01:00.000Z'
    );

    INSERT INTO dependency_reconciliation_snapshots (
      id, connector_instance_id, status, cursor, total, batch_size, started_at, updated_at,
      identity_mode, identity_mode_revision, identity_comparison_run_id
    ) VALUES (
      'snapshot-1', 'github-1', 'completed', 0, 0, 100, '2026-08-03T00:00:00.000Z',
      '2026-08-03T00:00:00.000Z', 'legacy', 7, 'run-old'
    );
  `);
}

function tableExists(sqlite: Database.Database, name: string): boolean {
  return sqlite.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
  `).get(name) !== undefined;
}

function columnNames(sqlite: Database.Database, table: string): string[] {
  return (sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
    name: string;
  }>).map((row) => row.name);
}

describe('GitHub NodeID permanent cutover migration', () => {
  it('drops obsolete comparison evidence tables', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);
    expect(tableExists(sqlite, 'github_identity_comparison_records')).toBe(true);
    expect(tableExists(sqlite, 'github_identity_sub_issue_population_members')).toBe(true);

    applyMigration(sqlite, CUTOVER_TAG);

    expect(tableExists(sqlite, 'github_identity_comparison_records')).toBe(false);
    expect(tableExists(sqlite, 'github_identity_sub_issue_population_members')).toBe(false);
    expect(tableExists(sqlite, 'github_identity_comparison_runs')).toBe(false);
    sqlite.close();
  });

  it('keeps canonical identity and hierarchy tables intact', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);

    applyMigration(sqlite, CUTOVER_TAG);

    for (const table of [
      'external_entities',
      'external_entity_bindings',
      'external_entity_locators',
      'github_identity_backfill_items',
      'github_identity_collisions',
      'github_repository_repoints',
      'github_bulk_transfer_runs',
      'task_source_write_lease_targets',
      'github_write_outcome_events',
    ]) {
      expect(tableExists(sqlite, table)).toBe(true);
    }
    // Sub-issue hierarchy lives on tasks, not on the removed evidence tables.
    expect(sqlite.prepare(`
      SELECT parent_id AS parentId, depth FROM tasks WHERE id = 'task-child'
    `).get()).toEqual({ parentId: 'task-parent', depth: 1 });
    sqlite.close();
  });

  it('preserves active and unknown write records while dropping comparison columns', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);

    applyMigration(sqlite, CUTOVER_TAG);

    expect(columnNames(sqlite, 'task_source_write_leases')).not.toContain('comparison_run_id');
    expect(columnNames(sqlite, 'task_source_write_leases')).not.toContain('effective_mode');
    expect(columnNames(sqlite, 'github_identity_write_cycles')).not.toContain('comparison_run_id');
    expect(columnNames(sqlite, 'github_identity_exception_events'))
      .not.toContain('comparison_run_id');

    expect(sqlite.prepare(`
      SELECT id, state, cycle_outcome AS cycleOutcome, write_cycle_id AS writeCycleId,
        mode_revision AS modeRevision, dispatched_at AS dispatchedAt,
        cycle_observed_at AS cycleObservedAt
      FROM task_source_write_leases ORDER BY id
    `).all()).toEqual([
      {
        id: 'lease-done',
        state: 'succeeded',
        cycleOutcome: 'succeeded',
        writeCycleId: 'cycle-1',
        modeRevision: 7,
        dispatchedAt: '2026-08-03T00:00:02.000Z',
        cycleObservedAt: '2026-08-03T00:00:01.000Z',
      },
      {
        id: 'lease-unknown',
        state: 'unknown',
        cycleOutcome: 'unknown',
        writeCycleId: 'cycle-1',
        modeRevision: 7,
        dispatchedAt: '2026-08-03T00:00:02.000Z',
        cycleObservedAt: '2026-08-03T00:00:01.000Z',
      },
    ]);
    // Frozen route targets and proven outcome events survive the lease rebuild.
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS value FROM task_source_write_lease_targets WHERE lease_id = 'lease-unknown'
    `).get()).toEqual({ value: 1 });
    expect(sqlite.prepare(`
      SELECT outcome FROM github_write_outcome_events WHERE lease_id = 'lease-done'
    `).get()).toEqual({ outcome: 'proven_applied' });
    expect(sqlite.prepare(`
      SELECT state, reconciliation_state AS reconciliationState,
        pending_candidate_count AS pendingCandidateCount,
        observed_route_count AS observedRouteCount,
        applied_count AS appliedCount, unknown_count AS unknownCount
      FROM github_identity_write_cycles WHERE id = 'cycle-1'
    `).get()).toEqual({
      state: 'interrupted',
      reconciliationState: 'unresolved',
      pendingCandidateCount: 2,
      observedRouteCount: 2,
      appliedCount: 1,
      unknownCount: 1,
    });
    sqlite.close();
  });

  it('normalizes identity phases, controls, and exception proofs', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);

    applyMigration(sqlite, CUTOVER_TAG);

    expect(sqlite.prepare(`
      SELECT phase FROM github_identity_migrations WHERE connector_instance_id = 'github-1'
    `).get()).toEqual({ phase: 'complete' });
    expect(columnNames(sqlite, 'github_identity_controls'))
      .not.toContain('stable_primary_enabled');
    expect(sqlite.prepare(`
      SELECT mode_revision AS modeRevision
      FROM github_identity_controls WHERE connector_instance_id = 'github-1'
    `).get()).toEqual({ modeRevision: 7 });
    expect(sqlite.prepare(`
      SELECT proof_type AS proofType, action
      FROM github_identity_exception_events WHERE local_id = 'task-gone'
    `).get()).toEqual({ proofType: 'post_backfill_authoritative_deletion', action: 'accept' });
    // An accept that was proven only by a comparison run keeps an honest
    // archival label instead of being relabelled as a proof it never had.
    expect(sqlite.prepare(`
      SELECT proof_type AS proofType, action
      FROM github_identity_exception_events WHERE local_id = 'task-vanished'
    `).get()).toEqual({ proofType: 'legacy_comparison_evidence', action: 'accept' });
    expect(columnNames(sqlite, 'dependency_reconciliation_snapshots'))
      .not.toContain('identity_comparison_run_id');
    expect(sqlite.prepare(`
      SELECT identity_mode AS identityMode FROM dependency_reconciliation_snapshots
    `).get()).toEqual({ identityMode: 'stable' });
    sqlite.close();
  });

  it('rejects rollback-era phases and re-enables foreign keys', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);

    applyMigration(sqlite, CUTOVER_TAG);

    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => sqlite.exec(`
      UPDATE github_identity_migrations SET phase = 'rollback_legacy'
    `)).toThrow();
    expect(() => sqlite.exec(`
      UPDATE github_identity_migrations SET phase = 'comparing'
    `)).toThrow();
    sqlite.close();
  });

  it('is restart safe when re-applied after a completed run', () => {
    const sqlite = openPreCutoverDatabase();
    seedPreCutoverFixture(sqlite);

    applyMigration(sqlite, CUTOVER_TAG);
    // The migration runner leaves a migration unmarked when any statement fails,
    // so the whole file must survive a second pass.
    expect(() => applyMigration(sqlite, CUTOVER_TAG)).not.toThrow();

    expect(sqlite.prepare(`
      SELECT COUNT(*) AS value FROM task_source_write_leases
    `).get()).toEqual({ value: 2 });
    expect(sqlite.prepare(`
      SELECT applied_count AS appliedCount FROM github_identity_write_cycles WHERE id = 'cycle-1'
    `).get()).toEqual({ appliedCount: 1 });
    expect(tableExists(sqlite, '__new_task_source_write_leases')).toBe(false);
    sqlite.close();
  });
});
