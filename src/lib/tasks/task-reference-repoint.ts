import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';
import type * as schema from '@/db/schema';

export type TaskReferenceDisposition =
  | 'repoint'
  | 'rebuild'
  | 'source-operation'
  | 'history'
  | 'lineage'
  | 'external-identity';

export const TASK_REFERENCE_COLUMN_POLICIES = {
  'agent_dispatch_attempts.provider_task_id': 'external-identity',
  'agent_dispatches.provider_task_id': 'external-identity',
  'alerts.related_task_id': 'history',
  'focus_items.task_id': 'repoint',
  'github_bulk_transfer_events.task_id': 'history',
  'github_bulk_transfer_items.task_id': 'history',
  'github_bulk_transfer_successions.task_id': 'history',
  'github_identity_task_transfer_reconciliations.source_task_id': 'lineage',
  'github_identity_task_transfer_reconciliations.successor_task_id': 'lineage',
  'github_write_outcome_events.task_id': 'history',
  'my_day_exclusions.task_id': 'repoint',
  'my_day_items.task_id': 'repoint',
  'notifications.related_task_id': 'repoint',
  'priority_sync_log.task_id': 'repoint',
  'project_auto_include_exclusions.task_id': 'repoint',
  'project_phase_items.task_id': 'repoint',
  'quick_sort_operations.task_id': 'repoint',
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
  'task_projects.task_id': 'rebuild',
  'task_schedules.task_id': 'rebuild',
  'task_source_write_leases.task_id': 'history',
  'task_tags.task_id': 'rebuild',
  'task_triage_log.task_id': 'repoint',
  'tasks.parent_id': 'repoint',
  'weekly_one_thing.task_id': 'repoint',
  'work_todo_outbound_changes.remote_task_id': 'external-identity',
  'work_todo_outbound_changes.task_id': 'source-operation',
} as const satisfies Record<string, TaskReferenceDisposition>;

export type TaskReferenceTransaction = BetterSQLite3Database<typeof schema>;

export function repointTaskReferences(
  tx: TaskReferenceTransaction,
  sourceTaskId: string,
  successorTaskId: string,
): void {
  tx.run(sql`UPDATE tasks SET parent_id = ${successorTaskId} WHERE parent_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE my_day_items SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE my_day_exclusions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE focus_items SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE weekly_one_thing SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE priority_sync_log SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE task_triage_log SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE quick_sort_operations SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE project_auto_include_exclusions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  rebuildProjectPlacements(tx, sourceTaskId, successorTaskId);
  tx.run(sql`UPDATE task_linked_sources SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE notifications SET related_task_id = ${successorTaskId} WHERE related_task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE scout_reconciliation_suggestions SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE scout_reconciliation_task_state SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE task_dependencies SET task_id = ${successorTaskId} WHERE task_id = ${sourceTaskId}`);
  tx.run(sql`UPDATE task_dependencies SET depends_on_task_id = ${successorTaskId} WHERE depends_on_task_id = ${sourceTaskId}`);
}

function rebuildProjectPlacements(
  tx: TaskReferenceTransaction,
  sourceTaskId: string,
  successorTaskId: string,
): void {
  const projects = tx.all<{ projectId: string }>(sql`
    SELECT project_id AS projectId
    FROM task_projects
    WHERE task_id = ${sourceTaskId}
    UNION
    SELECT project_phases.project_id AS projectId
    FROM project_phase_items
    INNER JOIN project_phases ON project_phases.id = project_phase_items.phase_id
    WHERE project_phase_items.task_id = ${sourceTaskId}
      AND project_phases.project_id IS NOT NULL
  `);
  const insertedContexts: string[] = [];

  try {
    for (const { projectId } of projects) {
      const result = tx.run(sql`
        INSERT OR IGNORE INTO project_hierarchy_mutation_context (project_id)
        VALUES (${projectId})
      `);
      if (result.changes > 0) insertedContexts.push(projectId);
    }

    tx.run(sql`
      INSERT OR IGNORE INTO task_projects (task_id, project_id)
      SELECT ${successorTaskId}, project_id
      FROM task_projects
      WHERE task_id = ${sourceTaskId}
    `);
    tx.run(sql`
      UPDATE project_phase_items
      SET task_id = ${successorTaskId}
      WHERE task_id = ${sourceTaskId}
    `);
    tx.run(sql`
      DELETE FROM task_projects
      WHERE task_id = ${sourceTaskId}
    `);
  } finally {
    for (const projectId of insertedContexts) {
      tx.run(sql`
        DELETE FROM project_hierarchy_mutation_context
        WHERE project_id = ${projectId}
      `);
    }
  }
}
