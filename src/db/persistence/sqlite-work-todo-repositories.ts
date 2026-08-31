import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  sourceLists,
  tags,
  taskTags,
  tasks,
  workTodoBridgeState,
  workTodoListDeltaState,
  workTodoOutboundChanges,
} from '@/db/schema';
import {
  WORK_TODO_DEFAULT_LEASE_SECONDS,
  WORK_TODO_MAX_CHANGE_BATCH,
  WORK_TODO_MAX_LEASE_SECONDS,
  WORK_TODO_MIN_LEASE_SECONDS,
  WorkTodoBridgeError,
  isWorkTodoCheckpointAdvance,
  staleWorkTodoIngestError,
  type WorkTodoAckCommand,
  type WorkTodoAckResult,
  type WorkTodoBridgePersistence,
  type WorkTodoBridgeStatus,
  type WorkTodoIngestCommand,
  type WorkTodoIngestResult,
  type WorkTodoLeaseCommand,
  type WorkTodoLeaseResult,
  type WorkTodoLeasedChange,
  type WorkTodoPullState,
  type WorkTodoResetResult,
  type WorkTodoSearchableTask,
} from './work-todo';
import { deleteTaskTreeWithCanonicalCleanup } from './sqlite-task-deletion';
import {
  WORK_TODO_CONNECTOR_TYPE,
  buildWorkTodoChecklistMetadata,
  buildWorkTodoOutboundChange,
  buildWorkTodoTaskMetadata,
  parseWorkTodoJsonObject,
  resolveWorkTodoRemoteValues,
  slugifyWorkTodoTag,
  workTodoChecklistSourceId,
  workTodoRemoteSourceId,
  workTodoSourceTagNames,
  type WorkTodoRemoteTaskInput,
} from './work-todo-values';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;
type SqliteTransaction = Parameters<Parameters<SqliteDrizzle['transaction']>[0]>[0];

/** Keeps the post-write searchable projection read off an unbounded IN list. */
const SEARCH_READ_BATCH = 200;

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

/**
 * SQLite adapter for the Work To Do bridge port.
 *
 * Every command owns one immediate (or deferred, for reads) transaction, and a
 * delayed envelope is rejected as `STALE_INGEST_ENVELOPE` before it mutates
 * anything. Search indexing, connector traffic, and logging stay with the
 * application service: this adapter only returns the bounded committed task IDs
 * that still need post-commit index maintenance.
 */
export function createSqliteWorkTodoRepositories(
  sqliteHandle: SqliteDatabase,
  db: SqliteDrizzle,
): WorkTodoBridgePersistence {
  function assertConnector(tx: SqliteTransaction, connectorId: string) {
    const connector = tx.select({
      id: connectorConfigs.id,
      type: connectorConfigs.type,
      enabled: connectorConfigs.enabled,
      deletedAt: connectorConfigs.deletedAt,
    }).from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)).get();
    if (!connector || connector.deletedAt || connector.type !== WORK_TODO_CONNECTOR_TYPE) {
      throw new WorkTodoBridgeError('CONNECTOR_NOT_FOUND', 'Work To Do connector not found', 404);
    }
    if (!connector.enabled) {
      throw new WorkTodoBridgeError('CONNECTOR_DISABLED', 'Work To Do connector is disabled', 409);
    }
    return connector;
  }

  /**
   * Deletes a task and its descendants using the canonical cleanup shared with
   * the core task repository and connector execution, so a Work To Do removal
   * cannot leave planning, audit, provenance, or notification references
   * behind. It must only be called from inside one of this adapter's write
   * transactions: better-sqlite3 runs every statement on the single open
   * connection, so the raw handle joins the caller's transaction.
   */
  function removeTask(taskId: string, removedIds: Set<string>): void {
    // Collected rather than published inline: search index removal must happen
    // after the authoritative transaction commits, never inside it.
    deleteTaskTreeWithCanonicalCleanup(sqliteHandle, taskId, removedIds);
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

      const observedSourceIds = new Set<string>();
      const observedListIds = new Set<string>();
      const touchedTaskIds = new Set<string>();
      const removedTaskIds = new Set<string>();
      const indexedTasks: WorkTodoSearchableTask[] = [];
      let created = 0;
      let updated = 0;
      let removed = 0;
      let protectedPending = 0;

      db.transaction((tx) => {
        assertConnector(tx, payload.connectorInstanceId);

        const existingState = tx.select()
          .from(workTodoBridgeState)
          .where(eq(workTodoBridgeState.connectorId, payload.connectorInstanceId))
          .get();
        const expectedProfile = isStandard ? 'standard-v1' : 'extended-v1';
        if (existingState && existingState.capabilityProfile !== expectedProfile) {
          throw new WorkTodoBridgeError(
            'CAPABILITY_PROFILE_MISMATCH',
            `Payload requires ${expectedProfile}, connector is ${existingState.capabilityProfile}`,
            409,
          );
        }
        // A strictly older envelope is rejected here — after the bridge-state
        // row is read under the write transaction and before any task, list,
        // tag, checklist, or removal mutation — so a delayed delivery can
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
            const listTasks = tx.select({ id: tasks.id, syncStatus: tasks.syncStatus })
              .from(tasks)
              .where(and(
                eq(tasks.connectorInstanceId, payload.connectorInstanceId),
                eq(tasks.sourceListId, list.id),
              ))
              .all();
            for (const task of listTasks) {
              if (task.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                removeTask(task.id, removedTaskIds);
                removed++;
              }
            }
            const retainedTask = listTasks.some((task) => task.syncStatus === 'pending_push');
            if (!retainedTask) {
              tx.delete(sourceLists).where(and(
                eq(sourceLists.connectorInstanceId, payload.connectorInstanceId),
                eq(sourceLists.sourceId, list.id),
              )).run();
            }
            tx.delete(workTodoListDeltaState).where(and(
              eq(workTodoListDeltaState.connectorId, payload.connectorInstanceId),
              eq(workTodoListDeltaState.listSourceId, list.id),
            )).run();
            continue;
          }

          const displayName = list.displayName;
          observedListIds.add(list.id);
          tx.insert(sourceLists).values({
            id: `${payload.connectorInstanceId}:${list.id}`,
            connectorInstanceId: payload.connectorInstanceId,
            sourceId: list.id,
            name: displayName,
            type: 'list',
            taskCount: 0,
            lastSyncedAt: payload.syncTimestamp,
            wellKnownListName: list.wellKnownListName ?? null,
            sortOrder: 0,
            hidden: false,
            lastKnownRemoteName: displayName,
          }).onConflictDoUpdate({
            target: sourceLists.id,
            set: {
              name: displayName,
              lastKnownRemoteName: displayName,
              lastSyncedAt: payload.syncTimestamp,
              wellKnownListName: list.wellKnownListName ?? null,
            },
          }).run();

          for (const remoteTask of list.tasks) {
            const sourceId = workTodoRemoteSourceId(list.id, remoteTask.id);
            observedSourceIds.add(sourceId);
            const existing = tx.select().from(tasks).where(and(
              eq(tasks.connectorInstanceId, payload.connectorInstanceId),
              eq(tasks.sourceId, sourceId),
            )).get();

            if ('removed' in remoteTask && remoteTask.removed) {
              if (!existing) continue;
              if (existing.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                removeTask(existing.id, removedTaskIds);
                removed++;
              }
              continue;
            }

            const remoteInput = remoteTask as unknown as WorkTodoRemoteTaskInput;
            const metadata = buildWorkTodoTaskMetadata(remoteInput, list);
            const taskId = existing?.id ?? randomUUID();
            const remoteValues = resolveWorkTodoRemoteValues({
              remoteTask: remoteInput,
              existing: existing ?? null,
              timezone,
              syncTimestamp: payload.syncTimestamp,
            });

            if (existing) {
              const pending = existing.syncStatus === 'pending_push';
              tx.update(tasks).set({
                ...(pending ? {} : remoteValues),
                sourceListId: list.id,
                sourceListName: displayName,
                metadata: pending ? existing.metadata : metadata,
                lastSyncedAt: payload.syncTimestamp,
                syncStatus: pending ? 'pending_push' : 'synced',
                updatedAt: pending ? existing.updatedAt : remoteTask.lastModifiedDateTime,
              }).where(eq(tasks.id, taskId)).run();
              updated++;
            } else {
              tx.insert(tasks).values({
                id: taskId,
                sourceId,
                connectorType: WORK_TODO_CONNECTOR_TYPE,
                connectorInstanceId: payload.connectorInstanceId,
                ...remoteValues,
                createdAt: remoteTask.createdDateTime,
                updatedAt: remoteTask.lastModifiedDateTime,
                sourceListId: list.id,
                sourceListName: displayName,
                metadata,
                syncStatus: 'synced',
                lastSyncedAt: payload.syncTimestamp,
                isBulkImport: true,
              }).run();
              created++;
            }
            touchedTaskIds.add(taskId);

            if (existing?.syncStatus !== 'pending_push') {
              tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
              for (const tagName of workTodoSourceTagNames(remoteInput)) {
                const slug = slugifyWorkTodoTag(tagName);
                if (!slug) continue;
                const tagId = `${payload.connectorInstanceId}:tag:${slug}`;
                tx.insert(tags).values({
                  id: tagId,
                  name: tagName,
                  slug,
                  type: 'source',
                  source: WORK_TODO_CONNECTOR_TYPE,
                  confirmed: true,
                  createdAt: now,
                }).onConflictDoNothing().run();
                tx.insert(taskTags).values({ taskId, tagId }).onConflictDoNothing().run();
              }
            }

            if ('checklistItems' in remoteTask && remoteTask.checklistItems) {
              const observedChecklistIds = new Set<string>();
              for (const item of remoteTask.checklistItems) {
                const childSourceId = workTodoChecklistSourceId(sourceId, item.id);
                observedChecklistIds.add(childSourceId);
                const child = tx.select().from(tasks).where(and(
                  eq(tasks.connectorInstanceId, payload.connectorInstanceId),
                  eq(tasks.sourceId, childSourceId),
                )).get();
                const childId = child?.id ?? randomUUID();
                const childValues = {
                  title: item.displayName,
                  status: item.isChecked ? 'done' as const : 'todo' as const,
                  completedAt: item.isChecked ? payload.syncTimestamp : null,
                };
                const childMetadata = buildWorkTodoChecklistMetadata(
                  remoteTask.id,
                  list.id,
                  item.id,
                );
                if (child) {
                  tx.update(tasks).set({
                    ...(child.syncStatus === 'pending_push' ? {} : childValues),
                    parentId: taskId,
                    metadata: childMetadata,
                    lastSyncedAt: payload.syncTimestamp,
                    syncStatus: child.syncStatus === 'pending_push' ? 'pending_push' : 'synced',
                  }).where(eq(tasks.id, childId)).run();
                } else {
                  tx.insert(tasks).values({
                    id: childId,
                    sourceId: childSourceId,
                    connectorType: WORK_TODO_CONNECTOR_TYPE,
                    connectorInstanceId: payload.connectorInstanceId,
                    ...childValues,
                    priority: 'none',
                    createdAt: remoteTask.createdDateTime,
                    updatedAt: remoteTask.lastModifiedDateTime,
                    parentId: taskId,
                    depth: 1,
                    isChecklistItem: true,
                    sourceListId: list.id,
                    sourceListName: displayName,
                    metadata: childMetadata,
                    syncStatus: 'synced',
                    lastSyncedAt: payload.syncTimestamp,
                    isBulkImport: true,
                  }).run();
                }
                touchedTaskIds.add(childId);
              }

              const existingChildren = tx.select({
                id: tasks.id,
                sourceId: tasks.sourceId,
                syncStatus: tasks.syncStatus,
              }).from(tasks).where(eq(tasks.parentId, taskId)).all();
              for (const child of existingChildren) {
                if (!observedChecklistIds.has(child.sourceId)
                  && child.syncStatus !== 'pending_push') {
                  removeTask(child.id, removedTaskIds);
                  removed++;
                }
              }
            }
          }

          if (payload.schemaVersion === '1.1' && 'taskDeltaLink' in list) {
            tx.insert(workTodoListDeltaState).values({
              connectorId: payload.connectorInstanceId,
              listSourceId: list.id,
              deltaLink: list.taskDeltaLink,
              updatedAt: now,
            }).onConflictDoUpdate({
              target: [
                workTodoListDeltaState.connectorId,
                workTodoListDeltaState.listSourceId,
              ],
              set: { deltaLink: list.taskDeltaLink, updatedAt: now },
            }).run();
          }
        }

        if (isStandard || payload.reset) {
          const currentTasks = tx.select({
            id: tasks.id,
            sourceId: tasks.sourceId,
            syncStatus: tasks.syncStatus,
          }).from(tasks).where(eq(tasks.connectorInstanceId, payload.connectorInstanceId)).all();
          for (const task of currentTasks) {
            if (task.sourceId.includes(':checklist:')) continue;
            if (!observedSourceIds.has(task.sourceId)) {
              if (task.syncStatus === 'pending_push') {
                protectedPending++;
              } else {
                removeTask(task.id, removedTaskIds);
                removed++;
              }
            }
          }
          const currentLists = tx.select({ id: sourceLists.id, sourceId: sourceLists.sourceId })
            .from(sourceLists)
            .where(eq(sourceLists.connectorInstanceId, payload.connectorInstanceId))
            .all();
          for (const list of currentLists) {
            if (observedListIds.has(list.sourceId)) continue;
            const retainedTask = tx.select({ id: tasks.id }).from(tasks).where(and(
              eq(tasks.connectorInstanceId, payload.connectorInstanceId),
              eq(tasks.sourceListId, list.sourceId),
            )).get();
            if (!retainedTask) tx.delete(sourceLists).where(eq(sourceLists.id, list.id)).run();
          }
        }

        tx.insert(workTodoBridgeState).values({
          connectorId: payload.connectorInstanceId,
          transport: isStandard ? 'power-automate-standard' : 'power-automate-graph',
          capabilityProfile: isStandard ? 'standard-v1' : 'extended-v1',
          listDeltaLink: isStandard ? null : payload.listDeltaLink,
          resetRequired: false,
          lastIngestAt: payload.syncTimestamp,
          lastIngestMode: isStandard ? 'snapshot' : 'delta',
          lastError: null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: workTodoBridgeState.connectorId,
          set: {
            listDeltaLink: isStandard ? null : payload.listDeltaLink,
            resetRequired: false,
            lastIngestAt: payload.syncTimestamp,
            lastIngestMode: isStandard ? 'snapshot' : 'delta',
            lastError: null,
            updatedAt: now,
          },
        }).run();

        // Read the committed searchable projection inside the same transaction
        // so the service indexes exactly what was written, including tasks whose
        // pending local edit was protected from the remote values.
        const survivingIds = [...touchedTaskIds].filter((id) => !removedTaskIds.has(id));
        for (let offset = 0; offset < survivingIds.length; offset += SEARCH_READ_BATCH) {
          const batch = survivingIds.slice(offset, offset + SEARCH_READ_BATCH);
          const rows = tx.select({
            id: tasks.id,
            title: tasks.title,
            description: tasks.description,
            sourceListName: tasks.sourceListName,
            connectorType: tasks.connectorType,
            status: tasks.status,
            priority: tasks.priority,
            updatedAt: tasks.updatedAt,
          }).from(tasks).where(inArray(tasks.id, batch)).all();
          for (const row of rows) indexedTasks.push(row);
        }
      }, { behavior: 'immediate' });

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

      let responseLeaseId: string = leaseId;
      let responseLeaseExpiresAt: string = leaseExpiresAt;

      const changes = db.transaction((tx) => {
        assertConnector(tx, command.connectorId);
        const state = tx.select()
          .from(workTodoBridgeState)
          .where(eq(workTodoBridgeState.connectorId, command.connectorId))
          .get();
        if (!state?.lastIngestAt) {
          throw new WorkTodoBridgeError(
            'BRIDGE_NOT_INITIALIZED',
            'Connector must accept an inbound baseline before write-back',
            409,
          );
        }

        tx.update(workTodoOutboundChanges).set({
          status: 'pending',
          leaseId: null,
          leasedAt: null,
          leaseExpiresAt: null,
          updatedAt: nowIso,
        }).where(and(
          eq(workTodoOutboundChanges.connectorId, command.connectorId),
          eq(workTodoOutboundChanges.status, 'leased'),
          lt(workTodoOutboundChanges.leaseExpiresAt, nowIso),
        )).run();

        const activeLease = tx.select().from(workTodoOutboundChanges).where(and(
          eq(workTodoOutboundChanges.connectorId, command.connectorId),
          eq(workTodoOutboundChanges.status, 'leased'),
          gte(workTodoOutboundChanges.leaseExpiresAt, nowIso),
        )).limit(limit).all();
        if (activeLease.length > 0) {
          responseLeaseId = activeLease[0].leaseId ?? leaseId;
          responseLeaseExpiresAt = activeLease[0].leaseExpiresAt ?? leaseExpiresAt;
          return activeLease;
        }

        const pendingTasks = tx.select().from(tasks).where(and(
          eq(tasks.connectorInstanceId, command.connectorId),
          eq(tasks.syncStatus, 'pending_push'),
        )).all();

        const retryableChanges = tx.select().from(workTodoOutboundChanges).where(and(
          eq(workTodoOutboundChanges.connectorId, command.connectorId),
          or(
            eq(workTodoOutboundChanges.status, 'pending'),
            eq(workTodoOutboundChanges.status, 'failed'),
          ),
        )).all();
        const currentTaskVersions = tx.select({
          id: tasks.id,
          updatedAt: tasks.updatedAt,
        }).from(tasks).where(eq(tasks.connectorInstanceId, command.connectorId)).all();
        const versionsByTask = new Map(
          currentTaskVersions.map((task) => [task.id, task.updatedAt]),
        );
        const supersededKeys = retryableChanges
          .filter((change) => versionsByTask.get(change.taskId) !== change.taskVersion)
          .map((change) => change.idempotencyKey);
        if (supersededKeys.length > 0) {
          tx.update(workTodoOutboundChanges).set({
            status: 'superseded',
            lastError: 'Superseded by a newer local edit',
            updatedAt: nowIso,
          }).where(inArray(workTodoOutboundChanges.idempotencyKey, supersededKeys)).run();
        }

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
          tx.insert(workTodoOutboundChanges).values({
            idempotencyKey: randomUUID(),
            connectorId: command.connectorId,
            taskId: draft.taskId,
            sourceId: draft.sourceId,
            listSourceId: draft.listSourceId,
            remoteTaskId: draft.remoteTaskId,
            operation: draft.operation,
            fields: draft.fields,
            taskVersion: draft.taskVersion,
            status: 'pending',
            attemptCount: 0,
            createdAt: nowIso,
            updatedAt: nowIso,
          }).onConflictDoNothing().run();
        }

        const ready = tx.select().from(workTodoOutboundChanges).where(and(
          eq(workTodoOutboundChanges.connectorId, command.connectorId),
          or(
            eq(workTodoOutboundChanges.status, 'pending'),
            eq(workTodoOutboundChanges.status, 'failed'),
          ),
        )).limit(limit).all();

        if (ready.length > 0) {
          tx.update(workTodoOutboundChanges).set({
            status: 'leased',
            leaseId,
            leasedAt: nowIso,
            leaseExpiresAt,
            attemptCount: sql`${workTodoOutboundChanges.attemptCount} + 1`,
            updatedAt: nowIso,
          }).where(inArray(
            workTodoOutboundChanges.idempotencyKey,
            ready.map((change) => change.idempotencyKey),
          )).run();
        }
        return ready;
      }, { behavior: 'immediate' });

      return {
        leaseId: responseLeaseId,
        leaseExpiresAt: responseLeaseExpiresAt,
        changes: changes.map((change): WorkTodoLeasedChange => ({
          idempotencyKey: change.idempotencyKey,
          sourceId: change.sourceId,
          listSourceId: change.listSourceId,
          remoteTaskId: change.remoteTaskId,
          operation: change.operation,
          fields: change.fields ?? null,
        })),
      };
    },

    async readPullState(connectorId: string): Promise<WorkTodoPullState> {
      return db.transaction((tx) => {
        assertConnector(tx, connectorId);
        const state = tx.select()
          .from(workTodoBridgeState)
          .where(eq(workTodoBridgeState.connectorId, connectorId))
          .get();
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
        const listStates = tx.select()
          .from(workTodoListDeltaState)
          .where(eq(workTodoListDeltaState.connectorId, connectorId))
          .all();
        const selectedListIds = tx.select({ sourceId: sourceLists.sourceId })
          .from(sourceLists)
          .where(and(
            eq(sourceLists.connectorInstanceId, connectorId),
            eq(sourceLists.hidden, false),
          ))
          .all()
          .map((list) => list.sourceId);
        return {
          capabilityProfile: 'extended-v1' as const,
          resetRequired: Boolean(state.resetRequired),
          listDeltaLink: state.listDeltaLink ?? null,
          selectedListIds,
          taskDeltaLinks: listStates.map((list) => ({
            listSourceId: list.listSourceId,
            deltaLink: list.deltaLink ?? null,
          })),
        };
      }, { behavior: 'deferred' });
    },

    async acknowledge(command: WorkTodoAckCommand): Promise<WorkTodoAckResult> {
      const { payload, now } = command;
      const removedTaskIds = new Set<string>();
      const result = db.transaction((tx) => {
        assertConnector(tx, payload.connectorInstanceId);
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;
        let stale = 0;

        for (const outcome of payload.results.slice(0, WORK_TODO_MAX_CHANGE_BATCH)) {
          const change = tx.select().from(workTodoOutboundChanges).where(and(
            eq(workTodoOutboundChanges.idempotencyKey, outcome.idempotencyKey),
            eq(workTodoOutboundChanges.connectorId, payload.connectorInstanceId),
          )).get();
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
            tx.update(workTodoOutboundChanges).set({
              status: 'succeeded',
              acknowledgedAt: payload.processedAt,
              leaseId: null,
              leaseExpiresAt: null,
              lastError: null,
              updatedAt: now,
            }).where(eq(
              workTodoOutboundChanges.idempotencyKey,
              outcome.idempotencyKey,
            )).run();
            const currentTask = tx.select({
              id: tasks.id,
              updatedAt: tasks.updatedAt,
              metadata: tasks.metadata,
            }).from(tasks).where(eq(tasks.id, change.taskId)).get();
            if (currentTask?.updatedAt === change.taskVersion) {
              if (change.operation === 'delete') {
                removeTask(change.taskId, removedTaskIds);
              } else {
                const metadata = { ...parseWorkTodoJsonObject(currentTask.metadata) };
                delete metadata.workTodoDirtyFields;
                tx.update(tasks).set({
                  syncStatus: 'synced',
                  pushRetryCount: 0,
                  lastSyncedAt: payload.processedAt,
                  metadata,
                }).where(eq(tasks.id, change.taskId)).run();
              }
            } else {
              stale++;
            }
            succeeded++;
          } else {
            const status = outcome.status === 'failed' ? 'failed' : 'pending';
            tx.update(workTodoOutboundChanges).set({
              status,
              leaseId: null,
              leasedAt: null,
              leaseExpiresAt: null,
              lastError: outcome.errorMessage ?? outcome.errorCode ?? outcome.status,
              updatedAt: now,
            }).where(eq(
              workTodoOutboundChanges.idempotencyKey,
              outcome.idempotencyKey,
            )).run();
            const currentTask = tx.select({
              updatedAt: tasks.updatedAt,
            }).from(tasks).where(eq(tasks.id, change.taskId)).get();
            if (currentTask?.updatedAt === change.taskVersion) {
              tx.update(tasks).set({
                syncStatus: outcome.status === 'failed' ? 'error' : 'pending_push',
                pushRetryCount: change.attemptCount,
              }).where(eq(tasks.id, change.taskId)).run();
            } else {
              stale++;
              tx.update(workTodoOutboundChanges).set({
                status: 'superseded',
                lastError: 'Acknowledgement arrived after a newer local edit',
                updatedAt: now,
              }).where(eq(
                workTodoOutboundChanges.idempotencyKey,
                outcome.idempotencyKey,
              )).run();
            }
            if (outcome.status === 'failed') failed++;
            else skipped++;
          }
        }

        return { succeeded, failed, skipped, stale };
      }, { behavior: 'immediate' });

      return { ...result, removedTaskIds: [...removedTaskIds] };
    },

    async readStatus(connectorId: string): Promise<WorkTodoBridgeStatus> {
      return db.transaction((tx) => {
        const connector = tx.select({
          id: connectorConfigs.id,
          type: connectorConfigs.type,
          enabled: connectorConfigs.enabled,
        }).from(connectorConfigs).where(and(
          eq(connectorConfigs.id, connectorId),
          isNull(connectorConfigs.deletedAt),
        )).get();
        if (!connector || connector.type !== WORK_TODO_CONNECTOR_TYPE) {
          throw new WorkTodoBridgeError(
            'CONNECTOR_NOT_FOUND',
            'Work To Do connector not found',
            404,
          );
        }
        const state = tx.select({
          transport: workTodoBridgeState.transport,
          capabilityProfile: workTodoBridgeState.capabilityProfile,
          resetRequired: workTodoBridgeState.resetRequired,
          lastIngestAt: workTodoBridgeState.lastIngestAt,
          lastIngestMode: workTodoBridgeState.lastIngestMode,
          lastError: workTodoBridgeState.lastError,
          hasListDeltaLink: workTodoBridgeState.listDeltaLink,
        }).from(workTodoBridgeState)
          .where(eq(workTodoBridgeState.connectorId, connectorId))
          .get();
        const pending = tx.select({
          count: sql<number>`count(*)`,
        }).from(workTodoOutboundChanges).where(and(
          eq(workTodoOutboundChanges.connectorId, connectorId),
          inArray(workTodoOutboundChanges.status, ['pending', 'leased', 'failed']),
        )).get();
        return {
          enabled: Boolean(connector.enabled),
          initialized: Boolean(state?.lastIngestAt),
          transport: state?.transport ?? null,
          capabilityProfile: state?.capabilityProfile ?? null,
          resetRequired: Boolean(state?.resetRequired ?? false),
          lastIngestAt: state?.lastIngestAt ?? null,
          lastIngestMode: state?.lastIngestMode ?? null,
          lastError: state?.lastError ?? null,
          deltaCheckpointStored: Boolean(state?.hasListDeltaLink),
          pendingWriteBackCount: Number(pending?.count ?? 0),
        };
      }, { behavior: 'deferred' });
    },

    async resetDelta({ connectorId, now }): Promise<WorkTodoResetResult> {
      return db.transaction((tx) => {
        assertConnector(tx, connectorId);
        tx.update(workTodoBridgeState).set({
          listDeltaLink: null,
          resetRequired: true,
          updatedAt: now,
        }).where(eq(workTodoBridgeState.connectorId, connectorId)).run();
        tx.delete(workTodoListDeltaState)
          .where(eq(workTodoListDeltaState.connectorId, connectorId))
          .run();
        return { resetRequired: true as const, updatedAt: now };
      }, { behavior: 'immediate' });
    },
  };
}
