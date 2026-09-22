import { afterAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from '@/db/postgres/schema';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describeTaskOrganizationRepositoryContract,
  type TaskOrganizationContractHarness,
} from '../contracts/task-organization-repository.contract';

/**
 * Runs the shared task-organization contract against a live PostgreSQL target.
 * Skipped unless `MC_TEST_POSTGRES_URL` points at a disposable database.
 */

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const TABLES = [
  'task_attachments',
  'task_schedules',
  'task_projects',
  'task_tags',
  'subtask_templates',
  'source_rankings',
  'source_lists',
  'tags',
  'hub_projects',
  'tasks',
];
const NOW = '2026-09-01T09:00:00.000Z';

let sharedPool: Pool | null = null;

async function pool(): Promise<Pool> {
  if (!sharedPool) {
    assertSafeIntegrationTestTarget(connectionString!);
    const { Pool } = await import('pg');
    sharedPool = new Pool({ connectionString, max: 4 });
  }
  return sharedPool;
}

async function clear(database: Pool): Promise<void> {
  for (const table of TABLES) await database.query(`DELETE FROM "${table}"`);
}

async function insertRows(
  database: Pool,
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  for (const row of rows) {
    const columns = Object.keys(row);
    await database.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
       VALUES (${columns.map((_, index) => `$${index + 1}`).join(', ')})`,
      columns.map((column) => row[column] ?? null),
    );
  }
}

afterAll(async () => {
  await sharedPool?.end();
  sharedPool = null;
});

if (connectionString) {
  describeTaskOrganizationRepositoryContract('PostgreSQL', async () => {
    const database = await pool();
    const { createPostgresTaskCorePersistence } = await import(
      '@/db/postgres/repositories/task-core-repositories'
    );
    const persistence = createPostgresTaskCorePersistence(
      drizzle(database, { schema }),
    );

    const harness: TaskOrganizationContractHarness = {
      repository: persistence.organization,
      reset: () => clear(database),
      insertTasks: (rows) => insertRows(database, 'tasks', rows.map((row) => ({
        id: row.id,
        source_id: row.sourceId ?? `local:${row.id}`,
        connector_type: row.connectorType ?? 'local',
        connector_instance_id: row.connectorInstanceId ?? 'local',
        title: row.title ?? row.id,
        description: row.description ?? null,
        status: row.status ?? 'todo',
        local_disposition: row.localDisposition ?? 'active',
        priority: row.priority ?? 'none',
        due_date: row.dueDate ?? null,
        created_at: row.createdAt ?? NOW,
        updated_at: row.updatedAt ?? NOW,
        parent_id: row.parentId ?? null,
        depth: row.depth ?? 0,
        is_checklist_item: row.isChecklistItem ?? false,
        source_list_id: row.sourceListId ?? null,
        source_list_name: row.sourceListName ?? null,
        assignee: row.assignee ?? null,
        metadata: '{}',
        sync_status: 'synced',
        last_synced_at: NOW,
        effort: row.effort ?? null,
      }))),
      insertTags: (rows) => insertRows(database, 'tags', rows.map((row) => ({
        id: row.id,
        name: row.name,
        slug: row.slug,
        type: row.type ?? 'hub',
        source: row.source ?? null,
        color: row.color ?? null,
        confirmed: row.confirmed ?? true,
        created_at: row.createdAt ?? NOW,
        unified_into: row.unifiedInto ?? null,
      }))),
      insertTaskTags: (rows) => insertRows(database, 'task_tags', rows.map((row) => ({
        task_id: row.taskId,
        tag_id: row.tagId,
      }))),
      insertSourceLists: (rows) => insertRows(database, 'source_lists', rows.map((row) => ({
        id: row.id,
        connector_instance_id: row.connectorInstanceId,
        source_id: row.sourceId,
        name: row.name,
        type: 'list',
        hidden: false,
        sort_order: 0,
      }))),
      insertSchedules: (rows) => insertRows(database, 'task_schedules', rows.map((row) => ({
        task_id: row.taskId,
        scheduled_date: row.scheduledDate ?? '2026-09-10',
        scheduled_time: row.scheduledTime ?? null,
        estimated_duration: row.estimatedDuration ?? null,
        is_time_blocked: row.isTimeBlocked ?? false,
        recurrence: row.recurrence ?? null,
        recurrence_mode: 'schedule',
      }))),
      insertAttachments: (rows) => insertRows(database, 'task_attachments', rows.map((row) => ({
        id: row.id,
        task_id: row.taskId,
        name: row.name,
        content_type: 'text/plain',
        size: row.size,
        content_base64: null,
        source_attachment_id: row.sourceAttachmentId ?? null,
        created_at: NOW,
      }))),
      insertProjects: (rows) => insertRows(database, 'hub_projects', rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: '#3b82f6',
        hidden: false,
        created_at: NOW,
        updated_at: NOW,
      }))),
      insertTaskProjects: (rows) => insertRows(database, 'task_projects', rows.map((row) => ({
        task_id: row.taskId,
        project_id: row.projectId,
      }))),
      insertSourceRankings: (rows) => insertRows(database, 'source_rankings', rows.map((row) => ({
        id: row.id,
        connector_type: row.connectorType,
        name: row.name,
        rank: row.rank,
        updated_at: NOW,
      }))),
      async listTagIds() {
        const result = await database.query<{ id: string }>(
          'SELECT id FROM "tags" ORDER BY id',
        );
        return result.rows.map((row) => row.id);
      },
      async getTagUnifiedInto(tagId: string) {
        const result = await database.query<{ unified_into: string | null }>(
          'SELECT unified_into FROM "tags" WHERE id = $1',
          [tagId],
        );
        const row = result.rows[0];
        return row === undefined ? undefined : row.unified_into;
      },
      async listTaskTagIds(taskId: string) {
        const result = await database.query<{ tag_id: string }>(
          'SELECT tag_id FROM "task_tags" WHERE task_id = $1 ORDER BY tag_id',
          [taskId],
        );
        return result.rows.map((row) => row.tag_id);
      },
      async listTaskIds() {
        const result = await database.query<{ id: string }>(
          'SELECT id FROM "tasks" ORDER BY id',
        );
        return result.rows.map((row) => row.id);
      },
      async getTaskParentId(taskId: string) {
        const result = await database.query<{ parent_id: string | null }>(
          'SELECT parent_id FROM "tasks" WHERE id = $1',
          [taskId],
        );
        return result.rows[0]?.parent_id;
      },
      deleteTask: (taskId, recursive) =>
        persistence.lifecycle.deleteTaskLocally({ taskId, recursive }),
      async getTaskSource(taskId: string) {
        const result = await database.query<{
          source_list_id: string | null;
          source_id: string;
        }>(
          'SELECT source_list_id, source_id FROM "tasks" WHERE id = $1',
          [taskId],
        );
        const row = result.rows[0];
        return row === undefined
          ? null
          : { sourceListId: row.source_list_id, sourceId: row.source_id };
      },
      async forceMergeFailure(input) {
        // Aborting the source-tag delete forces the merge to fail after it has
        // already reassigned links — the window a non-atomic implementation
        // would leave durable.
        await database.query(`
          CREATE OR REPLACE FUNCTION organization_merge_forced_failure()
          RETURNS trigger AS $$
          BEGIN
            IF OLD.id = ${literal(input.sourceTagIds[0])} THEN
              RAISE EXCEPTION 'forced merge failure';
            END IF;
            RETURN OLD;
          END;
          $$ LANGUAGE plpgsql;
        `);
        await database.query(`
          CREATE TRIGGER organization_merge_forced_failure_trigger
          BEFORE DELETE ON "tags"
          FOR EACH ROW EXECUTE FUNCTION organization_merge_forced_failure();
        `);
        try {
          await harness.repository.mergeTags({
            targetTagId: input.targetTagId,
            sourceTagIds: [...input.sourceTagIds],
            newName: null,
            newSlug: null,
            newColor: null,
          });
          return null;
        } catch (error) {
          return error;
        } finally {
          await database.query(
            'DROP TRIGGER IF EXISTS organization_merge_forced_failure_trigger ON "tags"',
          );
          await database.query(
            'DROP FUNCTION IF EXISTS organization_merge_forced_failure()',
          );
        }
      },
    };
    return harness;
  });
}

/** Single-quoted SQL literal for the trigger body (test-local ids only). */
function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

if (!connectionString) {
  describe.skip('PostgreSQL task-organization integration', () => {
    it('requires MC_TEST_POSTGRES_URL', () => {
      expect(connectionString).toBeDefined();
    });
  });
}
