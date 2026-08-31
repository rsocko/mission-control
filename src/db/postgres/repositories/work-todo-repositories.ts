import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  WORK_TODO_DEFAULT_LEASE_SECONDS,
  WORK_TODO_MAX_CHANGE_BATCH,
  WORK_TODO_MAX_LEASE_SECONDS,
  WORK_TODO_MIN_LEASE_SECONDS,
  WorkTodoBridgeError,
  staleWorkTodoIngestError,
  type WorkTodoAckCommand,
  type WorkTodoAckResult,
  type WorkTodoBridgePersistence,
  type WorkTodoBridgeStatus,
  type WorkTodoCapabilityProfile,
  type WorkTodoChangeOperation,
  type WorkTodoIngestCommand,
  type WorkTodoIngestMode,
  type WorkTodoIngestResult,
  type WorkTodoLeaseCommand,
  type WorkTodoLeaseResult,
  type WorkTodoLeasedChange,
  type WorkTodoPullState,
  type WorkTodoResetResult,
  type WorkTodoSearchableTask,
  type WorkTodoTransport,
} from '@/db/persistence/work-todo';
import {
  WORK_TODO_CONNECTOR_TYPE,
  buildWorkTodoChecklistMetadata,
  buildWorkTodoOutboundChange,
  buildWorkTodoTaskMetadata,
  isWorkTodoCheckpointAdvance,
  parseWorkTodoJsonObject,
  resolveWorkTodoRemoteValues,
  slugifyWorkTodoTag,
  workTodoChecklistSourceId,
  workTodoRemoteSourceId,
  workTodoSourceTagNames,
  type WorkTodoRemoteTaskInput,
} from '@/db/persistence/work-todo-values';
import { deleteTasksWithCanonicalCleanup } from './task-deletion';

type Client = Pool | PoolClient;

async function query<T extends QueryResultRow>(
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

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return WORK_TODO_MAX_CHANGE_BATCH;
  return Math.min(Math.max(Math.trunc(limit as number), 1), WORK_TODO_MAX_CHANGE_BATCH);
}

function clampLeaseSeconds(leaseSeconds: number | undefined): number {
  if (!Number.isFinite(leaseSeconds)) return WORK_TODO_DEFAULT_LEASE_SECONDS;
  return Math.min(
    Math.max(Math.trunc(leaseSeconds as number), WORK_TODO_MIN_LEASE_SECONDS),
    WORK_TODO_MAX_LEASE_SECONDS,
  );
}

interface BridgeStateRow {
  transport: WorkTodoTransport;
  capabilityProfile: WorkTodoCapabilityProfile;
  listDeltaLink: string | null;
  resetRequired: boolean;
  lastIngestAt: string | null;
  lastIngestMode: WorkTodoIngestMode | null;
  lastError: string | null;
}

interface ExistingTaskRow {
  id: string;
  syncStatus: string;
  updatedAt: string;
  metadata: unknown;
  dueDate: string | null;
  reminderAt: string | null;
  reminderRelative: string | null;
  reminderDueTime: string | null;
}

interface OutboundChangeRow {
  idempotencyKey: string;
  taskId: string;
  sourceId: string;
  listSourceId: string;
  remoteTaskId: string;
  operation: WorkTodoChangeOperation;
  fields: Record<string, unknown> | null;
  taskVersion: string;
  status: 'pending' | 'leased' | 'succeeded' | 'failed' | 'superseded';
  leaseId: string | null;
  leaseExpiresAt: string | null;
  attemptCount: number;
}

const OUTBOUND_CHANGE_COLUMNS = `
  idempotency_key AS "idempotencyKey",
  task_id AS "taskId",
  source_id AS "sourceId",
  list_source_id AS "listSourceId",
  remote_task_id AS "remoteTaskId",
  operation,
  fields,
  task_version AS "taskVersion",
  status,
  lease_id AS "leaseId",
  lease_expires_at AS "leaseExpiresAt",
  attempt_count AS "attemptCount"
`;

/** Keeps the post-write searchable projection read off an unbounded IN list. */
const SEARCH_READ_BATCH = 200;

/**
 * PostgreSQL adapter for the Work To Do bridge port.
 *
 * Each command runs in one explicit transaction. Connector, bridge-state, and
 * outbound-change rows are locked with `FOR UPDATE` before they are read-checked
 * and written, so a concurrent ingest, lease, or acknowledgement cannot
 * interleave: leases are taken in a deterministic bounded order, only expired
 * leases are reclaimed, acknowledgements are fenced by connector + status +
 * lease ID + task version, and a delayed envelope is rejected as
 * `STALE_INGEST_ENVELOPE` before it mutates anything. No connector traffic or
 * search indexing happens inside a transaction — the command returns the
 * committed task IDs the service must index or remove after commit.
 */
export function createPostgresWorkTodoRepositories(
  pool: Pool,
): WorkTodoBridgePersistence {
  async function assertConnector(
    client: Client,
    connectorId: string,
    lock: boolean,
  ): Promise<void> {
    const [connector] = await query<{
      type: string;
      enabled: boolean;
      deletedAt: string | null;
    }>(
      client,
      `SELECT type, enabled, deleted_at AS "deletedAt"
       FROM connector_configs
       WHERE id = $1
       LIMIT 1${lock ? '\n       FOR UPDATE' : ''}`,
      [connectorId],
    );
    if (!connector || connector.deletedAt || connector.type !== WORK_TODO_CONNECTOR_TYPE) {
      throw new WorkTodoBridgeError('CONNECTOR_NOT_FOUND', 'Work To Do connector not found', 404);
    }
    if (!connector.enabled) {
      throw new WorkTodoBridgeError('CONNECTOR_DISABLED', 'Work To Do connector is disabled', 409);
    }
  }

  /**
   * Deletes a task and its descendants depth-first inside the caller's
   * transaction, applying the canonical cleanup shared with the core task
   * repository and connector execution. The traversal is cycle-guarded and
   * bounded by the recursive descendant set, so a corrupt parent cycle cannot
   * loop forever, and children are removed before their parents.
   */
  async function removeTask(
    client: Client,
    taskId: string,
    removedIds: Set<string>,
  ): Promise<void> {
    const descendants = await query<{ id: string }>(
      client,
      `
        WITH RECURSIVE tree(id, depth, path) AS (
          SELECT id, 0, ARRAY[id] FROM tasks WHERE id = $1
          UNION ALL
          SELECT child.id, tree.depth + 1, tree.path || child.id
          FROM tasks AS child
          JOIN tree ON child.parent_id = tree.id
          WHERE NOT (child.id = ANY(tree.path))
        )
        SELECT id FROM tree ORDER BY depth DESC
      `,
      [taskId],
    );
    const ids = descendants.length > 0 ? descendants.map((row) => row.id) : [taskId];
    await deleteTasksWithCanonicalCleanup(client, ids);
    // Collected rather than published inline: search index removal must happen
    // after the authoritative transaction commits, never inside it.
    for (const id of ids) removedIds.add(id);
  }

  async function loadBridgeState(
    client: Client,
    connectorId: string,
    lock: boolean,
  ): Promise<BridgeStateRow | null> {
    const [state] = await query<BridgeStateRow>(
      client,
      `SELECT transport,
              capability_profile AS "capabilityProfile",
              list_delta_link AS "listDeltaLink",
              reset_required AS "resetRequired",
              last_ingest_at AS "lastIngestAt",
              last_ingest_mode AS "lastIngestMode",
              last_error AS "lastError"
       FROM work_todo_bridge_state
       WHERE connector_id = $1
       LIMIT 1${lock ? '\n       FOR UPDATE' : ''}`,
      [connectorId],
    );
    return state ?? null;
  }

  async function findTaskBySourceId(
    client: Client,
    connectorId: string,
    sourceId: string,
  ): Promise<ExistingTaskRow | null> {
    const [task] = await query<ExistingTaskRow>(
      client,
      `SELECT id,
              sync_status AS "syncStatus",
              updated_at AS "updatedAt",
              metadata,
              due_date AS "dueDate",
              reminder_at AS "reminderAt",
              reminder_relative AS "reminderRelative",
              reminder_due_time AS "reminderDueTime"
       FROM tasks
       WHERE connector_instance_id = $1 AND source_id = $2
       LIMIT 1
       FOR UPDATE`,
      [connectorId, sourceId],
    );
    return task ?? null;
  }

  return {
    async ingest(command: WorkTodoIngestCommand): Promise<WorkTodoIngestResult> {
      const { payload, now, timezone } = command;
      const isStandard = payload.schemaVersion === '1.0';
      if (isStandard && payload.lists.some((list) => list.tasks.length >= 999)) {
        throw new WorkTodoBridgeError(
          'SNAPSHOT_MAY_BE_TRUNCATED',
          'A list returned 999 tasks; use the extended Graph bridge for reliable paging',
          409,
        );
      }

      const connectorId = payload.connectorInstanceId;
      const observedSourceIds = new Set<string>();
      const observedListIds = new Set<string>();
      const touchedTaskIds = new Set<string>();
      const removedTaskIds = new Set<string>();
      const indexedTasks: WorkTodoSearchableTask[] = [];
      let created = 0;
      let updated = 0;
      let removed = 0;
      let protectedPending = 0;

      await transaction(pool, async (client) => {
        await assertConnector(client, connectorId, true);

        const existingState = await loadBridgeState(client, connectorId, true);
        const expectedProfile = isStandard ? 'standard-v1' : 'extended-v1';
        if (existingState && existingState.capabilityProfile !== expectedProfile) {
          throw new WorkTodoBridgeError(
            'CAPABILITY_PROFILE_MISMATCH',
            `Payload requires ${expectedProfile}, connector is ${existingState.capabilityProfile}`,
            409,
          );
        }
        // A strictly older envelope is rejected here — after the connector and
        // bridge-state rows are locked with `FOR UPDATE` and before any task,
        // list, tag, checklist, or removal mutation — so a delayed delivery can
        // neither resurrect superseded data nor regress the accepted
        // checkpoint. A replay carrying the accepted instant is still applied
        // idempotently.
        if (!isWorkTodoCheckpointAdvance(
          existingState?.lastIngestAt ?? null,
          payload.syncTimestamp,
        )) {
          throw staleWorkTodoIngestError(
            existingState?.lastIngestAt ?? null,
            payload.syncTimestamp,
          );
        }

        for (const list of payload.lists) {
          if ('removed' in list && list.removed) {
            const listTasks = await query<{ id: string; syncStatus: string }>(
              client,
              `SELECT id, sync_status AS "syncStatus"
               FROM tasks
               WHERE connector_instance_id = $1 AND source_list_id = $2
               ORDER BY id
               FOR UPDATE`,
              [connectorId, list.id],
            );
            for (const task of listTasks) {
              if (task.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                await removeTask(client, task.id, removedTaskIds);
                removed++;
              }
            }
            const retainedTask = listTasks.some((task) => task.syncStatus === 'pending_push');
            if (!retainedTask) {
              await client.query(
                'DELETE FROM source_lists WHERE connector_instance_id = $1 AND source_id = $2',
                [connectorId, list.id],
              );
            }
            await client.query(
              'DELETE FROM work_todo_list_delta_state WHERE connector_id = $1 AND list_source_id = $2',
              [connectorId, list.id],
            );
            continue;
          }

          const displayName = list.displayName;
          observedListIds.add(list.id);
          await client.query(
            `INSERT INTO source_lists (
               id, connector_instance_id, source_id, name, type, task_count,
               last_synced_at, well_known_list_name, sort_order, hidden,
               last_known_remote_name
             ) VALUES ($1, $2, $3, $4, 'list', 0, $5, $6, 0, false, $4)
             ON CONFLICT (id) DO UPDATE SET
               name = EXCLUDED.name,
               last_known_remote_name = EXCLUDED.last_known_remote_name,
               last_synced_at = EXCLUDED.last_synced_at,
               well_known_list_name = EXCLUDED.well_known_list_name`,
            [
              `${connectorId}:${list.id}`,
              connectorId,
              list.id,
              displayName,
              payload.syncTimestamp,
              list.wellKnownListName ?? null,
            ],
          );

          for (const remoteTask of list.tasks) {
            const sourceId = workTodoRemoteSourceId(list.id, remoteTask.id);
            observedSourceIds.add(sourceId);
            const existing = await findTaskBySourceId(client, connectorId, sourceId);

            if ('removed' in remoteTask && remoteTask.removed) {
              if (!existing) continue;
              if (existing.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                await removeTask(client, existing.id, removedTaskIds);
                removed++;
              }
              continue;
            }

            const remoteInput = remoteTask as unknown as WorkTodoRemoteTaskInput;
            const metadata = buildWorkTodoTaskMetadata(remoteInput, list);
            const taskId = existing?.id ?? randomUUID();
            const remoteValues = resolveWorkTodoRemoteValues({
              remoteTask: remoteInput,
              existing,
              timezone,
              syncTimestamp: payload.syncTimestamp,
            });

            if (existing) {
              const pending = existing.syncStatus === 'pending_push';
              await client.query(
                `UPDATE tasks SET
                   title = CASE WHEN $2::boolean THEN title ELSE $3 END,
                   description = CASE WHEN $2::boolean THEN description ELSE $4 END,
                   status = CASE WHEN $2::boolean THEN status ELSE $5 END,
                   priority = CASE WHEN $2::boolean THEN priority ELSE $6 END,
                   due_date = CASE WHEN $2::boolean THEN due_date ELSE $7 END,
                   completed_at = CASE WHEN $2::boolean THEN completed_at ELSE $8 END,
                   reminder_at = CASE WHEN $2::boolean THEN reminder_at ELSE $9 END,
                   reminder_relative = CASE WHEN $2::boolean THEN reminder_relative ELSE $10 END,
                   reminder_due_time = CASE WHEN $2::boolean THEN reminder_due_time ELSE $11 END,
                   metadata = CASE WHEN $2::boolean THEN metadata ELSE $12::jsonb END,
                   source_list_id = $13,
                   source_list_name = $14,
                   last_synced_at = $15,
                   sync_status = CASE WHEN $2::boolean THEN 'pending_push' ELSE 'synced' END,
                   updated_at = CASE WHEN $2::boolean THEN updated_at ELSE $16 END
                 WHERE id = $1`,
                [
                  taskId,
                  pending,
                  remoteValues.title,
                  remoteValues.description,
                  remoteValues.status,
                  remoteValues.priority,
                  remoteValues.dueDate,
                  remoteValues.completedAt,
                  remoteValues.reminderAt,
                  'reminderRelative' in remoteValues
                    ? remoteValues.reminderRelative ?? null
                    : existing.reminderRelative,
                  'reminderDueTime' in remoteValues
                    ? remoteValues.reminderDueTime ?? null
                    : existing.reminderDueTime,
                  JSON.stringify(metadata),
                  list.id,
                  displayName,
                  payload.syncTimestamp,
                  remoteTask.lastModifiedDateTime,
                ],
              );
              updated++;
            } else {
              await client.query(
                `INSERT INTO tasks (
                   id, source_id, connector_type, connector_instance_id, title,
                   description, status, priority, due_date, completed_at,
                   reminder_at, reminder_relative, reminder_due_time,
                   created_at, updated_at, source_list_id, source_list_name,
                   metadata, sync_status, last_synced_at, is_bulk_import
                 ) VALUES (
                   $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                   $14, $15, $16, $17, $18::jsonb, 'synced', $19, true
                 )`,
                [
                  taskId,
                  sourceId,
                  WORK_TODO_CONNECTOR_TYPE,
                  connectorId,
                  remoteValues.title,
                  remoteValues.description,
                  remoteValues.status,
                  remoteValues.priority,
                  remoteValues.dueDate,
                  remoteValues.completedAt,
                  remoteValues.reminderAt,
                  remoteValues.reminderRelative ?? null,
                  remoteValues.reminderDueTime ?? null,
                  remoteTask.createdDateTime,
                  remoteTask.lastModifiedDateTime,
                  list.id,
                  displayName,
                  JSON.stringify(metadata),
                  payload.syncTimestamp,
                ],
              );
              created++;
            }
            touchedTaskIds.add(taskId);

            if (existing?.syncStatus !== 'pending_push') {
              await client.query('DELETE FROM task_tags WHERE task_id = $1', [taskId]);
              for (const tagName of workTodoSourceTagNames(remoteInput)) {
                const slug = slugifyWorkTodoTag(tagName);
                if (!slug) continue;
                const tagId = `${connectorId}:tag:${slug}`;
                await client.query(
                  `INSERT INTO tags (id, name, slug, type, source, confirmed, created_at)
                   VALUES ($1, $2, $3, 'source', $4, true, $5)
                   ON CONFLICT DO NOTHING`,
                  [tagId, tagName, slug, WORK_TODO_CONNECTOR_TYPE, now],
                );
                await client.query(
                  `INSERT INTO task_tags (task_id, tag_id)
                   VALUES ($1, $2)
                   ON CONFLICT DO NOTHING`,
                  [taskId, tagId],
                );
              }
            }

            if ('checklistItems' in remoteTask && remoteTask.checklistItems) {
              const observedChecklistIds = new Set<string>();
              for (const item of remoteTask.checklistItems) {
                const childSourceId = workTodoChecklistSourceId(sourceId, item.id);
                observedChecklistIds.add(childSourceId);
                const child = await findTaskBySourceId(client, connectorId, childSourceId);
                const childId = child?.id ?? randomUUID();
                const childCompletedAt = item.isChecked ? payload.syncTimestamp : null;
                const childStatus = item.isChecked ? 'done' : 'todo';
                const childMetadata = JSON.stringify(buildWorkTodoChecklistMetadata(
                  remoteTask.id,
                  list.id,
                  item.id,
                ));
                if (child) {
                  const childPending = child.syncStatus === 'pending_push';
                  await client.query(
                    `UPDATE tasks SET
                       title = CASE WHEN $2::boolean THEN title ELSE $3 END,
                       status = CASE WHEN $2::boolean THEN status ELSE $4 END,
                       completed_at = CASE WHEN $2::boolean THEN completed_at ELSE $5 END,
                       parent_id = $6,
                       metadata = $7::jsonb,
                       last_synced_at = $8,
                       sync_status = CASE WHEN $2::boolean THEN 'pending_push' ELSE 'synced' END
                     WHERE id = $1`,
                    [
                      childId,
                      childPending,
                      item.displayName,
                      childStatus,
                      childCompletedAt,
                      taskId,
                      childMetadata,
                      payload.syncTimestamp,
                    ],
                  );
                } else {
                  await client.query(
                    `INSERT INTO tasks (
                       id, source_id, connector_type, connector_instance_id, title,
                       status, completed_at, priority, created_at, updated_at,
                       parent_id, depth, is_checklist_item, source_list_id,
                       source_list_name, metadata, sync_status, last_synced_at,
                       is_bulk_import
                     ) VALUES (
                       $1, $2, $3, $4, $5, $6, $7, 'none', $8, $9, $10, 1, true,
                       $11, $12, $13::jsonb, 'synced', $14, true
                     )`,
                    [
                      childId,
                      childSourceId,
                      WORK_TODO_CONNECTOR_TYPE,
                      connectorId,
                      item.displayName,
                      childStatus,
                      childCompletedAt,
                      remoteTask.createdDateTime,
                      remoteTask.lastModifiedDateTime,
                      taskId,
                      list.id,
                      displayName,
                      childMetadata,
                      payload.syncTimestamp,
                    ],
                  );
                }
                touchedTaskIds.add(childId);
              }

              const existingChildren = await query<{
                id: string;
                sourceId: string;
                syncStatus: string;
              }>(
                client,
                `SELECT id, source_id AS "sourceId", sync_status AS "syncStatus"
                 FROM tasks
                 WHERE parent_id = $1
                 ORDER BY id`,
                [taskId],
              );
              for (const child of existingChildren) {
                if (!observedChecklistIds.has(child.sourceId)
                  && child.syncStatus !== 'pending_push') {
                  await removeTask(client, child.id, removedTaskIds);
                  removed++;
                }
              }
            }
          }

          if (payload.schemaVersion === '1.1' && 'taskDeltaLink' in list) {
            await client.query(
              `INSERT INTO work_todo_list_delta_state (
                 connector_id, list_source_id, delta_link, updated_at
               ) VALUES ($1, $2, $3, $4)
               ON CONFLICT (connector_id, list_source_id) DO UPDATE SET
                 delta_link = EXCLUDED.delta_link,
                 updated_at = EXCLUDED.updated_at`,
              [connectorId, list.id, list.taskDeltaLink, now],
            );
          }
        }

        if (isStandard || payload.reset) {
          const currentTasks = await query<{
            id: string;
            sourceId: string;
            syncStatus: string;
          }>(
            client,
            `SELECT id, source_id AS "sourceId", sync_status AS "syncStatus"
             FROM tasks
             WHERE connector_instance_id = $1
             ORDER BY id`,
            [connectorId],
          );
          for (const task of currentTasks) {
            if (task.sourceId.includes(':checklist:')) continue;
            if (!observedSourceIds.has(task.sourceId)) {
              if (task.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                await removeTask(client, task.id, removedTaskIds);
                removed++;
              }
            }
          }
          const currentLists = await query<{ id: string; sourceId: string }>(
            client,
            `SELECT id, source_id AS "sourceId"
             FROM source_lists
             WHERE connector_instance_id = $1
             ORDER BY id`,
            [connectorId],
          );
          for (const list of currentLists) {
            if (observedListIds.has(list.sourceId)) continue;
            const retained = await query<{ id: string }>(
              client,
              `SELECT id FROM tasks
               WHERE connector_instance_id = $1 AND source_list_id = $2
               LIMIT 1`,
              [connectorId, list.sourceId],
            );
            if (retained.length === 0) {
              await client.query('DELETE FROM source_lists WHERE id = $1', [list.id]);
            }
          }
        }

        const transport: WorkTodoTransport = isStandard
          ? 'power-automate-standard'
          : 'power-automate-graph';
        const mode: WorkTodoIngestMode = isStandard ? 'snapshot' : 'delta';
        await client.query(
          `INSERT INTO work_todo_bridge_state (
             connector_id, transport, capability_profile, list_delta_link,
             reset_required, last_ingest_at, last_ingest_mode, last_error,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, false, $5, $6, NULL, $7, $7)
           ON CONFLICT (connector_id) DO UPDATE SET
             list_delta_link = EXCLUDED.list_delta_link,
             reset_required = false,
             last_ingest_at = EXCLUDED.last_ingest_at,
             last_ingest_mode = EXCLUDED.last_ingest_mode,
             last_error = NULL,
             updated_at = EXCLUDED.updated_at`,
          [
            connectorId,
            transport,
            isStandard ? 'standard-v1' : 'extended-v1',
            isStandard ? null : payload.listDeltaLink,
            payload.syncTimestamp,
            mode,
            now,
          ],
        );

        // Read the committed searchable projection inside the same transaction
        // so the service indexes exactly what was written, including tasks whose
        // pending local edit was protected from the remote values.
        const survivingIds = [...touchedTaskIds].filter((id) => !removedTaskIds.has(id));
        for (let offset = 0; offset < survivingIds.length; offset += SEARCH_READ_BATCH) {
          const batch = survivingIds.slice(offset, offset + SEARCH_READ_BATCH);
          const rows = await query<WorkTodoSearchableTask>(
            client,
            `SELECT id, title, description,
                    source_list_name AS "sourceListName",
                    connector_type AS "connectorType",
                    status, priority,
                    updated_at AS "updatedAt"
             FROM tasks
             WHERE id = ANY($1::text[])
             ORDER BY id`,
            [batch],
          );
          indexedTasks.push(...rows);
        }
      });

      return {
        mode: isStandard ? 'snapshot' : 'delta',
        created,
        updated,
        removed,
        protectedPending,
        indexedTasks,
        removedTaskIds: [...removedTaskIds],
      };
    },

    async lease(command: WorkTodoLeaseCommand): Promise<WorkTodoLeaseResult> {
      const nowIso = command.now;
      const leaseId = randomUUID();
      const leaseSeconds = clampLeaseSeconds(command.leaseSeconds);
      const leaseExpiresAt = new Date(
        new Date(nowIso).getTime() + leaseSeconds * 1_000,
      ).toISOString();
      const limit = clampLimit(command.limit);
      const connectorId = command.connectorId;

      return transaction(pool, async (client) => {
        await assertConnector(client, connectorId, true);
        const state = await loadBridgeState(client, connectorId, true);
        if (!state?.lastIngestAt) {
          throw new WorkTodoBridgeError(
            'BRIDGE_NOT_INITIALIZED',
            'Connector must accept an inbound baseline before write-back',
            409,
          );
        }

        // Deterministic bounded ordering keeps concurrent leases from
        // deadlocking and makes the reclaim/lease decision reproducible.
        await client.query(
          `UPDATE work_todo_outbound_changes SET
             status = 'pending',
             lease_id = NULL,
             leased_at = NULL,
             lease_expires_at = NULL,
             updated_at = $2
           WHERE connector_id = $1
             AND status = 'leased'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at < $2`,
          [connectorId, nowIso],
        );

        const activeLease = await query<OutboundChangeRow>(
          client,
          `SELECT ${OUTBOUND_CHANGE_COLUMNS}
           FROM work_todo_outbound_changes
           WHERE connector_id = $1
             AND status = 'leased'
             AND lease_expires_at IS NOT NULL
             AND lease_expires_at >= $2
           ORDER BY created_at, idempotency_key
           LIMIT $3
           FOR UPDATE`,
          [connectorId, nowIso, limit],
        );
        if (activeLease.length > 0) {
          return {
            leaseId: activeLease[0].leaseId ?? leaseId,
            leaseExpiresAt: activeLease[0].leaseExpiresAt ?? leaseExpiresAt,
            changes: activeLease.map(toLeasedChange),
          };
        }

        const pendingTasks = await query<{
          id: string;
          sourceId: string;
          sourceListId: string | null;
          isChecklistItem: boolean;
          metadata: unknown;
          title: string;
          description: string | null;
          status: string;
          priority: string;
          dueDate: string | null;
          updatedAt: string;
        }>(
          client,
          `SELECT id,
                  source_id AS "sourceId",
                  source_list_id AS "sourceListId",
                  is_checklist_item AS "isChecklistItem",
                  metadata,
                  title,
                  description,
                  status,
                  priority,
                  due_date AS "dueDate",
                  updated_at AS "updatedAt"
           FROM tasks
           WHERE connector_instance_id = $1 AND sync_status = 'pending_push'
           ORDER BY id`,
          [connectorId],
        );

        // Any retryable change whose frozen task version no longer matches the
        // current local edit is superseded before a new change is enqueued.
        await client.query(
          `UPDATE work_todo_outbound_changes AS change SET
             status = 'superseded',
             last_error = 'Superseded by a newer local edit',
             updated_at = $2
           WHERE change.connector_id = $1
             AND change.status IN ('pending', 'failed')
             AND change.task_version IS DISTINCT FROM (
               SELECT task.updated_at FROM tasks AS task
               WHERE task.id = change.task_id AND task.connector_instance_id = $1
             )`,
          [connectorId, nowIso],
        );

        for (const task of pendingTasks) {
          const draft = buildWorkTodoOutboundChange({
            id: task.id,
            sourceId: task.sourceId,
            sourceListId: task.sourceListId,
            isChecklistItem: Boolean(task.isChecklistItem),
            metadata: parseWorkTodoJsonObject(task.metadata),
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            dueDate: task.dueDate,
            updatedAt: task.updatedAt,
          });
          if (!draft) continue;
          await client.query(
            `INSERT INTO work_todo_outbound_changes (
               idempotency_key, connector_id, task_id, source_id, list_source_id,
               remote_task_id, operation, fields, task_version, status,
               attempt_count, created_at, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, 'pending', 0, $10, $10)
             ON CONFLICT DO NOTHING`,
            [
              randomUUID(),
              connectorId,
              draft.taskId,
              draft.sourceId,
              draft.listSourceId,
              draft.remoteTaskId,
              draft.operation,
              draft.fields === null ? null : JSON.stringify(draft.fields),
              draft.taskVersion,
              nowIso,
            ],
          );
        }

        const ready = await query<OutboundChangeRow>(
          client,
          `SELECT ${OUTBOUND_CHANGE_COLUMNS}
           FROM work_todo_outbound_changes
           WHERE connector_id = $1 AND status IN ('pending', 'failed')
           ORDER BY created_at, idempotency_key
           LIMIT $2
           FOR UPDATE`,
          [connectorId, limit],
        );

        if (ready.length > 0) {
          await client.query(
            `UPDATE work_todo_outbound_changes SET
               status = 'leased',
               lease_id = $2,
               leased_at = $3,
               lease_expires_at = $4,
               attempt_count = attempt_count + 1,
               updated_at = $3
             WHERE connector_id = $1
               AND idempotency_key = ANY($5::text[])
               AND status IN ('pending', 'failed')`,
            [
              connectorId,
              leaseId,
              nowIso,
              leaseExpiresAt,
              ready.map((change) => change.idempotencyKey),
            ],
          );
        }

        return {
          leaseId,
          leaseExpiresAt,
          changes: ready.map(toLeasedChange),
        };
      });
    },

    async readPullState(connectorId: string): Promise<WorkTodoPullState> {
      return transaction(pool, async (client) => {
        await assertConnector(client, connectorId, false);
        const state = await loadBridgeState(client, connectorId, false);
        if (!state) {
          throw new WorkTodoBridgeError(
            'BRIDGE_NOT_CONFIGURED',
            'Work To Do bridge state is missing',
            409,
          );
        }
        if (state.capabilityProfile === 'standard-v1') {
          return {
            capabilityProfile: 'standard-v1' as const,
            resetRequired: Boolean(state.resetRequired),
            listDeltaLink: null,
            selectedListIds: [],
            taskDeltaLinks: [],
          };
        }
        const listStates = await query<{ listSourceId: string; deltaLink: string | null }>(
          client,
          `SELECT list_source_id AS "listSourceId", delta_link AS "deltaLink"
           FROM work_todo_list_delta_state
           WHERE connector_id = $1
           ORDER BY list_source_id`,
          [connectorId],
        );
        const selected = await query<{ sourceId: string }>(
          client,
          `SELECT source_id AS "sourceId"
           FROM source_lists
           WHERE connector_instance_id = $1 AND hidden = false
           ORDER BY source_id`,
          [connectorId],
        );
        return {
          capabilityProfile: 'extended-v1' as const,
          resetRequired: Boolean(state.resetRequired),
          listDeltaLink: state.listDeltaLink ?? null,
          selectedListIds: selected.map((list) => list.sourceId),
          taskDeltaLinks: listStates.map((list) => ({
            listSourceId: list.listSourceId,
            deltaLink: list.deltaLink ?? null,
          })),
        };
      });
    },

    async acknowledge(command: WorkTodoAckCommand): Promise<WorkTodoAckResult> {
      const { payload, now } = command;
      const connectorId = payload.connectorInstanceId;
      const removedTaskIds = new Set<string>();

      const result = await transaction(pool, async (client) => {
        await assertConnector(client, connectorId, true);
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        let stale = 0;

        for (const outcome of payload.results.slice(0, WORK_TODO_MAX_CHANGE_BATCH)) {
          const [change] = await query<OutboundChangeRow>(
            client,
            `SELECT ${OUTBOUND_CHANGE_COLUMNS}
             FROM work_todo_outbound_changes
             WHERE idempotency_key = $1 AND connector_id = $2
             LIMIT 1
             FOR UPDATE`,
            [outcome.idempotencyKey, connectorId],
          );
          if (!change || change.sourceId !== outcome.sourceId) {
            throw new WorkTodoBridgeError(
              'ACK_CHANGE_NOT_FOUND',
              `No leased change matches ${outcome.idempotencyKey}`,
              409,
            );
          }
          if (change.status === 'succeeded') {
            succeeded++;
            continue;
          }
          if (change.status !== 'leased' || change.leaseId !== payload.leaseId) {
            throw new WorkTodoBridgeError(
              'ACK_LEASE_MISMATCH',
              `Change ${outcome.idempotencyKey} does not belong to this active lease`,
              409,
            );
          }

          if (outcome.status === 'succeeded') {
            await client.query(
              `UPDATE work_todo_outbound_changes SET
                 status = 'succeeded',
                 acknowledged_at = $2,
                 lease_id = NULL,
                 lease_expires_at = NULL,
                 last_error = NULL,
                 updated_at = $3
               WHERE idempotency_key = $1
                 AND connector_id = $4
                 AND status = 'leased'
                 AND lease_id = $5`,
              [
                outcome.idempotencyKey,
                payload.processedAt,
                now,
                connectorId,
                payload.leaseId,
              ],
            );
            const [currentTask] = await query<{
              id: string;
              updatedAt: string;
              metadata: unknown;
            }>(
              client,
              `SELECT id, updated_at AS "updatedAt", metadata
               FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE`,
              [change.taskId],
            );
            if (currentTask?.updatedAt === change.taskVersion) {
              if (change.operation === 'delete') {
                await removeTask(client, change.taskId, removedTaskIds);
              } else {
                const metadata = { ...parseWorkTodoJsonObject(currentTask.metadata) };
                delete metadata.workTodoDirtyFields;
                await client.query(
                  `UPDATE tasks SET
                     sync_status = 'synced',
                     push_retry_count = 0,
                     last_synced_at = $2,
                     metadata = $3::jsonb
                   WHERE id = $1 AND updated_at = $4`,
                  [
                    change.taskId,
                    payload.processedAt,
                    JSON.stringify(metadata),
                    change.taskVersion,
                  ],
                );
              }
            } else {
              stale++;
            }
            succeeded++;
          } else {
            const status = outcome.status === 'failed' ? 'failed' : 'pending';
            await client.query(
              `UPDATE work_todo_outbound_changes SET
                 status = $2,
                 lease_id = NULL,
                 leased_at = NULL,
                 lease_expires_at = NULL,
                 last_error = $3,
                 updated_at = $4
               WHERE idempotency_key = $1
                 AND connector_id = $5
                 AND status = 'leased'
                 AND lease_id = $6`,
              [
                outcome.idempotencyKey,
                status,
                outcome.errorMessage ?? outcome.errorCode ?? outcome.status,
                now,
                connectorId,
                payload.leaseId,
              ],
            );
            const [currentTask] = await query<{ updatedAt: string }>(
              client,
              'SELECT updated_at AS "updatedAt" FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE',
              [change.taskId],
            );
            if (currentTask?.updatedAt === change.taskVersion) {
              await client.query(
                `UPDATE tasks SET sync_status = $2, push_retry_count = $3
                 WHERE id = $1 AND updated_at = $4`,
                [
                  change.taskId,
                  outcome.status === 'failed' ? 'error' : 'pending_push',
                  change.attemptCount,
                  change.taskVersion,
                ],
              );
            } else {
              stale++;
              await client.query(
                `UPDATE work_todo_outbound_changes SET
                   status = 'superseded',
                   last_error = 'Acknowledgement arrived after a newer local edit',
                   updated_at = $2
                 WHERE idempotency_key = $1 AND connector_id = $3`,
                [outcome.idempotencyKey, now, connectorId],
              );
            }
            if (outcome.status === 'failed') failed++;
            else skipped++;
          }
        }

        return { succeeded, failed, skipped, stale };
      });

      return { ...result, removedTaskIds: [...removedTaskIds] };
    },

    async readStatus(connectorId: string): Promise<WorkTodoBridgeStatus> {
      return transaction(pool, async (client) => {
        const [connector] = await query<{ type: string; enabled: boolean }>(
          client,
          `SELECT type, enabled FROM connector_configs
           WHERE id = $1 AND deleted_at IS NULL
           LIMIT 1`,
          [connectorId],
        );
        if (!connector || connector.type !== WORK_TODO_CONNECTOR_TYPE) {
          throw new WorkTodoBridgeError(
            'CONNECTOR_NOT_FOUND',
            'Work To Do connector not found',
            404,
          );
        }
        const state = await loadBridgeState(client, connectorId, false);
        const [pending] = await query<{ count: string }>(
          client,
          `SELECT count(*)::text AS count
           FROM work_todo_outbound_changes
           WHERE connector_id = $1 AND status IN ('pending', 'leased', 'failed')`,
          [connectorId],
        );
        return {
          enabled: Boolean(connector.enabled),
          initialized: Boolean(state?.lastIngestAt),
          transport: state?.transport ?? null,
          capabilityProfile: state?.capabilityProfile ?? null,
          resetRequired: Boolean(state?.resetRequired ?? false),
          lastIngestAt: state?.lastIngestAt ?? null,
          lastIngestMode: state?.lastIngestMode ?? null,
          lastError: state?.lastError ?? null,
          deltaCheckpointStored: Boolean(state?.listDeltaLink),
          pendingWriteBackCount: Number(pending?.count ?? '0'),
        };
      });
    },

    async resetDelta({ connectorId, now }): Promise<WorkTodoResetResult> {
      return transaction(pool, async (client) => {
        await assertConnector(client, connectorId, true);
        await client.query(
          `UPDATE work_todo_bridge_state SET
             list_delta_link = NULL,
             reset_required = true,
             updated_at = $2
           WHERE connector_id = $1`,
          [connectorId, now],
        );
        await client.query(
          'DELETE FROM work_todo_list_delta_state WHERE connector_id = $1',
          [connectorId],
        );
        return { resetRequired: true as const, updatedAt: now };
      });
    },
  };
}

function toLeasedChange(change: OutboundChangeRow): WorkTodoLeasedChange {
  return {
    idempotencyKey: change.idempotencyKey,
    sourceId: change.sourceId,
    listSourceId: change.listSourceId,
    remoteTaskId: change.remoteTaskId,
    operation: change.operation,
    fields: change.fields ?? null,
  };
}
