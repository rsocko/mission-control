import type { Pool, PoolClient } from 'pg';
import type {
  ConnectorManagementPersistence,
  ManagedConnectorRecord,
  ManagedConnectorUpdate,
  SourceRankingRecord,
  SyncHistoryRecord,
} from '@/db/persistence/connector-management';
import type { SourceListRecord } from '@/db/persistence/connector-execution';
import { initializePostgresGitHubConnectorIdentityStateInTransaction } from './github-identity-repositories';

type Client = Pool | PoolClient;

interface CountRow {
  count: string;
}

async function rows<T>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

const CONNECTOR_COLUMNS = `
  id,
  type,
  name,
  enabled,
  sync_mode AS "syncMode",
  poll_interval_minutes AS "pollIntervalMinutes",
  capabilities,
  credentials,
  settings,
  synced_lists AS "syncedLists",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt",
  last_test_status AS "lastTestStatus",
  last_test_error AS "lastTestError",
  last_test_at AS "lastTestAt"
`;

const SOURCE_LIST_COLUMNS = `
  id,
  connector_instance_id AS "connectorInstanceId",
  source_id AS "sourceId",
  name,
  type,
  task_count AS "taskCount",
  last_synced_at AS "lastSyncedAt",
  well_known_list_name AS "wellKnownListName",
  group_id AS "groupId",
  sort_order AS "sortOrder",
  hidden,
  last_known_remote_name AS "lastKnownRemoteName",
  user_display_name AS "userDisplayName",
  icon,
  icon_color AS "iconColor"
`;

const SYNC_HISTORY_COLUMNS = `
  id,
  connector_id AS "connectorId",
  success,
  tasks_added AS "tasksAdded",
  tasks_updated AS "tasksUpdated",
  tasks_removed AS "tasksRemoved",
  tasks_pushed AS "tasksPushed",
  local_only_protected AS "localOnlyProtected",
  alerts_added AS "notificationsAdded",
  errors,
  details,
  synced_at AS "syncedAt",
  duration_ms AS "durationMs",
  job_id AS "jobId",
  trigger,
  scheduled_for AS "scheduledFor",
  started_at AS "startedAt",
  attempt,
  max_attempts AS "maxAttempts",
  identity_mode AS "identityMode",
  identity_mode_revision AS "identityModeRevision"
`;

function updateParts(
  updates: ManagedConnectorUpdate,
  firstParameter = 1,
): { assignments: string[]; values: unknown[]; nextParameter: number } {
  const assignments: string[] = [];
  const values: unknown[] = [];
  let parameter = firstParameter;
  const add = (column: string, value: unknown, cast = '') => {
    assignments.push(`${column} = $${parameter}${cast}`);
    values.push(value);
    parameter += 1;
  };
  if (updates.name !== undefined) add('name', updates.name);
  if (updates.enabled !== undefined) add('enabled', updates.enabled);
  if (updates.syncMode !== undefined) add('sync_mode', updates.syncMode);
  if (updates.pollIntervalMinutes !== undefined) {
    add('poll_interval_minutes', updates.pollIntervalMinutes);
  }
  if (updates.capabilities !== undefined) {
    add('capabilities', JSON.stringify(updates.capabilities), '::jsonb');
  }
  if (updates.credentials !== undefined) {
    add('credentials', JSON.stringify(updates.credentials), '::jsonb');
  }
  if (updates.settings !== undefined) add('settings', JSON.stringify(updates.settings), '::jsonb');
  if (updates.syncedLists !== undefined) {
    add('synced_lists', JSON.stringify(updates.syncedLists), '::jsonb');
  }
  return { assignments, values, nextParameter: parameter };
}

export function createPostgresConnectorManagementRepository(
  pool: Pool,
): ConnectorManagementPersistence {
  const listSourceRankings = async (): Promise<SourceRankingRecord[]> => rows<SourceRankingRecord>(
    pool,
    `
      SELECT
        id,
        connector_type AS "connectorType",
        name,
        rank,
        updated_at AS "updatedAt"
      FROM source_rankings
      ORDER BY rank ASC, id ASC
    `,
  );

  return {
    async getOverview(includeDeleted) {
      const [connectors, sourceLists, countRows, syncRows] = await Promise.all([
        rows<ManagedConnectorRecord>(
          pool,
          `
            SELECT ${CONNECTOR_COLUMNS}
            FROM connector_configs
            ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'}
            ORDER BY created_at ASC, id ASC
          `,
        ),
        rows<SourceListRecord>(
          pool,
          `
            SELECT ${SOURCE_LIST_COLUMNS}
            FROM source_lists
            ORDER BY sort_order ASC, id ASC
          `,
        ),
        rows<{
          connectorInstanceId: string;
          sourceListId: string | null;
          count: string;
        }>(
          pool,
          `
            SELECT
              connector_instance_id AS "connectorInstanceId",
              source_list_id AS "sourceListId",
              count(*)::text AS count
            FROM tasks
            WHERE status NOT IN ('done', 'cancelled')
              AND parent_id IS NULL
              AND is_checklist_item = false
            GROUP BY connector_instance_id, source_list_id
          `,
        ),
        rows<{
          connectorId: string;
          lastSyncedAt: string | null;
          success: boolean;
          errors: unknown;
        }>(
          pool,
          `
            WITH ranked AS (
              SELECT
                connector_id AS "connectorId",
                success,
                errors,
                row_number() OVER (
                  PARTITION BY connector_id
                  ORDER BY synced_at DESC, id DESC
                ) AS rn,
                max(synced_at) FILTER (WHERE success)
                  OVER (PARTITION BY connector_id) AS "lastSyncedAt"
              FROM sync_log
            )
            SELECT "connectorId", "lastSyncedAt", success, errors
            FROM ranked
            WHERE rn = 1
          `,
        ),
      ]);
      return {
        connectors,
        sourceLists,
        openTaskCounts: countRows.map((row) => ({ ...row, count: Number(row.count) })),
        syncOutcomes: syncRows.map((row) => {
          const errors = Array.isArray(row.errors) ? row.errors : [];
          return {
            connectorId: row.connectorId,
            lastSyncedAt: row.lastSyncedAt,
            success: row.success,
            error: errors.length > 0 ? String(errors[0]) : null,
          };
        }),
      };
    },

    async projectExists(projectId) {
      return (await pool.query(
        'SELECT 1 FROM hub_projects WHERE id = $1 LIMIT 1',
        [projectId],
      )).rowCount === 1;
    },

    async createConnector(input) {
      return transaction(pool, async (client) => {
        const result = await client.query(
          `
            INSERT INTO connector_configs (
              id, type, name, enabled, sync_mode, poll_interval_minutes,
              capabilities, credentials, settings, synced_lists, created_at, updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb,
              $10::jsonb, $11, $11
            )
            ON CONFLICT (id) DO NOTHING
            RETURNING id
          `,
          [
            input.id,
            input.type,
            input.name,
            input.enabled,
            input.syncMode,
            input.pollIntervalMinutes,
            JSON.stringify(input.capabilities),
            JSON.stringify(input.credentials),
            JSON.stringify(input.settings),
            JSON.stringify(input.syncedLists),
            input.now,
          ],
        );
        const created = result.rowCount === 1;
        if (created && input.type === 'github-issues') {
          await initializePostgresGitHubConnectorIdentityStateInTransaction(
            client,
            input.id,
            input.now,
          );
        }
        return created;
      });
    },

    async ensureSourceLists(lists) {
      if (lists.length === 0) return;
      await transaction(pool, async (client) => {
        for (const list of lists) {
          await client.query(
            `
              INSERT INTO source_lists (
                id, connector_instance_id, source_id, name, type, task_count,
                last_synced_at, sort_order, hidden, icon, icon_color
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
              ON CONFLICT (id) DO NOTHING
            `,
            [
              list.id,
              list.connectorInstanceId,
              list.sourceId,
              list.name,
              list.type,
              list.taskCount,
              list.lastSyncedAt,
              list.sortOrder,
              list.hidden,
              list.icon,
              list.iconColor,
            ],
          );
        }
      });
    },

    async ensureWorkTodoBridge(input) {
      await pool.query(
        `
          INSERT INTO work_todo_bridge_state (
            connector_id, transport, capability_profile, reset_required, created_at, updated_at
          ) VALUES ($1, $2, $3, false, $4, $4)
          ON CONFLICT (connector_id) DO NOTHING
        `,
        [input.connectorId, input.transport, input.capabilityProfile, input.now],
      );
    },

    async getConnector(connectorId) {
      return (await rows<ManagedConnectorRecord>(
        pool,
        `SELECT ${CONNECTOR_COLUMNS} FROM connector_configs WHERE id = $1 LIMIT 1`,
        [connectorId],
      ))[0] ?? null;
    },

    async updateConnector(input) {
      const parts = updateParts(input.updates);
      parts.assignments.push(`updated_at = $${parts.nextParameter}`);
      parts.values.push(input.now);
      let parameter = parts.nextParameter + 1;
      let predicate = `id = $${parameter}`;
      parts.values.push(input.connectorId);
      parameter += 1;
      if (input.expected) {
        predicate += ` AND updated_at = $${parameter} AND settings = $${parameter + 1}::jsonb`;
        parts.values.push(input.expected.updatedAt, JSON.stringify(input.expected.settings));
      }
      return (await pool.query(
        `UPDATE connector_configs SET ${parts.assignments.join(', ')} WHERE ${predicate}`,
        parts.values,
      )).rowCount === 1;
    },

    async updateWorkTodoConnector(input) {
      return transaction(pool, async (client) => {
        const bridgeRows = await rows<{
          transport: string;
          capabilityProfile: string;
          lastIngestAt: string | null;
        }>(
          client,
          `
            SELECT
              transport,
              capability_profile AS "capabilityProfile",
              last_ingest_at AS "lastIngestAt"
            FROM work_todo_bridge_state
            WHERE connector_id = $1
            FOR UPDATE
          `,
          [input.connectorId],
        );
        const bridge = bridgeRows[0];
        if (
          bridge?.lastIngestAt
          && (
            bridge.transport !== input.transport
            || bridge.capabilityProfile !== input.capabilityProfile
          )
        ) return 'tier-conflict';
        const parts = updateParts(input.updates);
        parts.assignments.push(`updated_at = $${parts.nextParameter}`);
        parts.values.push(input.now, input.connectorId);
        await client.query(
          `
            UPDATE connector_configs
            SET ${parts.assignments.join(', ')}
            WHERE id = $${parts.nextParameter + 1}
          `,
          parts.values,
        );
        await client.query(
          `
            UPDATE work_todo_bridge_state
            SET transport = $1, capability_profile = $2, updated_at = $3
            WHERE connector_id = $4
          `,
          [input.transport, input.capabilityProfile, input.now, input.connectorId],
        );
        return 'updated';
      });
    },

    async softDeleteConnector(connectorId, now) {
      return transaction(pool, async (client) => {
        await client.query(
          `
            UPDATE connector_configs
            SET deleted_at = $1, enabled = false, updated_at = $1
            WHERE id = $2
          `,
          [now, connectorId],
        );
        const [taskCount] = await rows<CountRow>(
          client,
          'SELECT count(*)::text AS count FROM tasks WHERE connector_instance_id = $1',
          [connectorId],
        );
        const [listCount] = await rows<CountRow>(
          client,
          'SELECT count(*)::text AS count FROM source_lists WHERE connector_instance_id = $1',
          [connectorId],
        );
        return {
          affectedTasks: Number(taskCount.count),
          affectedLists: Number(listCount.count),
        };
      });
    },

    async hardDeleteConnector(connectorId) {
      await transaction(pool, async (client) => {
        const taskSubquery = 'SELECT id FROM tasks WHERE connector_instance_id = $1';
        for (const [table, column] of [
          ['task_tags', 'task_id'],
          ['project_auto_include_exclusions', 'task_id'],
          ['task_projects', 'task_id'],
          ['task_schedules', 'task_id'],
          ['my_day_items', 'task_id'],
          ['focus_items', 'task_id'],
          ['project_phase_items', 'task_id'],
        ] as const) {
          await client.query(
            `DELETE FROM ${table} WHERE ${column} IN (${taskSubquery})`,
            [connectorId],
          );
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
            await client.query(
              `
                DELETE FROM finance_insight_publication_facts
                WHERE publication_id IN (
                  SELECT id FROM finance_insight_publications WHERE connector_id = $1
                )
              `,
              [connectorId],
            );
          }
          await client.query(`DELETE FROM ${table} WHERE ${column} = $1`, [connectorId]);
        }
      });
    },

    async getSourceList(sourceListId) {
      return (await rows<SourceListRecord>(
        pool,
        `SELECT ${SOURCE_LIST_COLUMNS} FROM source_lists WHERE id = $1 LIMIT 1`,
        [sourceListId],
      ))[0] ?? null;
    },

    async listGroupExists(groupId) {
      return (await pool.query(
        'SELECT 1 FROM list_groups WHERE id = $1 LIMIT 1',
        [groupId],
      )).rowCount === 1;
    },

    async patchSourceList(input) {
      const assignments: string[] = [];
      const values: unknown[] = [];
      if (input.groupId !== undefined) {
        values.push(input.groupId);
        assignments.push(`group_id = $${values.length}`);
      }
      if (input.hidden !== undefined) {
        values.push(input.hidden);
        assignments.push(`hidden = $${values.length}`);
      }
      if (assignments.length === 0) return;
      values.push(input.sourceListId);
      await pool.query(
        `UPDATE source_lists SET ${assignments.join(', ')} WHERE id = $${values.length}`,
        values,
      );
    },

    async applyLocalSourceListRename(input) {
      await transaction(pool, async (client) => {
        const assignments = ['user_display_name = $1'];
        const values: unknown[] = [input.name];
        if (input.icon !== undefined) {
          values.push(input.icon);
          assignments.push(`icon = $${values.length}`);
        }
        if (input.iconColor !== undefined) {
          values.push(input.iconColor);
          assignments.push(`icon_color = $${values.length}`);
        }
        values.push(input.sourceListId);
        await client.query(
          `UPDATE source_lists SET ${assignments.join(', ')} WHERE id = $${values.length}`,
          values,
        );
        await client.query(
          `
            UPDATE tasks
            SET source_list_name = $1
            WHERE source_list_id = (
              SELECT source_id FROM source_lists WHERE id = $2
            )
              AND connector_instance_id = (
                SELECT connector_instance_id FROM source_lists WHERE id = $2
              )
          `,
          [input.name, input.sourceListId],
        );
      });
    },

    async confirmRemoteSourceListRename(sourceListId, name) {
      await pool.query(
        `
          UPDATE source_lists
          SET name = $1, last_known_remote_name = $1
          WHERE id = $2
        `,
        [name, sourceListId],
      );
    },

    async reorderSourceLists(orderedIds) {
      await transaction(pool, async (client) => {
        for (const [index, id] of orderedIds.entries()) {
          await client.query(
            'UPDATE source_lists SET sort_order = $1 WHERE id = $2',
            [index, id],
          );
        }
      });
    },

    listSourceRankings,

    async putSourceRankings(rankings, now) {
      await transaction(pool, async (client) => {
        for (const ranking of rankings) {
          const updated = await client.query(
            `
              UPDATE source_rankings
              SET rank = $1,
                  name = COALESCE(NULLIF($2, ''), name),
                  updated_at = $3
              WHERE id = $4
            `,
            [
              ranking.rank,
              ranking.name,
              now,
              ranking.id,
            ],
          );
          if (updated.rowCount === 0) {
            await client.query(
              `
                INSERT INTO source_rankings (id, connector_type, name, rank, updated_at)
                VALUES ($1, $2, $3, $4, $5)
              `,
              [
                ranking.id,
                ranking.connectorType,
                ranking.name,
                ranking.rank,
                now,
              ],
            );
          }
        }
      });
      return listSourceRankings();
    },

    async listSyncHistory(input) {
      const historyRows = await rows<SyncHistoryRecord>(
        pool,
        `
          SELECT ${SYNC_HISTORY_COLUMNS}
          FROM sync_log
          ${input.before ? 'WHERE synced_at < $1' : ''}
          ORDER BY synced_at DESC, id DESC
          LIMIT $${input.before ? 2 : 1}
        `,
        input.before ? [input.before, input.limit + 1] : [input.limit + 1],
      );
      const hasMore = historyRows.length > input.limit;
      return { history: historyRows.slice(0, input.limit), hasMore };
    },

    async getSyncWorkerHeartbeat() {
      return (await rows<{ startedAt: string; heartbeatAt: string }>(
        pool,
        `
          SELECT started_at AS "startedAt", heartbeat_at AS "heartbeatAt"
          FROM runtime_telemetry
          WHERE role = 'worker'
          ORDER BY heartbeat_at DESC
          LIMIT 1
        `,
      ))[0] ?? null;
    },
  };
}
