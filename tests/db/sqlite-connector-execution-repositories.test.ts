import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterAll, vi } from 'vitest';
import {
  describeConnectorExecutionRepositoriesContract,
  type ConnectorExecutionHarness,
} from '../contracts/connector-execution-repositories.contract';

vi.unmock('drizzle-orm');

const previousPath = process.env.MC_DB_PATH;
const databasePath = join(
  process.cwd(),
  'data',
  `connector-execution-contract-${randomUUID()}.db`,
);
mkdirSync(dirname(databasePath), { recursive: true });
process.env.MC_DB_PATH = databasePath;

const contextPromise = Promise.all([
  import('@/db'),
  import('@/db/persistence/sqlite-connector-execution-repositories'),
]).then(([database, adapter]) => ({
  database,
  repositories: adapter.createSqliteConnectorExecutionRepositories(
    database.sqlite,
    database.default,
  ),
}));

describeConnectorExecutionRepositoriesContract('SQLite', async (): Promise<ConnectorExecutionHarness> => {
  const context = await contextPromise;
  context.database.sqlite.exec(`
    DELETE FROM notification_delivery_events;
    DELETE FROM notification_actions;
    DELETE FROM notifications;
    DELETE FROM sync_deletion_candidates;
    DELETE FROM sync_deletion_snapshots;
    DELETE FROM sync_log;
    DELETE FROM task_tags;
    DELETE FROM tags;
    DELETE FROM source_lists;
    DELETE FROM list_groups;
    DELETE FROM tasks;
  `);
  return {
    repositories: context.repositories,
    seedRetentionLog: async (input) => {
      context.database.sqlite.prepare(`
        INSERT INTO sync_log (
          id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
          tasks_pushed, local_only_protected, alerts_added, errors, details,
          synced_at
        ) VALUES (?, ?, 1, 0, 0, 0, 0, 0, 0, '[]', ?, ?)
      `).run(
        input.id,
        input.connectorId,
        JSON.stringify(input.details),
        input.syncedAt,
      );
    },
    notificationCounts: async (sourceId) => {
      const notification = context.database.sqlite.prepare(`
        SELECT id FROM notifications WHERE source_id = ?
      `).get(sourceId) as { id: string } | undefined;
      const count = (table: string, where: string, value: string): number => Number(
        (context.database.sqlite.prepare(
          `SELECT count(*) AS count FROM ${table} WHERE ${where} = ?`,
        ).get(value) as { count: number }).count,
      );
      return {
        notifications: count('notifications', 'source_id', sourceId),
        actions: notification
          ? count('notification_actions', 'notification_id', notification.id)
          : 0,
        deliveries: notification
          ? count('notification_delivery_events', 'notification_id', notification.id)
          : 0,
      };
    },
    notificationActionState: async (sourceId) => {
      const notification = context.database.sqlite.prepare(`
        SELECT id, primary_action_id AS primaryActionId
        FROM notifications
        WHERE source_id = ?
      `).get(sourceId) as { id: string; primaryActionId: string | null } | undefined;
      if (!notification) return null;
      const actions = context.database.sqlite.prepare(`
        SELECT id FROM notification_actions
        WHERE notification_id = ?
        ORDER BY id
      `).all(notification.id) as Array<{ id: string }>;
      return {
        primaryActionId: notification.primaryActionId,
        actionIds: actions.map(action => action.id),
      };
    },
    tagCount: async (slug) => Number((
      context.database.sqlite.prepare('SELECT count(*) AS count FROM tags WHERE slug = ?')
        .get(slug) as { count: number }
    ).count),
    deletionSnapshotState: async (snapshotId) => (
      context.database.sqlite.prepare(`
        SELECT
          recovery_state AS recoveryState,
          quarantine_reason AS quarantineReason
        FROM sync_deletion_snapshots
        WHERE id = ?
      `).get(snapshotId) as {
        recoveryState: string;
        quarantineReason: string | null;
      } | undefined
    ) ?? null,
    syncLogCount: async (connectorId) => Number((
      context.database.sqlite.prepare(`
        SELECT count(*) AS count FROM sync_log WHERE connector_id = ?
      `).get(connectorId) as { count: number }
    ).count),
    close: () => undefined,
  };
});

afterAll(async () => {
  const context = await contextPromise;
  context.database.sqlite.close();
  rmSync(databasePath, { force: true });
  rmSync(`${databasePath}-wal`, { force: true });
  rmSync(`${databasePath}-shm`, { force: true });
  if (previousPath === undefined) delete process.env.MC_DB_PATH;
  else process.env.MC_DB_PATH = previousPath;
});
