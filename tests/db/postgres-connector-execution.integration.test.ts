import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { createPostgresConnectorExecutionRepositories } from '@/db/postgres/repositories';
import { PostgresSyncRunRepository } from '@/db/postgres/repositories/sync-run-repository';
import { PostgresSyncJobRepository } from '@/db/postgres/sync/job-repository';
import {
  connectorExecutionTask,
  describeConnectorExecutionRepositoriesContract,
  type ConnectorExecutionHarness,
} from '../contracts/connector-execution-repositories.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const backend = new PostgresPersistenceBackend({
  ...(connectionString
    ? {
        config: resolvePostgresConfig({
          MC_POSTGRES_URL: connectionString,
          MC_POSTGRES_APPLICATION_NAME: 'mission-control-connector-execution-test',
        }),
      }
    : {}),
});
let initialized = false;

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  await backend.initialize();
  initialized = true;
}

async function cleanupContractRows(): Promise<void> {
  const pool = backend.context.pool;
  await pool.query(`
    DELETE FROM notification_delivery_events
    WHERE notification_id IN (
      SELECT id FROM notifications WHERE source_id LIKE 'portable-connector:notice%'
    )
  `);
  await pool.query(`
    DELETE FROM notification_actions
    WHERE notification_id IN (
      SELECT id FROM notifications WHERE source_id LIKE 'portable-connector:notice%'
    )
  `);
  await pool.query(`DELETE FROM notifications WHERE source_id LIKE 'portable-connector:notice%'`);
  await pool.query(`DELETE FROM sync_deletion_candidates WHERE connector_id = 'portable-connector'`);
  await pool.query(`DELETE FROM sync_deletion_snapshots WHERE connector_id = 'portable-connector'`);
  await pool.query(`DELETE FROM sync_log WHERE connector_id = 'portable-connector'`);
  await pool.query(`
    DELETE FROM task_tags
    WHERE task_id IN (
      'portable-task', 'delete-task', 'conflict-task',
      'retained-parent', 'retained-child', 'restore-conflict-task', 'create-outcome-task',
      'tag-task-one', 'tag-task-two'
    )
  `);
  await pool.query(`
    DELETE FROM tasks
    WHERE id IN (
      'portable-task', 'delete-task', 'conflict-task',
      'retained-parent', 'retained-child', 'restore-conflict-task', 'create-outcome-task',
      'tag-task-one', 'tag-task-two'
    )
  `);
  await pool.query(`DELETE FROM tags WHERE slug IN ('portable', 'portable-concurrent')`);
  await pool.query(`DELETE FROM source_lists WHERE connector_instance_id = 'portable-connector'`);
  await pool.query(`DELETE FROM list_groups WHERE source_id = 'folder-1'`);
}

if (connectionString) {
  describeConnectorExecutionRepositoriesContract(
    'PostgreSQL',
    async (): Promise<ConnectorExecutionHarness> => {
      await initialize();
      await cleanupContractRows();
      const repositories = createPostgresConnectorExecutionRepositories(
        backend.context.pool,
      );
      return {
        repositories,
        seedRetentionLog: async (input) => {
          await backend.context.pool.query(
            `
              INSERT INTO sync_log (
                id, connector_id, success, tasks_added, tasks_updated,
                tasks_removed, tasks_pushed, local_only_protected, alerts_added,
                errors, details, synced_at
              ) VALUES ($1, $2, true, 0, 0, 0, 0, 0, 0, '[]'::jsonb, $3, $4)
            `,
            [input.id, input.connectorId, JSON.stringify(input.details), input.syncedAt],
          );
        },
        notificationCounts: async (sourceId) => {
          const result = await backend.context.pool.query<{
            notifications: string;
            actions: string;
            deliveries: string;
          }>(
            `
              SELECT
                count(DISTINCT notification.id)::text AS notifications,
                count(DISTINCT action.id)::text AS actions,
                count(DISTINCT delivery.id)::text AS deliveries
              FROM notifications notification
              LEFT JOIN notification_actions action
                ON action.notification_id = notification.id
              LEFT JOIN notification_delivery_events delivery
                ON delivery.notification_id = notification.id
              WHERE notification.source_id = $1
            `,
            [sourceId],
          );
          const row = result.rows[0];
          return {
            notifications: Number(row.notifications),
            actions: Number(row.actions),
            deliveries: Number(row.deliveries),
          };
        },
        notificationActionState: async (sourceId) => {
          const result = await backend.context.pool.query<{
            primaryActionId: string | null;
            actionIds: string[];
          }>(
            `
              SELECT
                notification.primary_action_id AS "primaryActionId",
                COALESCE(
                  array_agg(action.id ORDER BY action.id)
                    FILTER (WHERE action.id IS NOT NULL),
                  ARRAY[]::text[]
                ) AS "actionIds"
              FROM notifications notification
              LEFT JOIN notification_actions action
                ON action.notification_id = notification.id
              WHERE notification.source_id = $1
              GROUP BY notification.id, notification.primary_action_id
            `,
            [sourceId],
          );
          return result.rows[0] ?? null;
        },
        tagCount: async (slug) => Number((
          await backend.context.pool.query<{ count: string }>(
            'SELECT count(*)::text AS count FROM tags WHERE slug = $1',
            [slug],
          )
        ).rows[0].count),
        deletionSnapshotState: async (snapshotId) => {
          const result = await backend.context.pool.query<{
            recoveryState: string;
            quarantineReason: string | null;
          }>(
            `
              SELECT
                recovery_state AS "recoveryState",
                quarantine_reason AS "quarantineReason"
              FROM sync_deletion_snapshots
              WHERE id = $1
            `,
            [snapshotId],
          );
          return result.rows[0] ?? null;
        },
        syncLogCount: async (connectorId) => Number((
          await backend.context.pool.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM sync_log WHERE connector_id = $1`,
            [connectorId],
          )
        ).rows[0].count),
        close: () => undefined,
      };
    },
  );
}

const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL generic connector execution smoke', () => {
  const connectorIds = new Set<string>();

  beforeAll(initialize, 120_000);

  afterEach(async () => {
    for (const connectorId of connectorIds) {
      const pool = backend.context.pool;
      await pool.query(`
        DELETE FROM notification_delivery_events
        WHERE notification_id IN (
          SELECT id FROM notifications WHERE connector_instance_id = $1
        )
      `, [connectorId]);
      await pool.query(`
        DELETE FROM notification_actions
        WHERE notification_id IN (
          SELECT id FROM notifications WHERE connector_instance_id = $1
        )
      `, [connectorId]);
      await pool.query('DELETE FROM notifications WHERE connector_instance_id = $1', [connectorId]);
      await pool.query('DELETE FROM notification_push_rules WHERE connector_instance_id = $1', [connectorId]);
      await pool.query('DELETE FROM task_tags WHERE task_id IN (SELECT id FROM tasks WHERE connector_instance_id = $1)', [connectorId]);
      await pool.query('DELETE FROM tasks WHERE connector_instance_id = $1', [connectorId]);
      await pool.query('DELETE FROM tags WHERE source = $1', [connectorId]);
      await pool.query('DELETE FROM source_lists WHERE connector_instance_id = $1', [connectorId]);
      await pool.query('DELETE FROM sync_log WHERE connector_id = $1', [connectorId]);
      await pool.query('DELETE FROM sync_jobs WHERE connector_id = $1', [connectorId]);
      await pool.query('DELETE FROM connector_operation_leases WHERE connector_id = $1', [connectorId]);
      await pool.query('DELETE FROM connector_configs WHERE id = $1', [connectorId]);
    }
    connectorIds.clear();
  });

  it('runs enqueue/claim through generic persistence, exact completion, and retry failure', async () => {
    const connectorId = `layer2-${randomUUID()}`;
    connectorIds.add(connectorId);
    const now = new Date().toISOString();
    await backend.context.pool.query(
      `
        INSERT INTO connector_configs (
          id, type, name, enabled, capabilities, credentials, settings,
          synced_lists, created_at, updated_at
        ) VALUES ($1, 'custom-rest', 'Layer 2 inert connector', true, $2, '{}', '{}', '[]', $3, $3)
      `,
      [
        connectorId,
        JSON.stringify({
          read: true,
          write: true,
          delete: true,
          sync: true,
          subtasks: false,
          lists: true,
          tags: true,
          tagWriteBack: false,
        }),
        now,
      ],
    );

    const execution = createPostgresConnectorExecutionRepositories(backend.context.pool);
    const jobs = new PostgresSyncJobRepository(backend.context.pool);
    const runs = new PostgresSyncRunRepository(backend.context.db);
    const remoteEffects: string[] = [];
    const inertConnector = {
      fetchSourceLists: async () => [{
        sourceId: 'list-1',
        name: 'Inert list',
        type: 'list',
      }],
      createTask: async (taskId: string) => {
        remoteEffects.push(taskId);
        return { sourceId: 'remote-task-1' };
      },
      fetchTasks: async () => [{
        sourceId: 'remote-task-1',
        title: 'Pulled inert task',
        status: 'in_progress',
      }],
      fetchNotifications: async () => [{
        id: 'notice-1',
        title: 'Inert notification',
      }],
    };
    const queued = await jobs.enqueue(connectorId, { maxAttempts: 3 });
    const claimed = await jobs.claimNext(`worker-${connectorId}`, 60_000);
    expect(claimed?.id).toBe(queued.id);

    const [remoteList] = await inertConnector.fetchSourceLists();
    await execution.lists.applyDiscovery({
      connectorId,
      upserts: [{
        id: `${connectorId}:list`,
        connectorInstanceId: connectorId,
        sourceId: remoteList.sourceId,
        name: remoteList.name,
        type: remoteList.type,
        taskCount: 1,
        lastSyncedAt: now,
        wellKnownListName: null,
        lastKnownRemoteName: remoteList.name,
      }, {
        id: `${connectorId}:stale-list`,
        connectorInstanceId: connectorId,
        sourceId: 'stale-list',
        name: 'Stale list',
        type: 'list',
        taskCount: 0,
        lastSyncedAt: now,
        wellKnownListName: null,
        lastKnownRemoteName: 'Stale list',
      }],
      stale: [],
    });
    await execution.lists.applyDiscovery({
      connectorId,
      upserts: [],
      stale: [{ id: `${connectorId}:stale-list`, action: 'delete' }],
    });
    await expect(execution.lists.list(connectorId)).resolves.toEqual([
      expect.objectContaining({ sourceId: 'list-1' }),
    ]);
    const task = connectorExecutionTask({
      id: `${connectorId}:task`,
      sourceId: `local:${connectorId}:task`,
      connectorInstanceId: connectorId,
      sourceListId: 'list-1',
      sourceListName: 'Inert list',
    });
    await execution.pulls.insertBatch([{ task, tags: [] }]);

    const taskLease = new Date().toISOString();
    expect(await execution.pushes.claim(
      task.id,
      taskLease,
      new Date(Date.now() - 60_000).toISOString(),
    )).toBe(true);
    const claimedTask = await execution.pushes.loadClaimed(task.id, taskLease);
    expect(claimedTask?.title).toBe(task.title);
    const created = await inertConnector.createTask(claimedTask!.id);
    expect(await execution.pushes.complete({
      taskId: task.id,
      leaseToken: taskLease,
      sourceId: created.sourceId,
      now: new Date().toISOString(),
      expectedTaskVersion: task.updatedAt,
    })).toBe(true);
    expect(remoteEffects).toEqual([task.id]);

    const [remoteTask] = await inertConnector.fetchTasks();
    expect(await execution.pulls.applyRemoteUpdate({
      taskId: task.id,
      expectedSyncStatus: 'synced',
      values: {
        title: remoteTask.title,
        status: remoteTask.status,
        syncStatus: 'synced',
        lastSyncedAt: new Date().toISOString(),
      },
      sourceTags: [{
        name: 'Layer 2',
        slug: `layer2-${connectorId}`,
        type: 'source',
        source: connectorId,
      }],
    })).toBe(true);
    const [staleTask] = await execution.pulls.listStaleInProgress(connectorId);
    expect(staleTask.sourceId).toBe('remote-task-1');
    await expect(execution.pulls.applyVerifiedTerminalStatus({
      taskId: task.id,
      expectedStatus: 'in_progress',
      status: 'done',
      completedAt: new Date().toISOString(),
      now: new Date().toISOString(),
    })).resolves.toBe(true);
    await backend.context.pool.query(
      `
        INSERT INTO notification_push_rules (
          id, connector_instance_id, template_key, enabled, min_level,
          preview, max_per_hour, created_at, updated_at
        ) VALUES ($1, $2, 'generic_notice', true, 'fyi', 'title_only', NULL, $3, $3)
      `,
      [`${connectorId}:push-rule`, connectorId, now],
    );
    const [remoteNotification] = await inertConnector.fetchNotifications();
    const [notification] = await execution.notifications.ingest([{
      input: {
        id: `${connectorId}:notification`,
        sourceId: `${connectorId}:${remoteNotification.id}`,
        connectorType: 'custom-rest',
        connectorInstanceId: connectorId,
        title: remoteNotification.title,
        body: null,
        level: 'fyi',
        category: 'general',
        templateKey: 'generic_notice',
        readState: 'unread',
        sourceState: 'active',
        sourceActivityAt: now,
        sourceActivityKey: 'one',
        reopenPolicy: 'handled',
        occurrenceKey: 'one',
        isActionable: true,
        primaryActionId: `${connectorId}:action`,
        receivedAt: now,
        sortAt: now,
        relatedTaskId: null,
        relatedProjectId: null,
        relatedEntityType: null,
        relatedEntityId: null,
        navigationTarget: '/notifications',
        metadata: {},
        presentation: {},
      },
      actions: [{
        id: `${connectorId}:action`,
        notificationId: `${connectorId}:notification`,
        actionType: 'open_url',
        label: 'Open',
        variant: 'primary',
        isPrimary: true,
        sortOrder: 0,
        payload: { url: '/notifications' },
        opensExternal: false,
        requiresConfirmation: false,
        createdBy: 'connector',
      }],
    }]);
    expect(notification.created).toBe(true);
    const notificationRows = await backend.context.pool.query<{
      actions: string;
      deliveries: string;
    }>(
      `
        SELECT
          (SELECT count(*) FROM notification_actions
            WHERE notification_id = $1)::text AS actions,
          (SELECT count(*) FROM notification_delivery_events
            WHERE notification_id = $1)::text AS deliveries
      `,
      [`${connectorId}:notification`],
    );
    expect(notificationRows.rows[0]).toEqual({ actions: '1', deliveries: '2' });
    const active = await execution.notifications.listActive(connectorId);
    expect(active).toHaveLength(1);
    await expect(execution.notifications.applyReconciliation({
      outcomes: [{
        notificationId: active[0].id,
        resolved: true,
        reason: 'inert_smoke',
      }],
      now: new Date().toISOString(),
    })).resolves.toBe(1);

    const syncRunId = `${connectorId}:success-log`;
    const result = {
      connectorId,
      success: true,
      tasksAdded: 0,
      tasksUpdated: 2,
      tasksRemoved: 0,
      notificationsAdded: 1,
      errors: [],
      syncedAt: new Date().toISOString(),
      syncRunId,
    };
    await runs.append({
      ...result,
      id: syncRunId,
      success: false,
      tasksPushed: 1,
      localOnlyProtected: 0,
      details: [],
      durationMs: 10,
      jobId: null,
      identityMode: null,
      identityModeRevision: null,
    });
    await jobs.finalizeSuccess(claimed!, `worker-${connectorId}`, result);
    await expect(jobs.get(claimed!.id)).resolves.toMatchObject({
      status: 'succeeded',
      result: { syncRunId },
    });
    const linked = await backend.context.pool.query<{
      jobId: string;
      attempt: number;
    }>(
      `
        SELECT job_id AS "jobId", attempt FROM sync_log WHERE id = $1
      `,
      [syncRunId],
    );
    expect(linked.rows[0]).toEqual({ jobId: claimed!.id, attempt: 1 });

    const failing = await jobs.enqueue(connectorId, { maxAttempts: 3 });
    const failingClaim = await jobs.claimNext(`worker-fail-${connectorId}`, 60_000);
    expect(failingClaim?.id).toBe(failing.id);
    const failureLogId = `${connectorId}:failure-log`;
    const failedResult = {
      connectorId,
      success: false,
      tasksAdded: 0,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 0,
      errors: ['synthetic failure'],
      syncedAt: new Date().toISOString(),
      syncRunId: failureLogId,
    };
    await runs.append({
      ...failedResult,
      id: failureLogId,
      tasksPushed: 0,
      localOnlyProtected: 0,
      details: [],
      durationMs: 5,
      jobId: failingClaim!.id,
      identityMode: null,
      identityModeRevision: null,
    });
    await jobs.linkSyncLog(failingClaim!, failedResult);
    await expect(jobs.fail(
      failingClaim!,
      `worker-fail-${connectorId}`,
      'synthetic failure',
    )).resolves.toBe('queued');
    const retried = await jobs.get(failingClaim!.id);
    expect(retried).toMatchObject({ status: 'queued', error: 'synthetic failure' });
    expect(Date.parse(retried!.availableAt)).toBeGreaterThan(Date.now());
    const failureLink = await backend.context.pool.query<{ jobId: string }>(
      `SELECT job_id AS "jobId" FROM sync_log WHERE id = $1`,
      [failureLogId],
    );
    expect(failureLink.rows[0].jobId).toBe(failingClaim!.id);
    const lease = await backend.context.pool.query(
      'SELECT 1 FROM connector_operation_leases WHERE connector_id = $1',
      [connectorId],
    );
    expect(lease.rowCount).toBe(0);
  });
});

afterAll(async () => {
  if (initialized) {
    await cleanupContractRows();
    await backend.shutdown();
    initialized = false;
  }
});
