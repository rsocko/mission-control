import { randomUUID } from 'crypto';
import { and, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { fromZonedTime } from 'date-fns-tz';
import db, { runTransaction } from '@/db';
import {
  connectorConfigs,
  focusItems,
  myDayItems,
  projectAutoIncludeExclusions,
  projectPhaseItems,
  sourceLists,
  tags,
  taskAttachments,
  taskDependencies,
  taskFieldStates,
  taskProjects,
  taskSchedules,
  taskTags,
  tasks,
  workTodoBridgeState,
  workTodoListDeltaState,
  workTodoOutboundChanges,
} from '@/db/schema';
import { indexTaskSearch, removeTaskSearch } from '@/lib/search';
import { connectorLogger } from '@/lib/logger';
import { getTimezone, windowsToIanaTimezone } from '@/lib/mode';
import {
  isReminderRelativeRule,
  resolveRelativeReminderMutation,
} from '@/lib/tasks/relative-reminder';
import type { TaskPriority, TaskStatus } from '@/types';
import type { WorkTodoAck, WorkTodoIngest } from './contracts';

const CONNECTOR_TYPE = 'microsoft-todo-work';

type BridgeTask = Extract<WorkTodoIngest, { schemaVersion: '1.0' }>['lists'][number]['tasks'][number]
  | Extract<WorkTodoIngest, { schemaVersion: '1.1' }>['lists'][number]['tasks'][number];

function mapStatus(status: string): TaskStatus {
  if (status === 'completed') return 'done';
  if (status === 'inProgress') return 'in_progress';
  return 'todo';
}

function mapPriority(importance: string): TaskPriority {
  if (importance === 'high') return 'high';
  if (importance === 'low') return 'low';
  return 'none';
}

export function normalizeWorkTodoReminderAt(
  value: { dateTime: string; timeZone: string } | null | undefined,
): string | null {
  if (!value) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(value.dateTime);
  if (hasOffset) {
    const instant = new Date(value.dateTime);
    if (!Number.isFinite(instant.getTime())) {
      throw new Error(`Invalid Microsoft To Do reminder datetime "${value.dateTime}"`);
    }
    return instant.toISOString();
  }

  const timezone = windowsToIanaTimezone(value.timeZone);
  if (!timezone) {
    return `invalid-timezone:${encodeURIComponent(value.timeZone)}:${value.dateTime}`;
  }
  const instant = fromZonedTime(value.dateTime, timezone);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`Invalid Microsoft To Do reminder datetime "${value.dateTime}"`);
  }
  return instant.toISOString();
}

function remoteSourceId(listId: string, taskId: string): string {
  return `${listId}:${taskId}`;
}

function extractRemoteTaskId(sourceId: string, metadata: unknown): string {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    const value = (metadata as Record<string, unknown>).graphId;
    if (typeof value === 'string' && value) return value;
  }
  const separator = sourceId.indexOf(':');
  return separator >= 0 ? sourceId.slice(separator + 1) : sourceId;
}

function sourceTagNames(task: Exclude<BridgeTask, { removed: true }>): string[] {
  const categories = 'categories' in task && Array.isArray(task.categories)
    ? task.categories
    : [];
  const text = `${task.title} ${task.body?.content ?? ''}`
    .replace(/https?:\/\/[^\s)>\]]+/gi, ' ');
  const hashtags = [...text.matchAll(/(?:^|\s)#([\p{L}\p{N}_-]+)/gu)].map((match) => match[1]);
  return [...new Set([...categories, ...hashtags].map((name) => name.trim()).filter(Boolean))];
}

function slugifyTag(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function removeTask(
  tx: Parameters<Parameters<typeof runTransaction>[0]>[0],
  taskId: string,
  removedIds?: Set<string>,
): void {
  const children = tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.parentId, taskId)).all();
  for (const child of children) removeTask(tx, child.id, removedIds);
  tx.delete(taskTags).where(eq(taskTags.taskId, taskId)).run();
  tx.delete(projectAutoIncludeExclusions)
    .where(eq(projectAutoIncludeExclusions.taskId, taskId))
    .run();
  tx.delete(taskProjects).where(eq(taskProjects.taskId, taskId)).run();
  tx.delete(taskSchedules).where(eq(taskSchedules.taskId, taskId)).run();
  tx.delete(taskFieldStates).where(eq(taskFieldStates.taskId, taskId)).run();
  tx.delete(myDayItems).where(eq(myDayItems.taskId, taskId)).run();
  tx.delete(focusItems).where(eq(focusItems.taskId, taskId)).run();
  tx.delete(projectPhaseItems).where(eq(projectPhaseItems.taskId, taskId)).run();
  tx.delete(taskAttachments).where(eq(taskAttachments.taskId, taskId)).run();
  tx.delete(taskDependencies).where(or(
    eq(taskDependencies.taskId, taskId),
    eq(taskDependencies.dependsOnTaskId, taskId),
  )).run();
  tx.delete(tasks).where(eq(tasks.id, taskId)).run();
  // Collected rather than published inline: search index removal must happen
  // after the authoritative transaction commits, never inside it.
  removedIds?.add(taskId);
}

function assertConnector(
  tx: Parameters<Parameters<typeof runTransaction>[0]>[0],
  connectorId: string,
) {
  const connector = tx.select({
    id: connectorConfigs.id,
    type: connectorConfigs.type,
    enabled: connectorConfigs.enabled,
    deletedAt: connectorConfigs.deletedAt,
  }).from(connectorConfigs).where(eq(connectorConfigs.id, connectorId)).get();
  if (!connector || connector.deletedAt || connector.type !== CONNECTOR_TYPE) {
    throw new WorkTodoBridgeError('CONNECTOR_NOT_FOUND', 'Work To Do connector not found', 404);
  }
  if (!connector.enabled) {
    throw new WorkTodoBridgeError('CONNECTOR_DISABLED', 'Work To Do connector is disabled', 409);
  }
  return connector;
}

export class WorkTodoBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function ingestWorkTodo(payload: WorkTodoIngest) {
  const isStandard = payload.schemaVersion === '1.0';
  if (isStandard && payload.lists.some((list) => list.tasks.length >= 999)) {
    throw new WorkTodoBridgeError(
      'SNAPSHOT_MAY_BE_TRUNCATED',
      'A list returned 999 tasks; use the extended Graph bridge for reliable paging',
      409,
    );
  }

  const now = new Date().toISOString();
  const observedSourceIds = new Set<string>();
  const observedListIds = new Set<string>();
  const touchedTaskIds = new Set<string>();
  const removedTaskIds = new Set<string>();
  let created = 0;
  let updated = 0;
  let removed = 0;
  let protectedPending = 0;

  runTransaction((tx) => {
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
            removeTask(tx, task.id, removedTaskIds);
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
        const sourceId = remoteSourceId(list.id, remoteTask.id);
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
            removeTask(tx, existing.id, removedTaskIds);
            removed++;
          }
          continue;
        }

        const metadata = {
          graphId: remoteTask.id,
          listId: list.id,
          etag: 'etag' in remoteTask ? remoteTask.etag ?? null : null,
          bodyContentType: remoteTask.body?.contentType ?? 'text',
          bodyLastModifiedDateTime: 'bodyLastModifiedDateTime' in remoteTask
            ? remoteTask.bodyLastModifiedDateTime ?? null
            : null,
          remoteStatus: remoteTask.status,
          remoteImportance: remoteTask.importance,
          isOwner: list.isOwner ?? null,
          isShared: list.isShared ?? null,
          categories: 'categories' in remoteTask ? remoteTask.categories ?? [] : [],
          recurrence: 'recurrence' in remoteTask ? remoteTask.recurrence ?? null : null,
          linkedResources: 'linkedResources' in remoteTask ? remoteTask.linkedResources ?? [] : [],
          attachmentMetadata: 'attachments' in remoteTask ? remoteTask.attachments ?? [] : [],
          reminderTimeZone: remoteTask.reminderDateTime?.timeZone ?? null,
        };
        const taskId = existing?.id ?? randomUUID();
        const remoteValues = {
          title: remoteTask.title,
          description: remoteTask.body?.content ?? null,
          status: mapStatus(remoteTask.status),
          priority: mapPriority(remoteTask.importance),
          dueDate: remoteTask.dueDateTime?.dateTime.slice(0, 10) ?? null,
          completedAt: remoteTask.completedDateTime?.dateTime ?? null,
          reminderAt: remoteTask.isReminderOn
            ? normalizeWorkTodoReminderAt(remoteTask.reminderDateTime)
            : null,
        };
        if (existing && isReminderRelativeRule(existing.reminderRelative ?? '')) {
          if (remoteValues.dueDate === existing.dueDate) {
            remoteValues.reminderAt = existing.reminderAt;
          } else {
            const reminderMutation = resolveRelativeReminderMutation({
              current: existing,
              input: { dueDate: remoteValues.dueDate ?? null },
              timezone: getTimezone(),
              now: new Date(payload.syncTimestamp),
            });
            Object.assign(
              remoteValues,
              reminderMutation.success ? reminderMutation.updates : { reminderAt: null },
            );
          }
        }

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
            connectorType: CONNECTOR_TYPE,
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
          for (const tagName of sourceTagNames(remoteTask)) {
            const slug = slugifyTag(tagName);
            if (!slug) continue;
            const tagId = `${payload.connectorInstanceId}:tag:${slug}`;
            tx.insert(tags).values({
              id: tagId,
              name: tagName,
              slug,
              type: 'source',
              source: CONNECTOR_TYPE,
              confirmed: true,
              createdAt: now,
            }).onConflictDoNothing().run();
            tx.insert(taskTags).values({ taskId, tagId }).onConflictDoNothing().run();
          }
        }

        if ('checklistItems' in remoteTask && remoteTask.checklistItems) {
          const observedChecklistIds = new Set<string>();
          for (const item of remoteTask.checklistItems) {
            const childSourceId = `${sourceId}:checklist:${item.id}`;
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
            if (child) {
              tx.update(tasks).set({
                ...(child.syncStatus === 'pending_push' ? {} : childValues),
                parentId: taskId,
                metadata: {
                  graphId: remoteTask.id,
                  listId: list.id,
                  checklistItemId: item.id,
                },
                lastSyncedAt: payload.syncTimestamp,
                syncStatus: child.syncStatus === 'pending_push' ? 'pending_push' : 'synced',
              }).where(eq(tasks.id, childId)).run();
            } else {
              tx.insert(tasks).values({
                id: childId,
                sourceId: childSourceId,
                connectorType: CONNECTOR_TYPE,
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
                metadata: {
                  graphId: remoteTask.id,
                  listId: list.id,
                  checklistItemId: item.id,
                },
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
            if (!observedChecklistIds.has(child.sourceId) && child.syncStatus !== 'pending_push') {
              removeTask(tx, child.id, removedTaskIds);
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
            removeTask(tx, task.id, removedTaskIds);
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
  });

  if (touchedTaskIds.size > 0) {
    const indexedTasks = await db.select().from(tasks).where(inArray(tasks.id, [...touchedTaskIds]));
    await Promise.all(indexedTasks.map(async (task) => {
      try {
        await indexTaskSearch(task);
      } catch (error) {
        connectorLogger.error(
          { err: error, taskId: task.id, connectorId: payload.connectorInstanceId },
          'Work To Do task committed but search indexing failed',
        );
      }
    }));
  }

  for (const taskId of removedTaskIds) {
    try {
      await removeTaskSearch(taskId);
    } catch (error) {
      connectorLogger.error(
        { err: error, taskId, connectorId: payload.connectorInstanceId },
        'Work To Do task removed but search index cleanup failed',
      );
    }
  }

  return {
    connectorInstanceId: payload.connectorInstanceId,
    mode: isStandard ? 'snapshot' as const : 'delta' as const,
    created,
    updated,
    removed,
    protectedPending,
    acceptedAt: now,
  };
}

export async function leaseWorkTodoChanges(input: {
  connectorInstanceId: string;
  limit?: number;
  leaseSeconds?: number;
}) {
  const now = new Date();
  const nowIso = now.toISOString();
  const leaseId = randomUUID();
  const leaseExpiresAt = new Date(
    now.getTime() + (input.leaseSeconds ?? 300) * 1_000,
  ).toISOString();
  const limit = input.limit ?? 100;

  let responseLeaseId: string = leaseId;
  let responseLeaseExpiresAt = leaseExpiresAt;
  const changes = runTransaction((tx) => {
    assertConnector(tx, input.connectorInstanceId);
    const state = tx.select()
      .from(workTodoBridgeState)
      .where(eq(workTodoBridgeState.connectorId, input.connectorInstanceId))
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
      eq(workTodoOutboundChanges.connectorId, input.connectorInstanceId),
      eq(workTodoOutboundChanges.status, 'leased'),
      lt(workTodoOutboundChanges.leaseExpiresAt, nowIso),
    )).run();

    const activeLease = tx.select().from(workTodoOutboundChanges).where(and(
      eq(workTodoOutboundChanges.connectorId, input.connectorInstanceId),
      eq(workTodoOutboundChanges.status, 'leased'),
      gte(workTodoOutboundChanges.leaseExpiresAt, nowIso),
    )).limit(limit).all();
    if (activeLease.length > 0) {
      responseLeaseId = activeLease[0].leaseId ?? leaseId;
      responseLeaseExpiresAt = activeLease[0].leaseExpiresAt ?? leaseExpiresAt;
      return activeLease;
    }

    const pendingTasks = tx.select().from(tasks).where(and(
      eq(tasks.connectorInstanceId, input.connectorInstanceId),
      eq(tasks.syncStatus, 'pending_push'),
    )).all();

    const retryableChanges = tx.select().from(workTodoOutboundChanges).where(and(
      eq(workTodoOutboundChanges.connectorId, input.connectorInstanceId),
      or(
        eq(workTodoOutboundChanges.status, 'pending'),
        eq(workTodoOutboundChanges.status, 'failed'),
      ),
    )).all();
    const currentTaskVersions = tx.select({
      id: tasks.id,
      updatedAt: tasks.updatedAt,
    }).from(tasks).where(eq(tasks.connectorInstanceId, input.connectorInstanceId)).all();
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
      const metadata = task.metadata && typeof task.metadata === 'object'
        ? task.metadata as Record<string, unknown>
        : {};
      const listId = typeof metadata.listId === 'string'
        ? metadata.listId
        : task.sourceListId;
      if (!listId) continue;
      if (task.isChecklistItem) continue;
      const dirtyFields = Array.isArray(metadata.workTodoDirtyFields)
        ? metadata.workTodoDirtyFields.filter((field): field is string => typeof field === 'string')
        : [];
      if (dirtyFields.length === 0) continue;
      const remoteTaskId = extractRemoteTaskId(task.sourceId, metadata);
      const onlyCompletion = dirtyFields.length === 1
        && dirtyFields[0] === 'status'
        && task.status === 'done';
      const operation = onlyCompletion ? 'complete' : 'update';
      const fields = operation === 'update'
        ? Object.fromEntries(dirtyFields.flatMap((field) => {
            if (field === 'title') return [['title', task.title]];
            if (field === 'description') return [['bodyContent', task.description]];
            if (field === 'status') {
              const status = task.status === 'done'
                ? 'completed'
                : task.status === 'in_progress' ? 'inProgress' : 'notStarted';
              return [['status', status]];
            }
            if (field === 'priority') {
              const importance = task.priority === 'high' || task.priority === 'critical'
                ? 'high'
                : task.priority === 'low' ? 'low' : 'normal';
              return [['importance', importance]];
            }
            if (field === 'dueDate') return [['dueDateTime', task.dueDate]];
            return [];
          }))
        : null;
      if (operation === 'update' && Object.keys(fields ?? {}).length === 0) continue;
      tx.insert(workTodoOutboundChanges).values({
        idempotencyKey: randomUUID(),
        connectorId: input.connectorInstanceId,
        taskId: task.id,
        sourceId: task.sourceId,
        listSourceId: listId,
        remoteTaskId,
        operation,
        fields,
        taskVersion: task.updatedAt,
        status: 'pending',
        attemptCount: 0,
        createdAt: nowIso,
        updatedAt: nowIso,
      }).onConflictDoNothing().run();
    }

    const ready = tx.select().from(workTodoOutboundChanges).where(and(
      eq(workTodoOutboundChanges.connectorId, input.connectorInstanceId),
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
  });

  return {
    schemaVersion: '1.0' as const,
    connectorInstanceId: input.connectorInstanceId,
    requestedAt: nowIso,
    allowDelete: false,
    leaseId: responseLeaseId,
    leaseExpiresAt: responseLeaseExpiresAt,
    changes: changes.map((change) => ({
      idempotencyKey: change.idempotencyKey,
      sourceId: change.sourceId,
      listId: change.listSourceId,
      taskId: change.remoteTaskId,
      operation: change.operation,
      ...(change.fields ? { fields: change.fields } : {}),
    })),
  };
}

export function createWorkTodoPullRequest(connectorId: string) {
  const requestedAt = new Date().toISOString();
  return runTransaction((tx) => {
    assertConnector(tx, connectorId);
    const state = tx.select()
      .from(workTodoBridgeState)
      .where(eq(workTodoBridgeState.connectorId, connectorId))
      .get();
    if (!state) {
      throw new WorkTodoBridgeError('BRIDGE_NOT_CONFIGURED', 'Work To Do bridge state is missing', 409);
    }
    if (state.capabilityProfile === 'standard-v1') {
      return {
        schemaVersion: '1.0' as const,
        connectorInstanceId: connectorId,
        requestedAt,
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
      schemaVersion: '1.1' as const,
      connectorInstanceId: connectorId,
      requestedAt,
      ...(selectedListIds.length > 0 ? { selectedListIds } : {}),
      listDeltaLink: state.resetRequired ? null : state.listDeltaLink,
      taskDeltaLinks: Object.fromEntries(
        listStates.map((list) => [
          list.listSourceId,
          state.resetRequired ? null : list.deltaLink,
        ]),
      ),
    };
  }, { readOnly: true });
}

export async function acknowledgeWorkTodoChanges(payload: WorkTodoAck) {
  const now = new Date().toISOString();
  const removedTaskIds = new Set<string>();
  const acknowledgement = runTransaction((tx) => {
    assertConnector(tx, payload.connectorInstanceId);
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;
    let stale = 0;

    for (const result of payload.results) {
      const change = tx.select().from(workTodoOutboundChanges).where(and(
        eq(workTodoOutboundChanges.idempotencyKey, result.idempotencyKey),
        eq(workTodoOutboundChanges.connectorId, payload.connectorInstanceId),
      )).get();
      if (!change || change.sourceId !== result.sourceId) {
        throw new WorkTodoBridgeError(
          'ACK_CHANGE_NOT_FOUND',
          `No leased change matches ${result.idempotencyKey}`,
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
          `Change ${result.idempotencyKey} does not belong to this active lease`,
          409,
        );
      }

      if (result.status === 'succeeded') {
        tx.update(workTodoOutboundChanges).set({
          status: 'succeeded',
          acknowledgedAt: payload.processedAt,
          leaseId: null,
          leaseExpiresAt: null,
          lastError: null,
          updatedAt: now,
        }).where(eq(
          workTodoOutboundChanges.idempotencyKey,
          result.idempotencyKey,
        )).run();
        const currentTask = tx.select({
          id: tasks.id,
          updatedAt: tasks.updatedAt,
          metadata: tasks.metadata,
        }).from(tasks).where(eq(tasks.id, change.taskId)).get();
        if (currentTask?.updatedAt === change.taskVersion) {
          if (change.operation === 'delete') {
            removeTask(tx, change.taskId, removedTaskIds);
          } else {
            const metadata = currentTask.metadata
              && typeof currentTask.metadata === 'object'
              && !Array.isArray(currentTask.metadata)
              ? { ...currentTask.metadata as Record<string, unknown> }
              : {};
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
        const status = result.status === 'failed' ? 'failed' : 'pending';
        tx.update(workTodoOutboundChanges).set({
          status,
          leaseId: null,
          leasedAt: null,
          leaseExpiresAt: null,
          lastError: result.errorMessage ?? result.errorCode ?? result.status,
          updatedAt: now,
        }).where(eq(
          workTodoOutboundChanges.idempotencyKey,
          result.idempotencyKey,
        )).run();
        const currentTask = tx.select({
          updatedAt: tasks.updatedAt,
        }).from(tasks).where(eq(tasks.id, change.taskId)).get();
        if (currentTask?.updatedAt === change.taskVersion) {
          tx.update(tasks).set({
            syncStatus: result.status === 'failed' ? 'error' : 'pending_push',
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
            result.idempotencyKey,
          )).run();
        }
        if (result.status === 'failed') failed++;
        else skipped++;
      }
    }

    return {
      connectorInstanceId: payload.connectorInstanceId,
      succeeded,
      failed,
      skipped,
      stale,
      acknowledgedAt: payload.processedAt,
    };
  });

  for (const taskId of removedTaskIds) {
    try {
      await removeTaskSearch(taskId);
    } catch (error) {
      connectorLogger.error(
        { err: error, taskId, connectorId: payload.connectorInstanceId },
        'Work To Do task removed but search index cleanup failed',
      );
    }
  }

  return acknowledgement;
}

export async function getWorkTodoBridgeStatus(connectorId: string) {
  const [connector] = await db.select({
    id: connectorConfigs.id,
    type: connectorConfigs.type,
    enabled: connectorConfigs.enabled,
  }).from(connectorConfigs).where(and(
    eq(connectorConfigs.id, connectorId),
    isNull(connectorConfigs.deletedAt),
  ));
  if (!connector || connector.type !== CONNECTOR_TYPE) {
    throw new WorkTodoBridgeError('CONNECTOR_NOT_FOUND', 'Work To Do connector not found', 404);
  }
  const [state] = await db.select({
    transport: workTodoBridgeState.transport,
    capabilityProfile: workTodoBridgeState.capabilityProfile,
    resetRequired: workTodoBridgeState.resetRequired,
    lastIngestAt: workTodoBridgeState.lastIngestAt,
    lastIngestMode: workTodoBridgeState.lastIngestMode,
    lastError: workTodoBridgeState.lastError,
    hasListDeltaLink: workTodoBridgeState.listDeltaLink,
  }).from(workTodoBridgeState).where(eq(workTodoBridgeState.connectorId, connectorId));
  const pending = await db.select({
    id: workTodoOutboundChanges.idempotencyKey,
  }).from(workTodoOutboundChanges).where(and(
    eq(workTodoOutboundChanges.connectorId, connectorId),
    or(
      eq(workTodoOutboundChanges.status, 'pending'),
      eq(workTodoOutboundChanges.status, 'leased'),
      eq(workTodoOutboundChanges.status, 'failed'),
    ),
  ));
  return {
    connectorId,
    enabled: connector.enabled,
    initialized: Boolean(state?.lastIngestAt),
    transport: state?.transport ?? null,
    capabilityProfile: state?.capabilityProfile ?? null,
    resetRequired: state?.resetRequired ?? false,
    lastIngestAt: state?.lastIngestAt ?? null,
    lastIngestMode: state?.lastIngestMode ?? null,
    lastError: state?.lastError ?? null,
    deltaCheckpointStored: Boolean(state?.hasListDeltaLink),
    pendingWriteBackCount: pending.length,
  };
}

export function resetWorkTodoDelta(connectorId: string) {
  const now = new Date().toISOString();
  return runTransaction((tx) => {
    assertConnector(tx, connectorId);
    tx.update(workTodoBridgeState).set({
      listDeltaLink: null,
      resetRequired: true,
      updatedAt: now,
    }).where(eq(workTodoBridgeState.connectorId, connectorId)).run();
    tx.delete(workTodoListDeltaState)
      .where(eq(workTodoListDeltaState.connectorId, connectorId))
      .run();
    return { connectorId, resetRequired: true, updatedAt: now };
  });
}
