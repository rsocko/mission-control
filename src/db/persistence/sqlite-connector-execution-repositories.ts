import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { ConnectorConfig } from '@/types';
import * as schema from '@/db/schema';
import { notificationActions } from '@/db/schema';
import {
  createNotificationsInTransaction,
  type CreateNotificationInput,
} from '@/lib/notifications/service';
import {
  archiveAndDeleteTask as archiveAndDeleteTaskSqlite,
  restoreDeletionSnapshot as restoreDeletionSnapshotSqlite,
} from './sqlite-deletion-recovery';
import type {
  ConnectorExecutionRepositories,
  ConnectorNotificationCommand,
  ConnectorTaskRecord,
  ConnectorTaskUpdate,
  DeletionCandidateRecord,
  DeletionIdentityState,
  PullTag,
  RetentionDetailRecord,
  SourceListRecord,
} from './connector-execution';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

const TASK_COLUMNS = `
  id,
  source_id AS sourceId,
  connector_type AS connectorType,
  connector_instance_id AS connectorInstanceId,
  title,
  description,
  status,
  local_disposition AS localDisposition,
  priority,
  planning_horizon AS planningHorizon,
  due_date AS dueDate,
  push_count AS pushCount,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt,
  recurrence_generated_from_task_id AS recurrenceGeneratedFromTaskId,
  parent_id AS parentId,
  depth,
  is_checklist_item AS isChecklistItem,
  source_list_id AS sourceListId,
  source_list_name AS sourceListName,
  assignee,
  micro_status AS microStatus,
  status_reason AS statusReason,
  metadata,
  sync_status AS syncStatus,
  last_synced_at AS lastSyncedAt,
  push_retry_count AS pushRetryCount,
  kanban_column AS kanbanColumn,
  kanban_order AS kanbanOrder,
  snoozed_until AS snoozedUntil,
  reminder_at AS reminderAt,
  reminder_relative AS reminderRelative,
  reminder_due_time AS reminderDueTime,
  effort,
  is_bulk_import AS isBulkImport
`;

interface SqliteTaskRow extends Omit<ConnectorTaskRecord, 'metadata' | 'isChecklistItem' | 'isBulkImport'> {
  metadata: unknown;
  isChecklistItem: number;
  isBulkImport: number;
}

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mapTask(row: SqliteTaskRow): ConnectorTaskRecord {
  return {
    ...row,
    metadata: parseObject(row.metadata),
    isChecklistItem: row.isChecklistItem !== 0,
    isBulkImport: row.isBulkImport !== 0,
  };
}

function getTask(database: SqliteDatabase, taskId: string): ConnectorTaskRecord | null {
  const row = database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE id = ?`)
    .get(taskId) as SqliteTaskRow | undefined;
  return row ? mapTask(row) : null;
}

function listTasks(
  database: SqliteDatabase,
  where: string,
  params: readonly unknown[],
): ConnectorTaskRecord[] {
  return (database.prepare(`SELECT ${TASK_COLUMNS} FROM tasks WHERE ${where}`)
    .all(...params) as SqliteTaskRow[]).map(mapTask);
}

function immediate<T>(database: SqliteDatabase, work: () => T): T {
  return database.transaction(work).immediate();
}

const TASK_UPDATE_COLUMNS: Record<keyof ConnectorTaskUpdate, string> = {
  sourceId: 'source_id',
  connectorType: 'connector_type',
  connectorInstanceId: 'connector_instance_id',
  title: 'title',
  description: 'description',
  status: 'status',
  localDisposition: 'local_disposition',
  priority: 'priority',
  planningHorizon: 'planning_horizon',
  dueDate: 'due_date',
  pushCount: 'push_count',
  createdAt: 'created_at',
  updatedAt: 'updated_at',
  completedAt: 'completed_at',
  recurrenceGeneratedFromTaskId: 'recurrence_generated_from_task_id',
  parentId: 'parent_id',
  depth: 'depth',
  isChecklistItem: 'is_checklist_item',
  sourceListId: 'source_list_id',
  sourceListName: 'source_list_name',
  assignee: 'assignee',
  microStatus: 'micro_status',
  statusReason: 'status_reason',
  metadata: 'metadata',
  syncStatus: 'sync_status',
  lastSyncedAt: 'last_synced_at',
  pushRetryCount: 'push_retry_count',
  kanbanColumn: 'kanban_column',
  kanbanOrder: 'kanban_order',
  snoozedUntil: 'snoozed_until',
  reminderAt: 'reminder_at',
  reminderRelative: 'reminder_relative',
  reminderDueTime: 'reminder_due_time',
  effort: 'effort',
  isBulkImport: 'is_bulk_import',
};

function sqliteTaskValue(key: keyof ConnectorTaskUpdate, value: unknown): unknown {
  if (key === 'metadata') return JSON.stringify(value ?? {});
  if (key === 'isChecklistItem' || key === 'isBulkImport') return value ? 1 : 0;
  return value;
}

function updateTask(
  database: SqliteDatabase,
  taskId: string,
  values: ConnectorTaskUpdate,
  suffix = '',
  suffixParams: readonly unknown[] = [],
): number {
  const entries = Object.entries(values).filter(([, value]) => value !== undefined) as Array<
    [keyof ConnectorTaskUpdate, unknown]
  >;
  if (entries.length === 0) return 0;
  const assignments = entries.map(([key]) => `${TASK_UPDATE_COLUMNS[key]} = ?`).join(', ');
  const params = entries.map(([key, value]) => sqliteTaskValue(key, value));
  return database.prepare(`UPDATE tasks SET ${assignments} WHERE id = ? ${suffix}`)
    .run(...params, taskId, ...suffixParams).changes;
}

function upsertSourceTag(
  database: SqliteDatabase,
  tag: PullTag,
): string {
  const existing = database.prepare('SELECT id FROM tags WHERE slug = ? LIMIT 1')
    .get(tag.slug) as { id: string } | undefined;
  if (existing) {
    if (tag.color) {
      database.prepare('UPDATE tags SET color = ? WHERE id = ?').run(tag.color, existing.id);
    }
    return existing.id;
  }
  const id = tag.id ?? randomUUID();
  database.prepare(`
    INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    tag.name,
    tag.slug,
    tag.type || 'source',
    tag.source ?? null,
    tag.color ?? null,
    tag.confirmed === false ? 0 : 1,
    new Date().toISOString(),
  );
  return id;
}

function replaceSourceTags(
  database: SqliteDatabase,
  taskId: string,
  tags: readonly PullTag[],
): void {
  database.prepare(`
    DELETE FROM task_tags
    WHERE task_id = ?
      AND tag_id IN (SELECT id FROM tags WHERE type = 'source')
  `).run(taskId);
  for (const tag of tags) {
    const tagId = upsertSourceTag(database, tag);
    database.prepare(`
      INSERT INTO task_tags (task_id, tag_id)
      SELECT ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM task_tags WHERE task_id = ? AND tag_id = ?
      )
    `).run(taskId, tagId, taskId, tagId);
  }
}

function convertTaskTreeToLocal(
    database: SqliteDatabase,
    taskId: string,
    archive: boolean,
  ): void {
    const now = new Date().toISOString();
    immediate(database, () => {
      const convert = (id: string): void => {
        const task = database.prepare(`
          SELECT
            id,
            source_id AS sourceId,
            connector_type AS connectorType,
            connector_instance_id AS connectorInstanceId,
            metadata
          FROM tasks
          WHERE id = ?
        `).get(id) as {
          id: string;
          sourceId: string;
          connectorType: string;
          connectorInstanceId: string;
          metadata: unknown;
        } | undefined;
        if (!task) return;
        const children = database.prepare('SELECT id FROM tasks WHERE parent_id = ?')
          .all(id) as Array<{ id: string }>;
        database.prepare(`
          UPDATE tasks
          SET source_id = ?,
              connector_type = 'local',
              connector_instance_id = 'local',
              source_list_id = NULL,
              source_list_name = NULL,
              sync_status = 'synced',
              push_retry_count = 0,
              updated_at = ?,
              last_synced_at = ?,
              metadata = ?
          WHERE id = ?
        `).run(
          `local:${task.id}`,
          now,
          now,
          JSON.stringify({
            ...parseObject(task.metadata),
            retentionResolution: {
              action: archive ? 'archive_local' : 'keep_local',
              resolvedAt: now,
              previousConnectorType: task.connectorType,
              previousConnectorInstanceId: task.connectorInstanceId,
              previousSourceId: task.sourceId,
            },
          }),
          task.id,
        );
        for (const child of children) convert(child.id);
      };
      convert(taskId);
    });
  }

function deleteTaskTree(database: SqliteDatabase, taskId: string): void {
    immediate(database, () => {
      const remove = (id: string): void => {
        const children = database.prepare('SELECT id FROM tasks WHERE parent_id = ?')
          .all(id) as Array<{ id: string }>;
        for (const child of children) remove(child.id);
        for (const table of [
          'task_tags',
          'project_auto_include_exclusions',
          'task_projects',
          'task_schedules',
          'my_day_items',
          'my_day_exclusions',
          'focus_items',
          'weekly_one_thing',
          'priority_sync_log',
          'task_triage_log',
          'quick_sort_operations',
          'task_linked_sources',
          'task_attachments',
          'project_phase_items',
        ]) {
          database.prepare(`DELETE FROM ${table} WHERE task_id = ?`).run(id);
        }
        database.prepare(`
          DELETE FROM task_dependencies
          WHERE task_id = ? OR depends_on_task_id = ?
        `).run(id, id);
        database.prepare(`
          UPDATE notifications SET related_task_id = NULL WHERE related_task_id = ?
        `).run(id);
        database.prepare('DELETE FROM tasks WHERE id = ?').run(id);
      };
      remove(taskId);
    });
}

function insertTask(database: SqliteDatabase, task: ConnectorTaskRecord): boolean {
  const result = database.prepare(`
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, local_disposition, priority, planning_horizon, due_date, push_count,
      created_at, updated_at, completed_at, recurrence_generated_from_task_id,
      parent_id, depth, is_checklist_item, source_list_id, source_list_name,
      assignee, micro_status, status_reason, metadata, sync_status, last_synced_at,
      push_retry_count, kanban_column, kanban_order, snoozed_until, reminder_at,
      reminder_relative, reminder_due_time, effort, is_bulk_import
    ) VALUES (
      @id, @sourceId, @connectorType, @connectorInstanceId, @title, @description,
      @status, @localDisposition, @priority, @planningHorizon, @dueDate, @pushCount,
      @createdAt, @updatedAt, @completedAt, @recurrenceGeneratedFromTaskId,
      @parentId, @depth, @isChecklistItem, @sourceListId, @sourceListName,
      @assignee, @microStatus, @statusReason, @metadata, @syncStatus, @lastSyncedAt,
      @pushRetryCount, @kanbanColumn, @kanbanOrder, @snoozedUntil, @reminderAt,
      @reminderRelative, @reminderDueTime, @effort, @isBulkImport
    )
    ON CONFLICT(source_id, connector_instance_id) DO NOTHING
  `).run({
    ...task,
    metadata: JSON.stringify(task.metadata),
    isChecklistItem: task.isChecklistItem ? 1 : 0,
    isBulkImport: task.isBulkImport ? 1 : 0,
  });
  return result.changes === 1;
}

function mapSourceList(row: Omit<SourceListRecord, 'hidden'> & { hidden: number }): SourceListRecord {
  return { ...row, hidden: row.hidden !== 0 };
}

const SOURCE_LIST_COLUMNS = `
  id,
  connector_instance_id AS connectorInstanceId,
  source_id AS sourceId,
  name,
  type,
  task_count AS taskCount,
  last_synced_at AS lastSyncedAt,
  well_known_list_name AS wellKnownListName,
  group_id AS groupId,
  sort_order AS sortOrder,
  hidden,
  last_known_remote_name AS lastKnownRemoteName,
  user_display_name AS userDisplayName,
  icon,
  icon_color AS iconColor
`;

function retentionRecord(
  database: SqliteDatabase,
  syncLogId: string,
  detailIndex: number,
): RetentionDetailRecord | null {
  const row = database.prepare(`
    SELECT connector_id AS connectorId, synced_at AS syncedAt, details
    FROM sync_log
    WHERE id = ?
  `).get(syncLogId) as { connectorId: string; syncedAt: string; details: unknown } | undefined;
  if (!row) return null;
  const detail = parseArray(row.details)[detailIndex];
  if (!detail || typeof detail !== 'object' || (detail as { action?: string }).action !== 'protected') {
    return null;
  }
  return {
    connectorId: row.connectorId,
    syncedAt: row.syncedAt,
    detail: detail as RetentionDetailRecord['detail'],
  };
}

function updateRetentionDetail(
  database: SqliteDatabase,
  syncLogId: string,
  detailIndex: number,
  mutation: (
    record: RetentionDetailRecord,
  ) => RetentionDetailRecord['detail']['resolution'] | undefined,
): { updated: boolean; record: RetentionDetailRecord | null } {
  return immediate(database, () => {
    const row = database.prepare(`
      SELECT connector_id AS connectorId, synced_at AS syncedAt, details
      FROM sync_log
      WHERE id = ?
    `).get(syncLogId) as { connectorId: string; syncedAt: string; details: unknown } | undefined;
    if (!row) return { updated: false, record: null };
    const details = parseArray(row.details);
    const detail = details[detailIndex];
    if (!detail || typeof detail !== 'object' || (detail as { action?: string }).action !== 'protected') {
      return { updated: false, record: null };
    }
    const record: RetentionDetailRecord = {
      connectorId: row.connectorId,
      syncedAt: row.syncedAt,
      detail: detail as RetentionDetailRecord['detail'],
    };
    const resolution = mutation(record);
    if (!resolution) return { updated: false, record };
    const nextDetail = { ...record.detail, resolution };
    details[detailIndex] = nextDetail;
    database.prepare('UPDATE sync_log SET details = ? WHERE id = ?')
      .run(JSON.stringify(details), syncLogId);
    return {
      updated: true,
      record: { ...record, detail: nextDetail },
    };
  });
}

export function createSqliteConnectorExecutionRepositories(
  database: SqliteDatabase,
  drizzle: SqliteDrizzle,
): ConnectorExecutionRepositories {
  return {
    lists: {
      async list(connectorId) {
        return (database.prepare(`
          SELECT ${SOURCE_LIST_COLUMNS}
          FROM source_lists
          WHERE connector_instance_id = ?
        `).all(connectorId) as Array<Omit<SourceListRecord, 'hidden'> & { hidden: number }>)
          .map(mapSourceList);
      },

      async applyDiscovery(command) {
        immediate(database, () => {
          const upsert = database.prepare(`
            INSERT INTO source_lists (
              id, connector_instance_id, source_id, name, type, task_count,
              last_synced_at, well_known_list_name, last_known_remote_name
            ) VALUES (
              @id, @connectorInstanceId, @sourceId, @name, @type, @taskCount,
              @lastSyncedAt, @wellKnownListName, @lastKnownRemoteName
            )
            ON CONFLICT(id) DO UPDATE SET
              source_id = excluded.source_id,
              name = excluded.name,
              type = excluded.type,
              task_count = excluded.task_count,
              last_synced_at = excluded.last_synced_at,
              well_known_list_name = excluded.well_known_list_name,
              last_known_remote_name = excluded.last_known_remote_name
          `);
          for (const record of command.upserts) {
            if (record.connectorInstanceId !== command.connectorId) {
              throw new Error(`Source list ${record.id} belongs to another connector`);
            }
            const existing = database.prepare(`
              SELECT connector_instance_id AS connectorInstanceId
              FROM source_lists
              WHERE id = ?
            `).get(record.id) as { connectorInstanceId: string } | undefined;
            if (existing && existing.connectorInstanceId !== command.connectorId) {
              throw new Error(`Source list ${record.id} belongs to another connector`);
            }
            upsert.run(record);
          }
          for (const stale of command.stale) {
            if (stale.action === 'mark-unobserved') {
              database.prepare(`
                UPDATE source_lists SET last_synced_at = NULL
                WHERE id = ? AND connector_instance_id = ?
              `).run(stale.id, command.connectorId);
            } else {
              database.prepare(`
                DELETE FROM source_lists WHERE id = ? AND connector_instance_id = ?
              `).run(stale.id, command.connectorId);
            }
          }
        });
      },

      async assignFolderGroups(input) {
        return immediate(database, () => {
          const existing = database.prepare(`
            SELECT id, name, source_id AS sourceId FROM list_groups
          `).all() as Array<{ id: string; name: string; sourceId: string | null }>;
          const bySource = new Map(existing.flatMap((row) => (
            row.sourceId ? [[row.sourceId, row.id] as const] : []
          )));
          const byName = new Map(existing.map((row) => [row.name, row.id]));
          let sortOrder = existing.length;
          for (const group of input.groups) {
            let id = bySource.get(group.sourceId);
            if (!id) {
              id = byName.get(group.name);
              if (id) {
                database.prepare(`
                  UPDATE list_groups SET source_id = COALESCE(source_id, ?) WHERE id = ?
                `).run(group.sourceId, id);
              } else {
                id = `lg-${randomUUID().slice(0, 8)}`;
                database.prepare(`
                  INSERT INTO list_groups (id, name, source_id, sort_order, created_at)
                  VALUES (?, ?, ?, ?, ?)
                `).run(id, group.name, group.sourceId, sortOrder++, input.now);
                byName.set(group.name, id);
              }
              bySource.set(group.sourceId, id);
            }
          }
          let assigned = 0;
          for (const list of input.lists) {
            const groupId = bySource.get(list.parentFolderGroupId);
            if (!groupId) continue;
            assigned += database.prepare(`
              UPDATE source_lists
              SET group_id = ?
              WHERE source_id = ? AND group_id IS NULL
            `).run(groupId, list.sourceId).changes;
          }
          return assigned;
        });
      },

      async removeLegacyProjectLists(connectorId) {
        immediate(database, () => {
          database.prepare(`
            DELETE FROM source_lists
            WHERE connector_instance_id = ? AND type = 'project'
          `).run(connectorId);
          database.prepare(`
            UPDATE tasks SET source_list_id = NULL, source_list_name = NULL
            WHERE connector_instance_id = ? AND source_list_id LIKE 'project:%'
          `).run(connectorId);
        });
      },
    },

    pushes: {
      async listCandidates(input) {
        const ids = input.taskIds ?? [];
        if (input.taskIds && ids.length === 0) return [];
        const statusTerms = input.includePushing
          ? `sync_status IN ('pending_push', 'push_error', 'pushing')`
          : `sync_status IN ('pending_push', 'push_error')`;
        const idClause = ids.length > 0
          ? `AND id IN (${ids.map(() => '?').join(', ')})`
          : '';
        return listTasks(
          database,
          `connector_instance_id = ?
            AND (
              ${statusTerms}
              OR source_id LIKE 'local:%'
              OR (
                is_checklist_item = 1
                AND source_id = id
                AND sync_status <> 'push_failed'
              )
            )
            ${idClause}`,
          [input.connectorId, ...ids],
        );
      },

      async listSourceIds(taskIds) {
        if (taskIds.length === 0) return [];
        return database.prepare(`
          SELECT id, source_id AS sourceId FROM tasks
          WHERE id IN (${taskIds.map(() => '?').join(', ')})
        `).all(...taskIds) as Array<{ id: string; sourceId: string }>;
      },

      async markSynced(taskId, now, updates = {}) {
        return updateTask(database, taskId, {
          ...updates,
          syncStatus: 'synced',
          lastSyncedAt: now,
        }) === 1;
      },

      async markFailure(taskId, status, retryCount) {
        return updateTask(database, taskId, {
          syncStatus: status,
          pushRetryCount: retryCount,
        }) === 1;
      },

      async claim(taskId, leaseToken, staleBefore) {
        return database.prepare(`
          UPDATE tasks
          SET sync_status = 'pushing', last_synced_at = ?
          WHERE id = ?
            AND (
              sync_status IN ('pending_push', 'push_error', 'pushing')
              OR source_id LIKE 'local:%'
              OR (
                is_checklist_item = 1
                AND source_id = id
                AND sync_status <> 'push_failed'
              )
            )
            AND (
              sync_status <> 'pushing'
              OR last_synced_at IS NULL
              OR last_synced_at < ?
            )
        `).run(leaseToken, taskId, staleBefore).changes === 1;
      },

      async loadClaimed(taskId, leaseToken) {
        const task = getTask(database, taskId);
        return task?.syncStatus === 'pushing' && task.lastSyncedAt === leaseToken ? task : null;
      },

      async heartbeat(taskId, leaseToken, renewedToken) {
        return database.prepare(`
          UPDATE tasks SET last_synced_at = ?
          WHERE id = ? AND sync_status = 'pushing' AND last_synced_at = ?
        `).run(renewedToken, taskId, leaseToken).changes === 1;
      },

      async release(input) {
        const versionClause = input.expectedTaskVersion === undefined ? '' : 'AND updated_at = ?';
        return database.prepare(`
          UPDATE tasks SET sync_status = ?, last_synced_at = ?
          WHERE id = ? AND sync_status = 'pushing' AND last_synced_at = ?
          ${versionClause}
        `).run(
          input.syncStatus,
          input.now,
          input.taskId,
          input.leaseToken,
          ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
        ).changes === 1;
      },

      async complete(input) {
        return immediate(database, () => {
          const values: ConnectorTaskUpdate = {
            sourceId: input.sourceId,
            syncStatus: 'synced',
            lastSyncedAt: input.now,
            ...(input.metadata ? { metadata: input.metadata } : {}),
            ...(input.localUpdates ?? {}),
          };
          const versionClause = input.expectedTaskVersion === undefined ? '' : 'AND updated_at = ?';
          const completed = updateTask(
            database,
            input.taskId,
            values,
            `AND sync_status = 'pushing' AND last_synced_at = ? ${versionClause}`,
            [
              input.leaseToken,
              ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
            ],
          );
          if (completed === 1 || input.createdFromSourceId === undefined) {
            return completed === 1;
          }

          const current = getTask(database, input.taskId);
          if (!current || current.sourceId !== input.createdFromSourceId) return false;
          const ownsLease = current.syncStatus === 'pushing'
            && current.lastSyncedAt === input.leaseToken;
          return updateTask(
            database,
            input.taskId,
            {
              sourceId: input.sourceId,
              ...(input.metadata
                ? { metadata: { ...current.metadata, ...input.metadata } }
                : {}),
              ...(ownsLease
                ? { syncStatus: 'pending_push', lastSyncedAt: input.now }
                : {}),
            },
            'AND source_id = ?',
            [input.createdFromSourceId],
          ) === 1;
        });
      },

      async fail(input) {
        const versionClause = input.expectedTaskVersion === undefined ? '' : 'AND updated_at = ?';
        return updateTask(
          database,
          input.taskId,
          {
            syncStatus: input.syncStatus,
            lastSyncedAt: input.now,
            ...(input.pushRetryCount === undefined
              ? {}
              : { pushRetryCount: input.pushRetryCount }),
          },
          `AND sync_status = 'pushing' AND last_synced_at = ? ${versionClause}`,
          [
            input.leaseToken,
            ...(input.expectedTaskVersion === undefined ? [] : [input.expectedTaskVersion]),
          ],
        ) === 1;
      },
    },

    pulls: {
      async loadSnapshot(connectorId, options = {}) {
        const taskRows = listTasks(database, 'connector_instance_id = ?', [connectorId]);
        const tags = database.prepare('SELECT id, slug, type FROM tags').all() as Array<{
          id: string;
          slug: string;
          type: string;
        }>;
        const archivedRecurringDuplicateSourceIds = options.includeArchivedRecurringDuplicates
          ? (database.prepare(`
              SELECT source_id AS sourceId
              FROM sync_deletion_snapshots
              WHERE connector_id = ?
                AND reason LIKE 'Duplicate open Microsoft To Do recurrence%'
            `).all(connectorId) as Array<{ sourceId: string }>).map((row) => row.sourceId)
          : [];
        const linkedSources = options.includeLinkedSources
          ? database.prepare(`
              SELECT
                linked.id,
                linked.task_id AS taskId,
                linked.source_id AS sourceId,
                entity.provider AS entityProvider,
                entity.host_key AS entityHostKey,
                entity.entity_type AS entityType,
                entity.stable_id AS entityStableId
              FROM task_linked_sources AS linked
              LEFT JOIN task_linked_source_entities AS association
                ON association.linked_source_id = linked.id
              LEFT JOIN external_entities AS entity
                ON entity.id = association.external_entity_id
              WHERE linked.connector_instance_id = ?
                AND linked.connector_type = 'github-issues'
            `).all(connectorId) as Array<{
              id: string;
              taskId: string;
              sourceId: string;
              entityProvider: string | null;
              entityHostKey: string | null;
              entityType: string | null;
              entityStableId: string | null;
            }>
          : [];
        return { tasks: taskRows, tags, archivedRecurringDuplicateSourceIds, linkedSources };
      },

      async updateLinkedSourceLocator(id, sourceId) {
        database.prepare('UPDATE task_linked_sources SET source_id = ? WHERE id = ?')
          .run(sourceId, id);
      },

      async updateTaskSourceId(taskId, sourceId) {
        return database.prepare('UPDATE tasks SET source_id = ? WHERE id = ?')
          .run(sourceId, taskId).changes === 1;
      },

      async adoptLocalTask(input) {
        return immediate(database, () => {
          const adopted = database.prepare(`
            UPDATE tasks
            SET source_id = ?,
                sync_status = ?,
                last_synced_at = ?
            WHERE id = ? AND connector_instance_id = ? AND source_id LIKE 'local:%'
          `).run(
            input.remoteSourceId,
            input.hasLocalEdits ? 'pending_push' : 'synced',
            input.now,
            input.taskId,
            input.connectorId,
          );
          return adopted.changes === 1
            ? getTask(database, input.taskId)
            : listTasks(
              database,
              'connector_instance_id = ? AND source_id = ?',
              [input.connectorId, input.remoteSourceId],
            )[0]
              ?? null;
        });
      },

      async insertBatch(candidates) {
        return immediate(database, () => {
          const insertedIds = new Set<string>();
          for (const candidate of candidates) {
            if (insertTask(database, candidate.task)) {
              insertedIds.add(candidate.task.id);
              replaceSourceTags(database, candidate.task.id, candidate.tags);
            }
          }
          const records = candidates.flatMap((candidate) => {
            const task = listTasks(
              database,
              'connector_instance_id = ? AND source_id = ?',
              [candidate.task.connectorInstanceId, candidate.task.sourceId],
            )[0];
            return task ? [task] : [];
          });
          return { insertedIds, records };
        });
      },

      async findBySourceIds(connectorId, sourceIds) {
        if (sourceIds.length === 0) return [];
        return listTasks(
          database,
          `connector_instance_id = ? AND source_id IN (${sourceIds.map(() => '?').join(', ')})`,
          [connectorId, ...sourceIds],
        );
      },

      async applyRemoteUpdate(input) {
        return immediate(database, () => {
          const changed = updateTask(
            database,
            input.taskId,
            input.values,
            'AND sync_status = ?',
            [input.expectedSyncStatus],
          );
          if (changed !== 1) return false;
          if (input.sourceTags) {
            replaceSourceTags(database, input.taskId, input.sourceTags);
          }
          return true;
        });
      },

      async replaceSourceTags(taskId, tags) {
        immediate(database, () => replaceSourceTags(database, taskId, tags));
      },

      async listChecklistItems(connectorId) {
        return database.prepare(`
          SELECT id, source_id AS sourceId, parent_id AS parentId
          FROM tasks
          WHERE connector_instance_id = ? AND is_checklist_item = 1
        `).all(connectorId) as Array<{ id: string; sourceId: string; parentId: string | null }>;
      },

      async correctParents(corrections) {
        immediate(database, () => {
          const update = database.prepare('UPDATE tasks SET parent_id = ? WHERE id = ?');
          for (const correction of corrections) {
            update.run(correction.parentId, correction.taskId);
          }
        });
      },

      async listChildren(taskId) {
        return (database.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(taskId) as Array<{
          id: string;
        }>).map((row) => row.id);
      },

      async listTasks(connectorId) {
        return listTasks(database, 'connector_instance_id = ?', [connectorId]);
      },

      async listStaleInProgress(connectorId) {
        return database.prepare(`
          SELECT id, source_id AS sourceId, status, completed_at AS completedAt
          FROM tasks
          WHERE connector_instance_id = ? AND status = 'in_progress'
        `).all(connectorId) as Array<{
          id: string;
          sourceId: string;
          status: string;
          completedAt: string | null;
        }>;
      },

      async applyVerifiedTerminalStatus(input) {
        return database.prepare(`
          UPDATE tasks
          SET status = ?,
              completed_at = ?,
              sync_status = 'synced',
              last_synced_at = ?
          WHERE id = ? AND status = ?
        `).run(
          input.status,
          input.completedAt,
          input.now,
          input.taskId,
          input.expectedStatus,
        ).changes === 1;
      },
    },

    deletions: {
      async listCandidates(connectorId) {
        return database.prepare(`
          SELECT
            id,
            connector_id AS connectorId,
            task_id AS taskId,
            source_id AS sourceId,
            first_missing_at AS firstMissingAt,
            last_missing_at AS lastMissingAt,
            missing_count AS missingCount,
            identity_mode AS identityMode,
            identity_mode_revision AS identityModeRevision,
            issue_entity_id AS issueEntityId,
            repository_entity_id AS repositoryEntityId,
            host_key AS hostKey,
            locator_revision AS locatorRevision,
            binding_state AS bindingState,
            binding_revision AS bindingRevision
          FROM sync_deletion_candidates
          WHERE connector_id = ?
        `).all(connectorId) as DeletionCandidateRecord[];
      },

      async listIdentityStates(connectorId) {
        return database.prepare(`
          SELECT
            task.id AS localId,
            binding.external_entity_id AS externalEntityId,
            entity.stable_id AS stableId,
            binding.state AS bindingState,
            backfill.state AS backfillState,
            locator.locator_revision AS locatorRevision,
            locator.repository_entity_id AS repositoryEntityId,
            entity.host_key AS hostKey,
            binding.verified_at AS bindingRevision
          FROM tasks AS task
          LEFT JOIN external_entity_bindings AS binding
            ON binding.connector_instance_id = task.connector_instance_id
            AND binding.binding_type = 'task'
            AND binding.local_id = task.id
            AND binding.state <> 'retired'
          LEFT JOIN external_entities AS entity
            ON entity.id = binding.external_entity_id
          LEFT JOIN external_entity_locators AS locator
            ON locator.external_entity_id = entity.id
            AND locator.valid_to IS NULL
          LEFT JOIN github_identity_backfill_items AS backfill
            ON backfill.connector_instance_id = task.connector_instance_id
            AND backfill.binding_type = 'task'
            AND backfill.local_id = task.id
          WHERE task.connector_instance_id = ?
        `).all(connectorId) as DeletionIdentityState[];
      },

      async clearCandidate(connectorId, sourceId) {
        database.prepare(`
          DELETE FROM sync_deletion_candidates
          WHERE connector_id = ? AND source_id = ?
        `).run(connectorId, sourceId);
      },

      async markPendingPush(taskId) {
        return database.prepare(`
          UPDATE tasks SET sync_status = 'pending_push' WHERE id = ?
        `).run(taskId).changes === 1;
      },

      async observeMissing(input) {
        return immediate(database, () => {
          const existing = input.expectedCandidateId
            ? database.prepare(`
                SELECT
                  id,
                  identity_mode AS identityMode,
                  identity_mode_revision AS identityModeRevision,
                  issue_entity_id AS issueEntityId,
                  repository_entity_id AS repositoryEntityId,
                  host_key AS hostKey,
                  locator_revision AS locatorRevision,
                  binding_state AS bindingState,
                  binding_revision AS bindingRevision
                FROM sync_deletion_candidates
                WHERE id = ? AND connector_id = ? AND source_id = ?
              `).get(
                input.expectedCandidateId,
                input.connectorId,
                input.sourceId,
              ) as (Pick<DeletionCandidateRecord, 'id' | 'identityMode' | 'identityModeRevision'
                | 'issueEntityId' | 'repositoryEntityId' | 'hostKey' | 'locatorRevision'
                | 'bindingState' | 'bindingRevision'> | undefined)
            : undefined;
          if (!input.expectedCandidateId || !existing) {
            database.prepare(`
              INSERT INTO sync_deletion_candidates (
                id, connector_id, task_id, source_id, first_missing_at,
                last_missing_at, missing_count, identity_mode,
                identity_mode_revision, issue_entity_id, repository_entity_id,
                host_key, locator_revision, binding_state, binding_revision
              ) VALUES (
                ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?
              )
              ON CONFLICT(connector_id, source_id) DO UPDATE SET
                task_id = excluded.task_id,
                last_missing_at = excluded.last_missing_at,
                missing_count = 1,
                identity_mode = excluded.identity_mode,
                identity_mode_revision = excluded.identity_mode_revision,
                issue_entity_id = excluded.issue_entity_id,
                repository_entity_id = excluded.repository_entity_id,
                host_key = excluded.host_key,
                locator_revision = excluded.locator_revision,
                binding_state = excluded.binding_state,
                binding_revision = excluded.binding_revision
            `).run(
              randomUUID(),
              input.connectorId,
              input.taskId,
              input.sourceId,
              input.now,
              input.now,
              input.expectedFence.identityMode,
              input.expectedFence.identityModeRevision,
              input.expectedFence.issueEntityId,
              input.expectedFence.repositoryEntityId,
              input.expectedFence.hostKey,
              input.expectedFence.locatorRevision,
              input.expectedFence.bindingState,
              input.expectedFence.bindingRevision,
            );
            return 'quarantined';
          }
          const fenceKeys = [
            'identityMode',
            'identityModeRevision',
            'issueEntityId',
            'repositoryEntityId',
            'hostKey',
            'locatorRevision',
            'bindingState',
            'bindingRevision',
          ] as const;
          if (fenceKeys.some((key) => existing[key] !== input.expectedFence[key])) {
            database.prepare('DELETE FROM sync_deletion_candidates WHERE id = ?')
              .run(existing.id);
            return 'fence-reset';
          }
          database.prepare(`
            UPDATE sync_deletion_candidates
            SET last_missing_at = ?, missing_count = missing_count + 1
            WHERE id = ?
          `).run(input.now, existing.id);
          return 'ready';
        });
      },

      archiveAndDeleteTask: (taskId, reason, expectedFence) => (
        archiveAndDeleteTaskSqlite(taskId, reason, expectedFence)
      ),

      restoreDeletionSnapshot: (snapshotId, mode, preflight) => (
        restoreDeletionSnapshotSqlite(snapshotId, mode, preflight)
      ),
    },

    notifications: {
      async ingest(commands: readonly ConnectorNotificationCommand[]) {
        if (commands.length === 0) return [];
        const results = drizzle.transaction((transaction) => {
          return commands.map((command) => {
            const existing = database.prepare(`
            SELECT primary_action_id AS primaryActionId
            FROM notifications
            WHERE source_id = ?
            `).get(command.input.sourceId) as { primaryActionId: string | null } | undefined;
            const [result] = createNotificationsInTransaction(
            transaction,
            [{
            ...command.input,
            primaryActionId: existing
              ? existing.primaryActionId
              : command.input.primaryActionId,
            } as CreateNotificationInput],
            );
            if (result.created && command.actions.length > 0) {
            transaction.insert(notificationActions)
              .values(command.actions.map((action) => ({
                ...action,
                icon: action.icon ?? null,
              })))
              .run();
            }
            return result;
          });
        }, { behavior: 'immediate' });
        return results.map((result) => ({
          id: result.notification.id,
          created: result.created,
          pendingDelivery: result.deliveryEvents.some((event) => event.status === 'pending'),
        }));
      },

      async listActive(connectorId) {
        return database.prepare(`
          SELECT
            id,
            source_id AS sourceId,
            reconcile_attempts AS reconcileAttempts,
            stale_since AS staleSince
          FROM notifications
          WHERE connector_instance_id = ?
            AND source_state IN ('active', 'unknown')
            AND (template_key IS NULL OR template_key <> 'workflow_result')
        `).all(connectorId) as Array<{
          id: string;
          sourceId: string;
          reconcileAttempts: number;
          staleSince: string | null;
        }>;
      },

      async applyReconciliation(input) {
        return immediate(database, () => {
          let resolved = 0;
          for (const outcome of input.outcomes) {
            if (outcome.resolved) {
              resolved += database.prepare(`
                UPDATE notifications
                SET state = CASE
                      WHEN disposition = 'dismissed' THEN 'dismissed'
                      ELSE 'resolved'
                    END,
                    source_state = 'resolved',
                    resolved_at = ?,
                    source_resolved_at = ?,
                    last_reconciled_at = ?,
                    reconcile_attempts = 0,
                    stale_since = NULL,
                    auto_resolve_reason = ?
                WHERE id = ?
              `).run(
                outcome.resolvedAt ?? input.now,
                outcome.resolvedAt ?? input.now,
                input.now,
                outcome.reason ?? 'handled_upstream',
                outcome.notificationId,
              ).changes;
            } else {
              database.prepare(`
                UPDATE notifications
                SET last_reconciled_at = ?, reconcile_attempts = 0, stale_since = NULL
                WHERE id = ?
              `).run(input.now, outcome.notificationId);
            }
          }
          return resolved;
        });
      },

      async recordReconciliationFailure(input) {
        immediate(database, () => {
          const update = database.prepare(`
            UPDATE notifications
            SET reconcile_attempts = reconcile_attempts + 1,
                stale_since = COALESCE(stale_since, ?)
            WHERE id = ?
          `);
          for (const id of input.notificationIds) update.run(input.now, id);
        });
      },

      async archiveStale(input) {
        return database.prepare(`
          UPDATE notifications
          SET state = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                ELSE 'archived'
              END,
              disposition = CASE
                WHEN disposition = 'dismissed' THEN 'dismissed'
                ELSE 'handled'
              END,
              source_state = 'unknown',
              handled_at = CASE
                WHEN disposition = 'dismissed' THEN handled_at
                ELSE ?
              END,
              handled_source_activity_at = CASE
                WHEN disposition = 'dismissed' THEN handled_source_activity_at
                ELSE last_source_activity_at
              END,
              handled_source_activity_key = CASE
                WHEN disposition = 'dismissed' THEN handled_source_activity_key
                ELSE last_source_activity_key
              END,
              archived_at = CASE
                WHEN disposition = 'dismissed' THEN archived_at
                ELSE ?
              END,
              auto_resolve_reason = 'stale_unverifiable'
          WHERE connector_instance_id = ?
            AND source_state IN ('active', 'unknown')
            AND (template_key IS NULL OR template_key <> 'workflow_result')
            AND stale_since IS NOT NULL
            AND stale_since < ?
            AND reconcile_attempts >= ?
        `).run(
          input.now,
          input.now,
          input.connectorId,
          input.cutoff,
          input.minimumAttempts,
        ).changes;
      },

      async mergeMetadata(notificationId, metadata) {
        return immediate(database, () => {
          const row = database.prepare('SELECT metadata FROM notifications WHERE id = ?')
            .get(notificationId) as { metadata: unknown } | undefined;
          if (!row) return false;
          database.prepare('UPDATE notifications SET metadata = ? WHERE id = ?')
            .run(JSON.stringify({ ...parseObject(row.metadata), ...metadata }), notificationId);
          return true;
        });
      },
    },

    conflicts: {
      async applyResolution(command) {
        immediate(database, () => {
          updateTask(database, command.taskId, {
            ...command.winningVersion,
            updatedAt: command.resolvedAt,
            syncStatus: 'synced',
            lastSyncedAt: command.resolvedAt,
          });
          database.prepare(`
            INSERT INTO sync_log (
              id, connector_id, success, tasks_added, tasks_updated, tasks_removed,
              tasks_pushed, local_only_protected, alerts_added, errors, details,
              synced_at
            ) VALUES (?, ?, 1, 0, 1, 0, 0, 0, 0, ?, '[]', ?)
          `).run(
            randomUUID(),
            command.connectorId,
            JSON.stringify([{
              type: 'conflict_resolved',
              taskId: command.taskId,
              resolution: command.resolution,
              localUpdatedAt: command.localUpdatedAt,
              remoteUpdatedAt: command.remoteUpdatedAt,
            }]),
            command.resolvedAt,
          );
        });
      },

      async listUnresolved() {
        return listTasks(database, `sync_status = 'conflict'`, []);
      },
    },

    retention: {
      async getDetail(syncLogId, detailIndex) {
        return retentionRecord(database, syncLogId, detailIndex);
      },

      async claim(input) {
        let recoveringStaleClaim = false;
        const outcome = updateRetentionDetail(
          database,
          input.syncLogId,
          input.detailIndex,
          (record) => {
            const current = record.detail.resolution;
            if (current?.status === 'succeeded') return undefined;
            if (current?.status === 'indeterminate' && input.action === 'retry_push') {
              return undefined;
            }
            if (current?.status === 'in_progress') {
              const expiresAt = current.leaseExpiresAt
                ?? new Date(Date.parse(current.resolvedAt) + 5 * 60_000).toISOString();
              if (Date.parse(expiresAt) > Date.parse(input.now)) return undefined;
              recoveringStaleClaim = true;
            }
            return {
              action: input.action,
              status: 'in_progress',
              resolvedAt: input.now,
              message: 'Resolution is in progress.',
              claimId: input.claimId,
              leaseExpiresAt: input.leaseExpiresAt,
            };
          },
        );
        if (!outcome.record) return { status: 'not-found' as const };
        if (!outcome.updated) {
          return { status: 'unchanged' as const, record: outcome.record };
        }
        return {
          status: 'claimed' as const,
          record: outcome.record,
          recoveringStaleClaim,
        };
      },

      async renew(input) {
        return updateRetentionDetail(
          database,
          input.syncLogId,
          input.detailIndex,
          (record) => (
            record.detail.resolution?.status === 'in_progress'
              && record.detail.resolution.claimId === input.claimId
              ? {
                  ...record.detail.resolution,
                  leaseExpiresAt: input.leaseExpiresAt,
                }
              : undefined
          ),
        ).updated;
      },

      async finalize(input) {
        return updateRetentionDetail(
          database,
          input.syncLogId,
          input.detailIndex,
          (record) => (
            record.detail.resolution?.status === 'in_progress'
              && record.detail.resolution.claimId === input.claimId
              ? input.resolution
              : undefined
          ),
        ).updated;
      },

      async findTask(input) {
        if (input.taskId) {
          const byId = getTask(database, input.taskId);
          if (
            byId?.connectorInstanceId === input.connectorId
            && byId.sourceId === input.taskSourceId
          ) return byId;
        }
        return listTasks(
          database,
          'connector_instance_id = ? AND source_id = ?',
          [input.connectorId, input.taskSourceId],
        )[0] ?? null;
      },

      async getTask(taskId) {
        return getTask(database, taskId);
      },

      async convertTaskTreeToLocal(taskId, archive) {
        convertTaskTreeToLocal(database, taskId, archive);
      },

      async deleteTaskTree(taskId) {
        deleteTaskTree(database, taskId);
      },
    },

    support: {
      allowsLegacyWorkflow() {
        return true;
      },
      assertConfigSupported() {},
      assertConnectorSupported() {},

      async listEnabledConnectorIds() {
        return (database.prepare(`
          SELECT id FROM connector_configs WHERE enabled = 1 AND deleted_at IS NULL
        `).all() as Array<{ id: string }>).map((row) => row.id);
      },

      async listEnabledGitHubConfigs() {
        return (database.prepare(`
          SELECT id, type, capabilities
          FROM connector_configs
          WHERE enabled = 1 AND deleted_at IS NULL AND type = 'github-issues'
        `).all() as Array<{ id: string; type: string; capabilities: unknown }>).map((row) => ({
          id: row.id,
          type: row.type,
          capabilities: parseObject(row.capabilities) as unknown as ConnectorConfig['capabilities'],
        }));
      },

      async listConnectorTaskIdentities(connectorId) {
        return database.prepare(`
          SELECT id, source_id AS sourceId FROM tasks WHERE connector_instance_id = ?
        `).all(connectorId) as Array<{ id: string; sourceId: string }>;
      },

      async listConnectorTaskIds(connectorId, sourceIds) {
        const rows = database.prepare(`
          SELECT id, source_id AS sourceId FROM tasks WHERE connector_instance_id = ?
        `).all(connectorId) as Array<{ id: string; sourceId: string }>;
        return rows.filter((row) => !sourceIds || sourceIds.has(row.sourceId))
          .map((row) => row.id);
      },
    },
  };
}
