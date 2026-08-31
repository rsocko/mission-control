import { afterAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresWorkTodoRepositories } from '@/db/postgres/repositories';
import {
  describeWorkTodoRepositoriesContract,
  type WorkTodoHarness,
} from '../contracts/work-todo-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-work-todo-test',
        }),
      }
    : {}),
});
let initialized = false;

const CONNECTOR = 'work-todo-contract';
const NOW = '2026-08-07T00:00:00.000Z';

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function cleanupContractRows(): Promise<void> {
  const pool = backend.context.pool;
  await pool.query('DELETE FROM work_todo_outbound_changes WHERE connector_id = $1', [CONNECTOR]);
  await pool.query('DELETE FROM work_todo_list_delta_state WHERE connector_id = $1', [CONNECTOR]);
  await pool.query('DELETE FROM work_todo_bridge_state WHERE connector_id = $1', [CONNECTOR]);
  await pool.query(
    `DELETE FROM task_tags WHERE task_id IN (
       SELECT id FROM tasks WHERE connector_instance_id = $1
     )`,
    [CONNECTOR],
  );
  await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [CONNECTOR]);
  await pool.query(`DELETE FROM tags WHERE id LIKE $1`, [`${CONNECTOR}:tag:%`]);
  await pool.query('DELETE FROM source_lists WHERE connector_instance_id = $1', [CONNECTOR]);
  await pool.query('DELETE FROM connector_configs WHERE id = $1', [CONNECTOR]);
}

function createHarness(): WorkTodoHarness {
  const pool = backend.context.pool;
  const repositories = createPostgresWorkTodoRepositories(pool);

  async function setConnector(input: {
    id: string;
    type: string;
    enabled: boolean;
    deletedAt?: string | null;
  }): Promise<void> {
    await pool.query(
      `INSERT INTO connector_configs (
         id, type, name, enabled, capabilities, credentials, settings,
         created_at, updated_at, deleted_at
       ) VALUES ($1, $2, $1, $3, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $4, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         type = EXCLUDED.type,
         enabled = EXCLUDED.enabled,
         deleted_at = EXCLUDED.deleted_at`,
      [input.id, input.type, input.enabled, NOW, input.deletedAt ?? null],
    );
  }

  return {
    repositories,
    reset: async () => {
      await cleanupContractRows();
      await setConnector({ id: CONNECTOR, type: 'microsoft-todo-work', enabled: true });
    },
    setConnector,
    seedBridgeState: async (state) => {
      await pool.query(
        `INSERT INTO work_todo_bridge_state (
           connector_id, transport, capability_profile, list_delta_link,
           reset_required, last_ingest_at, last_ingest_mode, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT (connector_id) DO UPDATE SET
           transport = EXCLUDED.transport,
           capability_profile = EXCLUDED.capability_profile,
           list_delta_link = EXCLUDED.list_delta_link,
           reset_required = EXCLUDED.reset_required,
           last_ingest_at = EXCLUDED.last_ingest_at,
           last_ingest_mode = EXCLUDED.last_ingest_mode`,
        [
          state.connectorId,
          state.transport,
          state.capabilityProfile,
          state.listDeltaLink ?? null,
          state.resetRequired ?? false,
          state.lastIngestAt ?? null,
          state.lastIngestMode ?? null,
          NOW,
        ],
      );
    },
    seedListDeltaState: async (input) => {
      await pool.query(
        `INSERT INTO work_todo_list_delta_state (
           connector_id, list_source_id, delta_link, updated_at
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (connector_id, list_source_id) DO UPDATE SET
           delta_link = EXCLUDED.delta_link`,
        [input.connectorId, input.listSourceId, input.deltaLink, NOW],
      );
    },
    seedSourceListHidden: async (input) => {
      await pool.query(
        `UPDATE source_lists SET hidden = $1
         WHERE connector_instance_id = $2 AND source_id = $3`,
        [input.hidden, input.connectorId, input.sourceId],
      );
    },
    listTasks: async (connectorId) => (await pool.query<{
      id: string;
      sourceId: string;
      title: string;
      status: string;
      priority: string;
      dueDate: string | null;
      syncStatus: string;
      updatedAt: string;
      lastSyncedAt: string;
      parentId: string | null;
      metadata: Record<string, unknown> | null;
    }>(
      `SELECT id, source_id AS "sourceId", title, status, priority,
              due_date AS "dueDate", sync_status AS "syncStatus",
              updated_at AS "updatedAt", last_synced_at AS "lastSyncedAt",
              parent_id AS "parentId", metadata
       FROM tasks WHERE connector_instance_id = $1 ORDER BY source_id`,
      [connectorId],
    )).rows.map((row) => ({ ...row, metadata: row.metadata ?? {} })),
    updateTask: async (taskId, patch) => {
      const assignments: string[] = [];
      const values: unknown[] = [];
      const push = (column: string, value: unknown, cast = '') => {
        values.push(value);
        assignments.push(`${column} = $${values.length}${cast}`);
      };
      if (patch.title !== undefined) push('title', patch.title);
      if (patch.status !== undefined) push('status', patch.status);
      if (patch.priority !== undefined) push('priority', patch.priority);
      if (patch.dueDate !== undefined) push('due_date', patch.dueDate);
      if (patch.syncStatus !== undefined) push('sync_status', patch.syncStatus);
      if (patch.updatedAt !== undefined) push('updated_at', patch.updatedAt);
      if (patch.metadata !== undefined) {
        push('metadata', JSON.stringify(patch.metadata), '::jsonb');
      }
      if (assignments.length === 0) return;
      values.push(taskId);
      await pool.query(
        `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${values.length}`,
        values,
      );
    },
    listChanges: async (connectorId) => (await pool.query<{
      idempotencyKey: string;
      taskId: string;
      sourceId: string;
      listSourceId: string;
      remoteTaskId: string;
      operation: string;
      fields: Record<string, unknown> | null;
      taskVersion: string;
      status: string;
      leaseId: string | null;
      leaseExpiresAt: string | null;
      attemptCount: number;
      lastError: string | null;
    }>(
      `SELECT idempotency_key AS "idempotencyKey", task_id AS "taskId",
              source_id AS "sourceId", list_source_id AS "listSourceId",
              remote_task_id AS "remoteTaskId", operation, fields,
              task_version AS "taskVersion", status, lease_id AS "leaseId",
              lease_expires_at AS "leaseExpiresAt", attempt_count AS "attemptCount",
              last_error AS "lastError"
       FROM work_todo_outbound_changes WHERE connector_id = $1
       ORDER BY created_at, idempotency_key`,
      [connectorId],
    )).rows.map((row) => ({ ...row, attemptCount: Number(row.attemptCount) })),
    expireLease: async (idempotencyKey, leaseExpiresAt) => {
      await pool.query(
        'UPDATE work_todo_outbound_changes SET lease_expires_at = $1 WHERE idempotency_key = $2',
        [leaseExpiresAt, idempotencyKey],
      );
    },
    getBridgeState: async (connectorId) => (await pool.query<{
      transport: string;
      capabilityProfile: string;
      listDeltaLink: string | null;
      resetRequired: boolean;
      lastIngestAt: string | null;
      lastIngestMode: string | null;
    }>(
      `SELECT transport, capability_profile AS "capabilityProfile",
              list_delta_link AS "listDeltaLink", reset_required AS "resetRequired",
              last_ingest_at AS "lastIngestAt", last_ingest_mode AS "lastIngestMode"
       FROM work_todo_bridge_state WHERE connector_id = $1`,
      [connectorId],
    )).rows[0] ?? null,
    listSourceListIds: async (connectorId) => (await pool.query<{ sourceId: string }>(
      `SELECT source_id AS "sourceId" FROM source_lists
       WHERE connector_instance_id = $1 ORDER BY source_id`,
      [connectorId],
    )).rows.map((row) => row.sourceId),
    listTaskTagSlugs: async (taskId) => (await pool.query<{ slug: string }>(
      `SELECT tags.slug AS slug FROM task_tags
       INNER JOIN tags ON tags.id = task_tags.tag_id
       WHERE task_tags.task_id = $1 ORDER BY tags.slug`,
      [taskId],
    )).rows.map((row) => row.slug),
    close: () => undefined,
  };
}

if (connectionString) {
  describeWorkTodoRepositoriesContract('PostgreSQL', async (): Promise<WorkTodoHarness> => {
    await initialize();
    return createHarness();
  });

  describe('PostgreSQL Work To Do concurrency', () => {
    async function seedPendingTasks(count: number): Promise<WorkTodoHarness> {
      const harness = createHarness();
      await harness.reset();
      const template = {
        id: 'task-0',
        title: 'Remote title',
        status: 'notStarted' as const,
        importance: 'normal' as const,
        body: { content: 'body', contentType: 'text' as const },
        createdDateTime: '2026-08-07T17:00:00.000Z',
        lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
        completedDateTime: null,
        dueDateTime: null,
        isReminderOn: false,
        reminderDateTime: null,
      };
      await harness.repositories.ingest({
        payload: {
          schemaVersion: '1.0',
          connectorInstanceId: CONNECTOR,
          syncTimestamp: '2026-08-07T18:05:00.000Z',
          isFullSnapshot: true,
          lists: [{
            id: 'list-1',
            displayName: 'Tasks',
            tasks: Array.from({ length: count }, (_, index) => ({
              ...template,
              id: `task-${index}`,
            })),
          }],
        },
        now: '2026-08-07T18:05:00.000Z',
        timezone: 'UTC',
      });
      const tasks = await harness.listTasks(CONNECTOR);
      for (const [index, task] of tasks.entries()) {
        await harness.updateTask(task.id, {
          title: `Local ${index}`,
          syncStatus: 'pending_push',
          updatedAt: `2026-08-07T18:1${index}:00.000Z`,
          metadata: { ...task.metadata, workTodoDirtyFields: ['title'] },
        });
      }
      return harness;
    }

    it('never hands the same change to two concurrent leases', async () => {
      await initialize();
      const harness = await seedPendingTasks(4);

      const [first, second] = await Promise.all([
        harness.repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:20:00.000Z',
        }),
        harness.repositories.lease({
          connectorId: CONNECTOR,
          now: '2026-08-07T18:20:00.000Z',
        }),
      ]);

      const firstKeys = first.changes.map((change) => change.idempotencyKey);
      const secondKeys = second.changes.map((change) => change.idempotencyKey);
      if (first.leaseId === second.leaseId) {
        expect(secondKeys).toEqual(firstKeys);
      } else {
        expect(firstKeys.filter((key) => secondKeys.includes(key))).toEqual([]);
      }
      const changes = await harness.listChanges(CONNECTOR);
      const leaseIds = new Set(
        changes.filter((change) => change.status === 'leased').map((change) => change.leaseId),
      );
      expect(leaseIds.size).toBeLessThanOrEqual(1);
      expect(changes).toHaveLength(4);
    });

    it('rejects a stale lease epoch after the lease was reclaimed', async () => {
      await initialize();
      const harness = await seedPendingTasks(1);
      const stale = await harness.repositories.lease({
        connectorId: CONNECTOR,
        now: '2026-08-07T18:20:00.000Z',
      });
      await harness.expireLease(
        stale.changes[0].idempotencyKey,
        '2026-08-07T18:21:00.000Z',
      );
      const current = await harness.repositories.lease({
        connectorId: CONNECTOR,
        now: '2026-08-07T18:30:00.000Z',
      });
      expect(current.leaseId).not.toBe(stale.leaseId);

      await expect(harness.repositories.acknowledge({
        payload: {
          connectorInstanceId: CONNECTOR,
          leaseId: stale.leaseId,
          processedAt: '2026-08-07T18:31:00.000Z',
          results: [{
            idempotencyKey: stale.changes[0].idempotencyKey,
            sourceId: stale.changes[0].sourceId,
            status: 'succeeded',
          }],
        },
        now: '2026-08-07T18:31:00.000Z',
      })).rejects.toMatchObject({ code: 'ACK_LEASE_MISMATCH', status: 409 });

      const [change] = await harness.listChanges(CONNECTOR);
      expect(change).toMatchObject({ status: 'leased', leaseId: current.leaseId });
    });

    it('serializes concurrent ingests without duplicating a source ID', async () => {
      await initialize();
      const harness = createHarness();
      await harness.reset();
      const payload = {
        schemaVersion: '1.0' as const,
        connectorInstanceId: CONNECTOR,
        syncTimestamp: '2026-08-07T18:05:00.000Z',
        isFullSnapshot: true as const,
        lists: [{
          id: 'list-1',
          displayName: 'Tasks',
          tasks: [{
            id: 'task-1',
            title: 'Remote title',
            status: 'notStarted' as const,
            importance: 'normal' as const,
            body: { content: 'body', contentType: 'text' as const },
            createdDateTime: '2026-08-07T17:00:00.000Z',
            lastModifiedDateTime: '2026-08-07T18:00:00.000Z',
            completedDateTime: null,
            dueDateTime: null,
            isReminderOn: false,
            reminderDateTime: null,
          }],
        }],
      };

      await Promise.all([
        harness.repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: 'UTC',
        }),
        harness.repositories.ingest({
          payload,
          now: '2026-08-07T18:05:00.000Z',
          timezone: 'UTC',
        }),
      ]);

      expect(await harness.listTasks(CONNECTOR)).toHaveLength(1);
    });
  });
} else {
  describe.skip('PostgreSQL Work To Do repositories', () => {
    it('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}

afterAll(async () => {
  if (initialized) {
    await cleanupContractRows();
    await backend.shutdown();
    initialized = false;
  }
});
