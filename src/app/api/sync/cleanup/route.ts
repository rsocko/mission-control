import { NextResponse } from 'next/server';
import db, { runTransaction } from '@/db';
import {
  myDayItems,
  projectAutoIncludeExclusions,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { eq, sql, and } from 'drizzle-orm';
import { syncLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/sync/cleanup — Remove duplicate tasks and clean up recurring task instances.
 * 
 * Phase 1: Duplicates identified by (sourceId, connectorInstanceId) pairs.
 * Keeps the most recently synced/updated row, deletes the rest.
 * 
 * Phase 2: Completed recurring task deduplication.
 * Groups completed tasks with recurrence metadata by (title, sourceListId, connectorInstanceId).
 * Keeps only the most recently completed instance per group.
 * 
 * Also creates a unique index to prevent future sourceId duplicates.
 */
export async function POST() {
  try {
    // Step 1: Find all duplicate (sourceId, connectorInstanceId) groups
    const dupeGroups = await db.all<{ sourceId: string; connectorInstanceId: string; cnt: number }>(
      sql`SELECT source_id as sourceId, connector_instance_id as connectorInstanceId, COUNT(*) as cnt
          FROM tasks
          GROUP BY source_id, connector_instance_id
          HAVING COUNT(*) > 1`
    );

    let totalRemoved = 0;

    // Wrap all deletions in a transaction for atomicity
    runTransaction((tx) => {
      for (const group of dupeGroups) {
        // Get all rows for this duplicate group, ordered by last_synced_at DESC, updated_at DESC
        const rows = db.all<{ id: string }>(
          sql`SELECT id FROM tasks
              WHERE source_id = ${group.sourceId}
                AND connector_instance_id = ${group.connectorInstanceId}
              ORDER BY COALESCE(last_synced_at, '1970-01-01') DESC, COALESCE(updated_at, '1970-01-01') DESC`
        );

        // Keep the first (most recent), delete the rest
        const toDelete = rows.slice(1);
        for (const row of toDelete) {
          tx.delete(taskTags).where(eq(taskTags.taskId, row.id)).run();
          tx.delete(projectAutoIncludeExclusions)
            .where(eq(projectAutoIncludeExclusions.taskId, row.id))
            .run();
          tx.delete(taskProjects).where(eq(taskProjects.taskId, row.id)).run();
          tx.delete(myDayItems).where(eq(myDayItems.taskId, row.id)).run();
          tx.delete(tasks).where(eq(tasks.id, row.id)).run();
          totalRemoved++;
        }
      }
    });

    // Step 2: Create unique index (if not exists) to prevent future duplicates
    await db.run(
      sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_connector
          ON tasks(source_id, connector_instance_id)`
    );

    // Step 3: Clean up old completed recurring task instances
    // These accumulate because MS To Do creates a new task for each recurrence completion
    const completedTasks = await db.all<{
      id: string;
      title: string;
      sourceId: string;
      sourceListId: string | null;
      connectorInstanceId: string;
      completedAt: string | null;
      updatedAt: string;
      metadata: string;
    }>(
      sql`SELECT id, title, source_id as sourceId, source_list_id as sourceListId,
                 connector_instance_id as connectorInstanceId,
                 completed_at as completedAt, updated_at as updatedAt, metadata
          FROM tasks
          WHERE status = 'done'`
    );

    // Group by (normalized title, sourceListId, connectorInstanceId) where recurrence is set
    const recurringGroups = new Map<string, Array<{ id: string; completedAt: string | null; updatedAt: string }>>();
    for (const task of completedTasks) {
      let meta: Record<string, unknown> = {};
      try {
        meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : {};
      } catch { continue; }

      if (!meta.recurrence) continue;

      const key = `${(task.title || '').trim().toLowerCase()}::${task.sourceListId || ''}::${task.connectorInstanceId}`;
      const group = recurringGroups.get(key);
      const entry = { id: task.id, completedAt: task.completedAt, updatedAt: task.updatedAt };
      if (group) {
        group.push(entry);
      } else {
        recurringGroups.set(key, [entry]);
      }
    }

    let recurringRemoved = 0;
    runTransaction((tx) => {
      for (const [, group] of recurringGroups) {
        if (group.length <= 1) continue;

        // Sort by completedAt desc, keep most recent
        group.sort((a, b) => {
          const aDate = a.completedAt || a.updatedAt;
          const bDate = b.completedAt || b.updatedAt;
          return bDate.localeCompare(aDate);
        });

        for (let i = 1; i < group.length; i++) {
          tx.delete(taskTags).where(eq(taskTags.taskId, group[i].id)).run();
          tx.delete(projectAutoIncludeExclusions)
            .where(eq(projectAutoIncludeExclusions.taskId, group[i].id))
            .run();
          tx.delete(taskProjects).where(eq(taskProjects.taskId, group[i].id)).run();
          tx.delete(myDayItems).where(eq(myDayItems.taskId, group[i].id)).run();
          tx.delete(tasks).where(eq(tasks.id, group[i].id)).run();
          recurringRemoved++;
        }
      }
    });

    // Step 4: Clean up duplicate open recurring task instances.
    // MS To Do sometimes returns multiple open instances for the same recurring task.
    // Keep only the one with the nearest due date per (title, sourceListId, connectorInstanceId).
    const openRecurringTasks = await db.all<{
      id: string;
      title: string;
      sourceId: string;
      sourceListId: string | null;
      connectorInstanceId: string;
      dueDate: string | null;
      updatedAt: string;
      metadata: string;
    }>(
      sql`SELECT id, title, source_id as sourceId, source_list_id as sourceListId,
                 connector_instance_id as connectorInstanceId,
                 due_date as dueDate, updated_at as updatedAt, metadata
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled')`
    );

    const openRecurringGroups = new Map<string, Array<{ id: string; dueDate: string | null; updatedAt: string }>>();
    for (const task of openRecurringTasks) {
      let meta: Record<string, unknown> = {};
      try {
        meta = typeof task.metadata === 'string' ? JSON.parse(task.metadata) : {};
      } catch { continue; }

      if (!meta.recurrence) continue;

      const key = `${(task.title || '').trim().toLowerCase()}::${task.sourceListId || ''}::${task.connectorInstanceId}`;
      const group = openRecurringGroups.get(key);
      const entry = { id: task.id, dueDate: task.dueDate, updatedAt: task.updatedAt };
      if (group) {
        group.push(entry);
      } else {
        openRecurringGroups.set(key, [entry]);
      }
    }

    let openRecurringRemoved = 0;
    runTransaction((tx) => {
      for (const [, group] of openRecurringGroups) {
        if (group.length <= 1) continue;

        // Sort by dueDate asc (nearest first), nulls last
        group.sort((a, b) => {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return a.dueDate.localeCompare(b.dueDate);
        });

        // Keep the first (nearest due date), delete the rest
        for (let i = 1; i < group.length; i++) {
          tx.delete(taskTags).where(eq(taskTags.taskId, group[i].id)).run();
          tx.delete(projectAutoIncludeExclusions)
            .where(eq(projectAutoIncludeExclusions.taskId, group[i].id))
            .run();
          tx.delete(taskProjects).where(eq(taskProjects.taskId, group[i].id)).run();
          tx.delete(myDayItems).where(eq(myDayItems.taskId, group[i].id)).run();
          tx.delete(tasks).where(eq(tasks.id, group[i].id)).run();
          openRecurringRemoved++;
        }
      }
    });

    return NextResponse.json({
      success: true,
      duplicateGroupsFound: dupeGroups.length,
      tasksRemoved: totalRemoved,
      recurringInstancesRemoved: recurringRemoved,
      openRecurringInstancesRemoved: openRecurringRemoved,
      uniqueIndexCreated: true,
    });
  } catch (error) {
    syncLogger.error({ err: error }, 'Cleanup failed');
    return ApiErrors.internal('Cleanup failed', error);
  }
}
