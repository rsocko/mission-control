import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

type ReferenceDisposition =
  | 'repoint'
  | 'rebuild'
  | 'source-operation'
  | 'history'
  | 'lineage'
  | 'external-identity';

const TASK_REFERENCE_COLUMN_POLICIES = {
  'agent_dispatch_attempts.provider_task_id': 'external-identity',
  'agent_dispatches.provider_task_id': 'external-identity',
  'alerts.related_task_id': 'repoint',
  'focus_items.task_id': 'repoint',
  'github_bulk_transfer_events.task_id': 'history',
  'github_bulk_transfer_items.task_id': 'history',
  'github_bulk_transfer_successions.task_id': 'history',
  'github_identity_comparison_records.local_task_id': 'history',
  'github_identity_sub_issue_population_members.local_task_id': 'history',
  'github_identity_task_transfer_reconciliations.source_task_id': 'lineage',
  'github_identity_task_transfer_reconciliations.successor_task_id': 'lineage',
  'github_write_outcome_events.task_id': 'history',
  'my_day_exclusions.task_id': 'repoint',
  'my_day_items.task_id': 'repoint',
  'notifications.related_task_id': 'repoint',
  'priority_sync_log.task_id': 'repoint',
  'project_auto_include_exclusions.task_id': 'repoint',
  'project_phase_items.task_id': 'repoint',
  'scout_reconciliation_evaluations.task_id': 'history',
  'scout_reconciliation_suggestions.task_id': 'repoint',
  'scout_reconciliation_task_state.task_id': 'repoint',
  'sync_deletion_candidates.task_id': 'source-operation',
  'sync_deletion_snapshots.original_task_id': 'history',
  'sync_deletion_snapshots.restored_task_id': 'history',
  'task_attachments.task_id': 'rebuild',
  'task_dependencies.depends_on_task_id': 'repoint',
  'task_dependencies.task_id': 'repoint',
  'task_field_states.task_id': 'source-operation',
  'task_history_events.task_id': 'history',
  'task_linked_sources.task_id': 'repoint',
  'task_projects.task_id': 'repoint',
  'task_schedules.task_id': 'repoint',
  'task_source_write_leases.task_id': 'history',
  'task_tags.task_id': 'repoint',
  'task_triage_log.task_id': 'repoint',
  'tasks.parent_id': 'repoint',
  'weekly_one_thing.task_id': 'repoint',
  'work_todo_outbound_changes.remote_task_id': 'external-identity',
  'work_todo_outbound_changes.task_id': 'source-operation',
} as const satisfies Record<string, ReferenceDisposition>;

describe('task reference inventory', () => {
  const dbPath = join(process.cwd(), 'data', `task-reference-inventory-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let sqlite: Database.Database;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.resetModules();
    ({ sqlite } = await import('@/db'));
  });

  afterAll(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
    if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDbPath;
  });

  it('classifies every task-like relational column in the initialized schema', () => {
    const discovered = sqlite.prepare(`
      SELECT m.name || '.' || p.name AS reference
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table'
        AND (
          lower(p.name) LIKE '%task%id%'
          OR (m.name = 'tasks' AND p.name = 'parent_id')
        )
      ORDER BY reference
    `).all() as Array<{ reference: string }>;

    expect(discovered.map(({ reference }) => reference)).toEqual(
      Object.keys(TASK_REFERENCE_COLUMN_POLICIES).sort(),
    );
  });
});
