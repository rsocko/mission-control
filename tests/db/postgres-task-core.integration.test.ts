import { describe, it, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describeTaskCoreContract,
  type SeedAttachment,
  type SeedConnector,
  type SeedPriorityEntity,
  type SeedSourceList,
  type SeedTag,
  type SeedTask,
  type TaskCoreContractHarness,
} from '../contracts/task-core.contract';
/**
 * Runs the *same* task-core contract suite against a live PostgreSQL
 * database, proving the two adapters agree on filter semantics, ordering,
 * stats, mutation policy identity loading, move atomicity, and hard-delete
 * idempotency.
 *
 * Skipped unless `MC_TEST_POSTGRES_URL` is set, matching the other
 * `tests/db/postgres-*.integration.test.ts` conventions.
 */

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;

let runtime: typeof import('@/db/runtime') | null = null;
let harness: TaskCoreContractHarness | null = null;
let pool: Pool | null = null;

const DEFAULT_NOW = '2026-08-05T12:00:00.000Z';

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function createHarness(): Promise<TaskCoreContractHarness> {
  if (harness) return harness;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-task-core-contract-test';

  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  const backend = runtime.getPostgresPersistenceBackend();
  pool = backend.context.pool;

  const { createPostgresTaskCorePersistence } = await import(
    '@/db/postgres/repositories/task-core-repositories'
  );
  const persistence = createPostgresTaskCorePersistence(backend.context.db);
  const client = pool;

  harness = {
    persistence,
    async reset() {
      await client.query(`
        TRUNCATE TABLE
          task_ingest_suppressions,
          task_attachments,
          task_schedules,
          project_phase_items,
          task_projects,
          task_tags,
          my_day_exclusions,
          my_day_items,
          priority_entities,
          source_lists,
          connector_configs,
          app_settings,
          tags,
          hub_projects,
          tasks
        RESTART IDENTITY CASCADE
      `);
    },
    async insertTasks(rows: SeedTask[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, local_disposition, priority, planning_horizon, due_date,
            created_at, updated_at, completed_at, parent_id, depth, is_checklist_item,
            source_list_id, source_list_name, assignee, micro_status, metadata,
            sync_status, last_synced_at, effort
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25
          )`,
          [
            row.id,
            row.sourceId ?? `local:${row.id}`,
            row.connectorType ?? 'local',
            row.connectorInstanceId ?? 'local',
            row.title ?? row.id,
            row.description ?? null,
            row.status ?? 'todo',
            row.localDisposition ?? 'active',
            row.priority ?? 'none',
            row.planningHorizon ?? null,
            row.dueDate ?? null,
            row.createdAt ?? DEFAULT_NOW,
            row.updatedAt ?? DEFAULT_NOW,
            row.completedAt ?? null,
            row.parentId ?? null,
            row.depth ?? 0,
            row.isChecklistItem ?? false,
            row.sourceListId ?? null,
            row.sourceListName ?? null,
            row.assignee ?? null,
            row.microStatus ?? null,
            JSON.stringify(row.metadata ?? {}),
            row.syncStatus ?? 'synced',
            row.lastSyncedAt ?? DEFAULT_NOW,
            row.effort ?? null,
          ],
        );
      }
    },
    async insertTags(rows: SeedTag[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at, unified_into)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            row.id,
            row.name,
            row.slug,
            row.type ?? 'label',
            row.source ?? null,
            row.color ?? null,
            row.confirmed ?? true,
            row.createdAt ?? DEFAULT_NOW,
            row.unifiedInto ?? null,
          ],
        );
      }
    },
    async insertTaskTags(rows) {
      for (const row of rows) {
        await client.query(
          'INSERT INTO task_tags (task_id, tag_id) VALUES ($1,$2)',
          [row.taskId, row.tagId],
        );
      }
    },
    async insertProjects(rows) {
      for (const row of rows) {
        await client.query(
          'INSERT INTO hub_projects (id, name, created_at, updated_at) VALUES ($1,$2,$3,$4)',
          [row.id, row.name, DEFAULT_NOW, DEFAULT_NOW],
        );
      }
    },
    async insertTaskProjects(rows) {
      for (const row of rows) {
        await client.query(
          'INSERT INTO task_projects (task_id, project_id) VALUES ($1,$2)',
          [row.taskId, row.projectId],
        );
      }
    },
    async insertSourceLists(rows: SeedSourceList[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO source_lists (
            id, connector_instance_id, source_id, name, type, user_display_name, group_id, icon_color
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.connectorInstanceId,
            row.sourceId,
            row.name,
            row.type ?? 'list',
            row.userDisplayName ?? null,
            row.groupId ?? null,
            row.iconColor ?? null,
          ],
        );
      }
    },
    async insertMyDayItems(rows) {
      for (const row of rows) {
        await client.query(
          'INSERT INTO my_day_items (id, task_id, date, added_at) VALUES ($1,$2,$3,$4)',
          [row.id, row.taskId, row.date, DEFAULT_NOW],
        );
      }
    },
    async insertMyDayExclusion(row) {
      await client.query(
        'INSERT INTO my_day_exclusions (id, task_id, date, removed_at) VALUES ($1,$2,$3,$4)',
        [row.id, row.taskId, row.date, DEFAULT_NOW],
      );
    },
    async insertTaskSchedules(rows) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO task_schedules (
            task_id, scheduled_date, scheduled_time, estimated_duration,
            is_time_blocked, recurrence, recurrence_mode
          ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            row.taskId,
            row.scheduledDate ?? '2026-08-10',
            row.scheduledTime ?? null,
            row.estimatedDuration ?? null,
            row.isTimeBlocked ?? false,
            row.recurrence ?? null,
            row.recurrenceMode ?? 'schedule',
          ],
        );
      }
    },
    async insertConnectors(rows: SeedConnector[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO connector_configs (
            id, type, name, enabled, capabilities, credentials, settings, synced_lists,
            created_at, updated_at, deleted_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            row.id,
            row.type,
            row.name ?? row.id,
            row.enabled ?? true,
            '{}',
            '{}',
            JSON.stringify(row.settings ?? {}),
            JSON.stringify(row.syncedLists ?? []),
            DEFAULT_NOW,
            DEFAULT_NOW,
            row.deletedAt ?? null,
          ],
        );
      }
    },
    async setAppSetting(key, value) {
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [key, JSON.stringify(value), DEFAULT_NOW],
      );
    },
    async insertAttachments(rows: SeedAttachment[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO task_attachments (
            id, task_id, name, content_type, size, content_base64, source_attachment_id, created_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            row.id,
            row.taskId,
            row.name,
            row.contentType ?? 'text/plain',
            row.size,
            row.contentBase64 ?? null,
            row.sourceAttachmentId ?? null,
            row.createdAt ?? DEFAULT_NOW,
          ],
        );
      }
    },
    async insertPriorityEntities(rows: SeedPriorityEntity[]) {
      for (const row of rows) {
        await client.query(
          `INSERT INTO priority_entities (
            id, name, type, reference_id, tier, color, rank, active_task_count, created_at, updated_at
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            row.id,
            row.name,
            row.type,
            row.referenceId ?? null,
            'standard',
            '#64748b',
            row.rank ?? 0,
            0,
            DEFAULT_NOW,
            DEFAULT_NOW,
          ],
        );
      }
    },
    async listTaskIds() {
      const result = await client.query<{ id: string }>('SELECT id FROM tasks ORDER BY id');
      return result.rows.map((row) => row.id);
    },
    async listTaskTagIds(taskId) {
      const result = await client.query<{ tag_id: string }>(
        'SELECT tag_id FROM task_tags WHERE task_id = $1 ORDER BY tag_id',
        [taskId],
      );
      return result.rows.map((row) => row.tag_id);
    },
    async listTaskProjectIds(taskId) {
      const result = await client.query<{ project_id: string }>(
        'SELECT project_id FROM task_projects WHERE task_id = $1 ORDER BY project_id',
        [taskId],
      );
      return result.rows.map((row) => row.project_id);
    },
    async listMyDayTaskIds() {
      const result = await client.query<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM my_day_items ORDER BY task_id',
      );
      return result.rows.map((row) => row.task_id);
    },
    async listIngestSuppressions() {
      const result = await client.query<{ connector_instance_id: string; source_id: string }>(
        'SELECT connector_instance_id, source_id FROM task_ingest_suppressions',
      );
      return result.rows.map((row) => ({
        connectorInstanceId: row.connector_instance_id,
        sourceId: row.source_id,
      }));
    },
    async listAttachmentTaskIds() {
      const result = await client.query<{ task_id: string }>(
        'SELECT DISTINCT task_id FROM task_attachments ORDER BY task_id',
      );
      return result.rows.map((row) => row.task_id);
    },
    async getTaskUpdatedAt(taskId) {
      const result = await client.query<{ updated_at: string }>(
        'SELECT updated_at FROM tasks WHERE id = $1',
        [taskId],
      );
      return result.rows[0]?.updated_at ?? null;
    },
    async countMyDayItems() {
      const result = await client.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM my_day_items',
      );
      return Number(result.rows[0]?.count ?? 0);
    },
  };

  return harness;
}

if (connectionString) {
  describeTaskCoreContract('PostgreSQL adapter', createHarness);

  afterAll(async () => {
    if (runtime && harness) {
      await harness.reset();
      await runtime.shutdownRuntimeDatabase();
    }
    restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
    restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
    restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
    restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  });
} else {
  describe('task-core contract: PostgreSQL adapter', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
