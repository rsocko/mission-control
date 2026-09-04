import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import { createNewGitHubConnectorIdentityState } from '@/lib/external-identities/service';
import type {
  ConnectorManagementPersistence,
  ManagedConnectorRecord,
  ManagedConnectorUpdate,
  SourceRankingRecord,
  SyncHistoryRecord,
} from './connector-management';
import type { SourceListRecord } from './connector-execution';
import { decodeLenientJsonArray, decodeLenientJsonObject } from './value-codecs';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

interface SqliteConnectorRow extends Omit<
  ManagedConnectorRecord,
  'enabled' | 'capabilities' | 'credentials' | 'settings' | 'syncedLists'
> {
  enabled: number;
  capabilities: unknown;
  credentials: unknown;
  settings: unknown;
  syncedLists: unknown;
}

interface SqliteSourceListRow extends Omit<SourceListRecord, 'hidden'> {
  hidden: number;
}

interface SqliteSyncHistoryRow extends Omit<
  SyncHistoryRecord,
  'success' | 'errors' | 'details'
> {
  success: number;
  errors: unknown;
  details: unknown;
}

const CONNECTOR_COLUMNS = `
  id,
  type,
  name,
  enabled,
  sync_mode AS syncMode,
  poll_interval_minutes AS pollIntervalMinutes,
  capabilities,
  credentials,
  settings,
  synced_lists AS syncedLists,
  created_at AS createdAt,
  updated_at AS updatedAt,
  deleted_at AS deletedAt,
  last_test_status AS lastTestStatus,
  last_test_error AS lastTestError,
  last_test_at AS lastTestAt
`;

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

const SYNC_HISTORY_COLUMNS = `
  id,
  connector_id AS connectorId,
  success,
  tasks_added AS tasksAdded,
  tasks_updated AS tasksUpdated,
  tasks_removed AS tasksRemoved,
  tasks_pushed AS tasksPushed,
  local_only_protected AS localOnlyProtected,
  alerts_added AS notificationsAdded,
  errors,
  details,
  synced_at AS syncedAt,
  duration_ms AS durationMs,
  job_id AS jobId,
  trigger,
  scheduled_for AS scheduledFor,
  started_at AS startedAt,
  attempt,
  max_attempts AS maxAttempts,
  identity_mode AS identityMode,
  identity_mode_revision AS identityModeRevision
`;

function mapConnector(row: SqliteConnectorRow): ManagedConnectorRecord {
  return {
    ...row,
    enabled: row.enabled !== 0,
    capabilities: decodeLenientJsonObject(row.capabilities),
    credentials: decodeLenientJsonObject(row.credentials),
    settings: decodeLenientJsonObject(row.settings),
    syncedLists: decodeLenientJsonArray(row.syncedLists)
      .filter((entry): entry is string => typeof entry === 'string'),
  };
}

function mapSourceList(row: SqliteSourceListRow): SourceListRecord {
  return { ...row, hidden: row.hidden !== 0 };
}

function mapSyncHistory(row: SqliteSyncHistoryRow): SyncHistoryRecord {
  return {
    ...row,
    success: row.success !== 0,
    errors: decodeLenientJsonArray(row.errors),
    details: decodeLenientJsonArray(row.details),
  };
}

function connectorUpdateParts(
  updates: ManagedConnectorUpdate,
): { assignments: string[]; values: unknown[] } {
  const assignments: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (updates.name !== undefined) add('name', updates.name);
  if (updates.enabled !== undefined) add('enabled', updates.enabled ? 1 : 0);
  if (updates.syncMode !== undefined) add('sync_mode', updates.syncMode);
  if (updates.pollIntervalMinutes !== undefined) {
    add('poll_interval_minutes', updates.pollIntervalMinutes);
  }
  if (updates.capabilities !== undefined) add('capabilities', JSON.stringify(updates.capabilities));
  if (updates.credentials !== undefined) add('credentials', JSON.stringify(updates.credentials));
  if (updates.settings !== undefined) add('settings', JSON.stringify(updates.settings));
  if (updates.syncedLists !== undefined) add('synced_lists', JSON.stringify(updates.syncedLists));
  return { assignments, values };
}

export function createSqliteConnectorManagementRepository(
  database: SqliteDatabase,
  drizzle: SqliteDrizzle,
): ConnectorManagementPersistence {
  return {
    async getOverview(includeDeleted) {
      const connectors = (database.prepare(`
        SELECT ${CONNECTOR_COLUMNS}
        FROM connector_configs
        ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
        ORDER BY created_at ASC, id ASC
      `).all() as SqliteConnectorRow[]).map(mapConnector);
      const sourceLists = (database.prepare(`
        SELECT ${SOURCE_LIST_COLUMNS}
        FROM source_lists
        ORDER BY sort_order ASC, id ASC
      `).all() as SqliteSourceListRow[]).map(mapSourceList);
      const openTaskCounts = database.prepare(`
        SELECT
          connector_instance_id AS connectorInstanceId,
          source_list_id AS sourceListId,
          count(*) AS count
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled')
          AND parent_id IS NULL
          AND is_checklist_item = 0
        GROUP BY connector_instance_id, source_list_id
      `).all() as ConnectorOverviewResult['openTaskCounts'];
      const syncRows = database.prepare(`
        WITH ranked AS (
          SELECT
            connector_id AS connectorId,
            synced_at AS syncedAt,
            success,
            errors,
            row_number() OVER (
              PARTITION BY connector_id
              ORDER BY synced_at DESC, id DESC
            ) AS rn,
            max(CASE WHEN success = 1 THEN synced_at END)
              OVER (PARTITION BY connector_id) AS lastSyncedAt
          FROM sync_log
        )
        SELECT connectorId, lastSyncedAt, success, errors
        FROM ranked
        WHERE rn = 1
      `).all() as Array<{
        connectorId: string;
        lastSyncedAt: string | null;
        success: number;
        errors: unknown;
      }>;
      return {
        connectors,
        sourceLists,
        openTaskCounts,
        syncOutcomes: syncRows.map((row) => {
          const errors = decodeLenientJsonArray(row.errors);
          return {
            connectorId: row.connectorId,
            lastSyncedAt: row.lastSyncedAt,
            success: row.success !== 0,
            error: errors.length > 0 ? String(errors[0]) : null,
          };
        }),
      };
    },

    async projectExists(projectId) {
      return database.prepare('SELECT 1 FROM hub_projects WHERE id = ? LIMIT 1')
        .get(projectId) !== undefined;
    },

    async createConnector(input) {
      let created = false;
      drizzle.transaction((tx) => {
        const inserted = tx.insert(schema.connectorConfigs).values({
          id: input.id,
          type: input.type,
          name: input.name,
          enabled: input.enabled,
          syncMode: input.syncMode,
          pollIntervalMinutes: input.pollIntervalMinutes,
          capabilities: input.capabilities,
          credentials: input.credentials,
          settings: input.settings,
          syncedLists: input.syncedLists,
          createdAt: input.now,
          updatedAt: input.now,
        }).onConflictDoNothing().returning({ id: schema.connectorConfigs.id }).get();
        created = inserted !== undefined;
        if (created && input.type === 'github-issues') {
          createNewGitHubConnectorIdentityState(tx, input.id, input.now);
        }
      }, { behavior: 'immediate' });
      return created;
    },

    async ensureSourceLists(lists) {
      if (lists.length === 0) return;
      database.transaction(() => {
        const insert = database.prepare(`
          INSERT INTO source_lists (
            id, connector_instance_id, source_id, name, type, task_count,
            last_synced_at, sort_order, hidden, icon, icon_color
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING
        `);
        for (const list of lists) {
          insert.run(
            list.id,
            list.connectorInstanceId,
            list.sourceId,
            list.name,
            list.type,
            list.taskCount,
            list.lastSyncedAt,
            list.sortOrder,
            list.hidden ? 1 : 0,
            list.icon,
            list.iconColor,
          );
        }
      }).immediate();
    },

    async ensureWorkTodoBridge(input) {
      database.prepare(`
        INSERT INTO work_todo_bridge_state (
          connector_id, transport, capability_profile, reset_required, created_at, updated_at
        ) VALUES (?, ?, ?, 0, ?, ?)
        ON CONFLICT(connector_id) DO NOTHING
      `).run(
        input.connectorId,
        input.transport,
        input.capabilityProfile,
        input.now,
        input.now,
      );
    },

    async getConnector(connectorId) {
      const row = database.prepare(`
        SELECT ${CONNECTOR_COLUMNS} FROM connector_configs WHERE id = ? LIMIT 1
      `).get(connectorId) as SqliteConnectorRow | undefined;
      return row ? mapConnector(row) : null;
    },

    async updateConnector(input) {
      const { assignments, values } = connectorUpdateParts(input.updates);
      assignments.push('updated_at = ?');
      values.push(input.now);
      let predicate = 'id = ?';
      values.push(input.connectorId);
      if (input.expected) {
        predicate += ' AND updated_at = ? AND settings = ?';
        values.push(input.expected.updatedAt, JSON.stringify(input.expected.settings));
      }
      return database.prepare(`
        UPDATE connector_configs SET ${assignments.join(', ')} WHERE ${predicate}
      `).run(...values).changes === 1;
    },

    async updateWorkTodoConnector(input) {
      return database.transaction(() => {
        const bridge = database.prepare(`
          SELECT transport, capability_profile AS capabilityProfile, last_ingest_at AS lastIngestAt
          FROM work_todo_bridge_state WHERE connector_id = ?
        `).get(input.connectorId) as {
          transport: string;
          capabilityProfile: string;
          lastIngestAt: string | null;
        } | undefined;
        if (
          bridge?.lastIngestAt
          && (
            bridge.transport !== input.transport
            || bridge.capabilityProfile !== input.capabilityProfile
          )
        ) return 'tier-conflict' as const;
        const { assignments, values } = connectorUpdateParts(input.updates);
        assignments.push('updated_at = ?');
        values.push(input.now, input.connectorId);
        database.prepare(`
          UPDATE connector_configs SET ${assignments.join(', ')} WHERE id = ?
        `).run(...values);
        database.prepare(`
          UPDATE work_todo_bridge_state
          SET transport = ?, capability_profile = ?, updated_at = ?
          WHERE connector_id = ?
        `).run(input.transport, input.capabilityProfile, input.now, input.connectorId);
        return 'updated' as const;
      }).immediate();
    },

    async softDeleteConnector(connectorId, now) {
      return database.transaction(() => {
        database.prepare(`
          UPDATE connector_configs
          SET deleted_at = ?, enabled = 0, updated_at = ?
          WHERE id = ?
        `).run(now, now, connectorId);
        const taskRow = database.prepare(`
          SELECT count(*) AS count FROM tasks WHERE connector_instance_id = ?
        `).get(connectorId) as { count: number };
        const listRow = database.prepare(`
          SELECT count(*) AS count FROM source_lists WHERE connector_instance_id = ?
        `).get(connectorId) as { count: number };
        return { affectedTasks: taskRow.count, affectedLists: listRow.count };
      }).immediate();
    },

    async hardDeleteConnector(connectorId) {
      database.transaction(() => {
        const taskSubquery = 'SELECT id FROM tasks WHERE connector_instance_id = ?';
        for (const [table, column] of [
          ['task_tags', 'task_id'],
          ['project_auto_include_exclusions', 'task_id'],
          ['task_projects', 'task_id'],
          ['task_schedules', 'task_id'],
          ['my_day_items', 'task_id'],
          ['focus_items', 'task_id'],
          ['project_phase_items', 'task_id'],
        ] as const) {
          database.prepare(
            `DELETE FROM ${table} WHERE ${column} IN (${taskSubquery})`,
          ).run(connectorId);
        }
        for (const [table, column] of [
          ['sync_log', 'connector_id'],
          ['work_todo_outbound_changes', 'connector_id'],
          ['work_todo_list_delta_state', 'connector_id'],
          ['work_todo_bridge_state', 'connector_id'],
          ['source_lists', 'connector_instance_id'],
          ['notification_push_rules', 'connector_instance_id'],
          ['finance_attribution_audit', 'connector_id'],
          ['finance_attribution_exceptions', 'connector_id'],
          ['finance_attribution_subjects', 'connector_id'],
          ['finance_mutation_audit', 'connector_id'],
          ['finance_budget_snapshots', 'connector_id'],
          ['finance_recurring_obligations', 'connector_id'],
          ['finance_tags', 'connector_id'],
          ['finance_categories', 'connector_id'],
          ['finance_category_groups', 'connector_id'],
          ['finance_accounts', 'connector_id'],
          ['finance_dataset_sync_state', 'connector_id'],
          ['finance_insight_occurrence_cache_state', 'connector_id'],
          ['finance_insight_occurrences', 'connector_id'],
          ['finance_insight_publications', 'connector_id'],
          ['finance_insight_publication_state', 'connector_id'],
          ['finance_insight_transaction_projection_facts', 'connector_id'],
          ['finance_insight_transaction_projection_windows', 'connector_id'],
          ['finance_insight_transaction_projection_state', 'connector_id'],
          ['finance_insight_transaction_window_proofs', 'connector_id'],
          ['finance_insight_transaction_backfill_plans', 'connector_id'],
          ['finance_insight_cutovers', 'connector_id'],
          ['finance_sync_state', 'connector_id'],
          ['finance_transactions', 'connector_instance_id'],
          ['tasks', 'connector_instance_id'],
          ['connector_configs', 'id'],
        ] as const) {
          if (table === 'finance_insight_publications') {
            database.prepare(`
              DELETE FROM finance_insight_publication_facts
              WHERE publication_id IN (
                SELECT id FROM finance_insight_publications WHERE connector_id = ?
              )
            `).run(connectorId);
          }
          database.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(connectorId);
        }
      }).immediate();
    },

    async getSourceList(sourceListId) {
      const row = database.prepare(`
        SELECT ${SOURCE_LIST_COLUMNS} FROM source_lists WHERE id = ? LIMIT 1
      `).get(sourceListId) as SqliteSourceListRow | undefined;
      return row ? mapSourceList(row) : null;
    },

    async listGroupExists(groupId) {
      return database.prepare('SELECT 1 FROM list_groups WHERE id = ? LIMIT 1')
        .get(groupId) !== undefined;
    },

    async patchSourceList(input) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (input.groupId !== undefined) {
        assignments.push('group_id = ?');
        values.push(input.groupId);
      }
      if (input.hidden !== undefined) {
        assignments.push('hidden = ?');
        values.push(input.hidden ? 1 : 0);
      }
      if (assignments.length === 0) return;
      values.push(input.sourceListId);
      database.prepare(`
        UPDATE source_lists SET ${assignments.join(', ')} WHERE id = ?
      `).run(...values);
    },

    async applyLocalSourceListRename(input) {
      database.transaction(() => {
        const assignments = ['user_display_name = ?'];
        const values: unknown[] = [input.name];
        if (input.icon !== undefined) {
          assignments.push('icon = ?');
          values.push(input.icon);
        }
        if (input.iconColor !== undefined) {
          assignments.push('icon_color = ?');
          values.push(input.iconColor);
        }
        values.push(input.sourceListId);
        database.prepare(`
          UPDATE source_lists SET ${assignments.join(', ')} WHERE id = ?
        `).run(...values);
        database.prepare(`
          UPDATE tasks
          SET source_list_name = ?
          WHERE source_list_id = (
            SELECT source_id FROM source_lists WHERE id = ?
          )
            AND connector_instance_id = (
              SELECT connector_instance_id FROM source_lists WHERE id = ?
            )
        `).run(input.name, input.sourceListId, input.sourceListId);
      }).immediate();
    },

    async confirmRemoteSourceListRename(sourceListId, name) {
      database.prepare(`
        UPDATE source_lists SET name = ?, last_known_remote_name = ? WHERE id = ?
      `).run(name, name, sourceListId);
    },

    async reorderSourceLists(orderedIds) {
      database.transaction(() => {
        const update = database.prepare('UPDATE source_lists SET sort_order = ? WHERE id = ?');
        orderedIds.forEach((id, index) => update.run(index, id));
      }).immediate();
    },

    async listSourceRankings() {
      return database.prepare(`
        SELECT id, connector_type AS connectorType, name, rank, updated_at AS updatedAt
        FROM source_rankings ORDER BY rank ASC, id ASC
      `).all() as SourceRankingRecord[];
    },

    async putSourceRankings(rankings, now) {
      database.transaction(() => {
        const existing = database.prepare(
          'SELECT name FROM source_rankings WHERE id = ? LIMIT 1',
        );
        const update = database.prepare(`
          UPDATE source_rankings SET rank = ?, name = ?, updated_at = ? WHERE id = ?
        `);
        const insert = database.prepare(`
          INSERT INTO source_rankings (id, connector_type, name, rank, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        for (const ranking of rankings) {
          const row = existing.get(ranking.id) as { name: string } | undefined;
          if (row) {
            update.run(ranking.rank, ranking.name || row.name, now, ranking.id);
          } else {
            insert.run(
              ranking.id,
              ranking.connectorType,
              ranking.name,
              ranking.rank,
              now,
            );
          }
        }
      }).immediate();
      return database.prepare(`
        SELECT id, connector_type AS connectorType, name, rank, updated_at AS updatedAt
        FROM source_rankings ORDER BY rank ASC, id ASC
      `).all() as SourceRankingRecord[];
    },

    async listSyncHistory(input) {
      const rows = database.prepare(`
        SELECT ${SYNC_HISTORY_COLUMNS}
        FROM sync_log
        ${input.before ? 'WHERE synced_at < ?' : ''}
        ORDER BY synced_at DESC, id DESC
        LIMIT ?
      `).all(
        ...(input.before ? [input.before, input.limit + 1] : [input.limit + 1]),
      ) as SqliteSyncHistoryRow[];
      const hasMore = rows.length > input.limit;
      return {
        history: rows.slice(0, input.limit).map(mapSyncHistory),
        hasMore,
      };
    },

    async getSyncWorkerHeartbeat() {
      return database.prepare(`
        SELECT started_at AS startedAt, heartbeat_at AS heartbeatAt
        FROM runtime_telemetry
        WHERE role = 'worker'
        ORDER BY heartbeat_at DESC
        LIMIT 1
      `).get() as { startedAt: string; heartbeatAt: string } | undefined ?? null;
    },
  };
}

type ConnectorOverviewResult = Awaited<
  ReturnType<ConnectorManagementPersistence['getOverview']>
>;
