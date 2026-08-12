/**
 * Reusable database query helpers — extract commonly repeated patterns
 * for task/tag operations, cascade deletes, and metadata parsing.
 */
import db, { runTransaction } from '@/db';
import {
  myDayItems,
  projectAutoIncludeExclusions,
  tags,
  taskDependencies,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { detachTaskDescendants } from '@/lib/tasks/task-hierarchy-deletion';

/**
 * Fetch a task by ID along with its associated tag IDs.
 * Returns null if the task doesn't exist.
 */
export async function getTaskWithTags(taskId: string) {
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return null;

  const tagRows = await db
    .select({ tagId: taskTags.tagId })
    .from(taskTags)
    .where(eq(taskTags.taskId, taskId));

  return { ...task, tagIds: tagRows.map((r) => r.tagId) };
}

/**
 * Replace all tags for a task (delete existing, insert new).
 * Operates within a transaction for atomicity.
 */
export function upsertTaskTags(taskId: string, tagIds: string[]): void {
  runTransaction((tx) => {
    tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
    if (tagIds.length > 0) {
      tx.insert(taskTags)
        .values(tagIds.map((tagId) => ({ taskId, tagId })))
        .run();
    }
  });
}

/**
 * Delete a task and all its junction-table associations.
 * Runs inside a transaction for atomicity.
 */
export function deleteTaskCascade(taskId: string): void {
  runTransaction((tx) => {
    tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
    tx.delete(projectAutoIncludeExclusions)
      .where(eq(projectAutoIncludeExclusions.taskId, taskId))
      .run();
    tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId)).run();
    tx.delete(myDayItems).where(eq(myDayItems.taskId, taskId)).run();
    tx.delete(taskDependencies).where(or(
      eq(taskDependencies.taskId, taskId),
      eq(taskDependencies.dependsOnTaskId, taskId),
    )).run();
    detachTaskDescendants(tx, taskId);
    tx.delete(tasks).where(eq(tasks.id, taskId)).run();
  });
}

/**
 * Safely parse a JSON metadata field that may be a string or object.
 * Returns a Record<string, unknown> regardless of input shape.
 */
export function parseMetadata(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
  }
  return {};
}

/**
 * Batch-fetch tags for multiple task IDs at once.
 * Returns a Map from taskId to an array of full tag rows.
 */
export async function getTagsForTasks(taskIds: string[]) {
  if (taskIds.length === 0) return new Map<string, Array<typeof tags.$inferSelect>>();

  const rows = await db
    .select({
      taskId: taskTags.taskId,
      tagId: taskTags.tagId,
      id: tags.id,
      name: tags.name,
      slug: tags.slug,
      type: tags.type,
      source: tags.source,
      color: tags.color,
      confirmed: tags.confirmed,
      createdAt: tags.createdAt,
      unifiedInto: tags.unifiedInto,
    })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(inArray(taskTags.taskId, taskIds));

  const map = new Map<string, Array<typeof tags.$inferSelect>>();
  for (const row of rows) {
    const existing = map.get(row.taskId) || [];
    existing.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      type: row.type,
      source: row.source,
      color: row.color,
      confirmed: row.confirmed,
      createdAt: row.createdAt,
      unifiedInto: row.unifiedInto,
    });
    map.set(row.taskId, existing);
  }

  return map;
}
