import { NextResponse } from 'next/server';
import db from '@/db';
import {
  connectorConfigs,
  myDayExclusions,
  myDayItems,
  syncDeletionSnapshots,
  tasks,
} from '@/db/schema';
import { eq, and, like, isNull, inArray, ne } from 'drizzle-orm';
import { MicrosoftTodoConnector } from '@/lib/connectors/microsoft-todo';
import type { ConnectorConfig } from '@/types';
import {
  getLocalDateBoundsISO,
  getLocalToday,
  isTimestampWithinBounds,
} from '@/lib/utils/date';
import logger from '@/lib/logger';
import {
  getRecurringTitleKey,
  inferRecurringTitleKeys,
  isMatchingRecurringSuccessor,
  shouldSuppressRecurringMyDaySuccessor,
} from '@/lib/sync/recurring-task-reconciliation';
import { parseSubstrateRecurrence } from '@/lib/connectors/microsoft-todo/task-transformer';
import {
  appendPlanningSignal,
  finalizePlanningSignals,
  finalizePlanningSignalsIfDue,
} from '@/lib/planning-signals';

const MAX_REMOTE_MY_DAY_TASKS = 2_000;
const MY_DAY_QUERY_BATCH_SIZE = 400;
const MY_DAY_SYNC_TIMEOUT_MS = 30_000;
type MyDayFlightStats = { coalescedCallers: number };
const myDaySyncFlights = new Map<string, {
  promise: Promise<NextResponse>;
  stats: MyDayFlightStats;
}>();

/**
 * POST /api/my-day/sync — Sync My Day from Microsoft Todo via Substrate API.
 * 
 * Reads the actual My Day tasks from the substrate.office.com endpoint
 * (same API the web/mobile apps use) and reconciles with our local state.
 * 
 * - Tasks in remote My Day but not local → auto-add
 * - Tasks in local My Day but not remote → remove (only auto-included ones)
 * - Also fetches Microsoft's suggested tasks for our suggestions panel
 */
export async function POST(request: Request) {
  let today = getLocalToday();
  try {
    try {
      const body = await request.json();
      if (body?.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
        today = body.date;
      }
    } catch {
      // No body or invalid JSON — use server-computed date
    }

    const existing = myDaySyncFlights.get(today);
    if (existing) {
      existing.stats.coalescedCallers++;
      logger.info({ date: today }, 'Coalesced concurrent My Day reconciliation');
      return (await existing.promise).clone();
    }
    const stats: MyDayFlightStats = { coalescedCallers: 0 };
    const operation = reconcileMyDay(today, stats);
    myDaySyncFlights.set(today, { promise: operation, stats });
    try {
      return (await operation).clone();
    } finally {
      if (myDaySyncFlights.get(today)?.promise === operation) myDaySyncFlights.delete(today);
    }
  } catch (error) {
    logger.error({ err: error, date: today }, 'My Day sync failed');
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `My Day sync failed: ${message}` },
      { status: 500 }
    );
  }
}

async function reconcileMyDay(
  today: string,
  flightStats: MyDayFlightStats,
): Promise<NextResponse> {
  const startedAt = Date.now();
  try {
    try {
      finalizePlanningSignalsIfDue();
    } catch (error) {
      logger.warn({ err: error }, 'Planning signal finalization will retry later');
    }
    // Find the Microsoft Todo connector config from DB
    const [config] = await db.select()
      .from(connectorConfigs)
      .where(and(
        eq(connectorConfigs.type, 'microsoft-todo'),
        eq(connectorConfigs.enabled, true),
        isNull(connectorConfigs.deletedAt)
      ));

    if (!config) {
      return NextResponse.json(
        { message: 'No Microsoft Todo connector configured', synced: 0 },
        { status: 200 }
      );
    }

    // Initialize connector
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config as unknown as ConnectorConfig);

    // Fetch My Day tasks from substrate API
    let remoteTasks: Awaited<ReturnType<typeof connector.fetchMyDayTasks>> = [];
    let remoteSuggestions: Awaited<ReturnType<typeof connector.fetchMyDaySuggestions>> = [];
    try {
      remoteTasks = await withTimeout(
        connector.fetchMyDayTasks(today),
        MY_DAY_SYNC_TIMEOUT_MS,
        'Microsoft To Do My Day request timed out',
      );
      if (remoteTasks.length > MAX_REMOTE_MY_DAY_TASKS) {
        const message = `Microsoft To Do returned ${remoteTasks.length} My Day tasks; the limit is ${MAX_REMOTE_MY_DAY_TASKS}`;
        logger.error({ remoteTaskCount: remoteTasks.length, date: today }, message);
        return NextResponse.json(
          { error: message, synced: 0 },
          { status: 502 },
        );
      }
      logger.info({ remoteTaskCount: remoteTasks.length, date: today }, 'Fetched remote My Day tasks');
    } catch (subErr) {
      const message = subErr instanceof Error ? subErr.message : String(subErr);
      logger.error({ err: subErr, date: today }, 'Failed to fetch My Day tasks from Substrate');
      return NextResponse.json({ error: message, synced: 0 }, { status: 502 });
    }

    let substrateError = '';
    try {
      remoteSuggestions = await withTimeout(
        connector.fetchMyDaySuggestions(),
        MY_DAY_SYNC_TIMEOUT_MS,
        'Microsoft To Do suggestions request timed out',
      );
    } catch (subErr) {
      substrateError = subErr instanceof Error ? subErr.message : String(subErr);
      logger.error({ err: subErr, date: today }, 'Failed to fetch My Day suggestions from Substrate');
    }

    // Get our local My Day items for today
    const localItems = await db.select({
      id: myDayItems.id,
      taskId: myDayItems.taskId,
      sourceId: tasks.sourceId,
      isAutoIncluded: myDayItems.isAutoIncluded,
      status: tasks.status,
      completedAt: tasks.completedAt,
    })
      .from(myDayItems)
      .innerJoin(tasks, eq(myDayItems.taskId, tasks.id))
      .where(eq(myDayItems.date, today));

    // Build lookup of local sourceIds that are already in My Day
    const localSourceIds = new Set(localItems.map(i => i.sourceId).filter(Boolean));
    const localMyDayItemsBySourceId = new Map(
      localItems.flatMap(item => item.sourceId ? [[item.sourceId, item] as const] : []),
    );

    // Load user-excluded task IDs for today (tasks the user explicitly removed)
    const exclusionRows = await db.select({ taskId: myDayExclusions.taskId })
      .from(myDayExclusions)
      .where(eq(myDayExclusions.date, today));
    const excludedTaskIds = new Set(exclusionRows.map(r => r.taskId));

    const recurringHistory = await db.select({
      title: tasks.title,
      sourceListId: tasks.sourceListId,
      status: tasks.status,
      dueDate: tasks.dueDate,
      completedAt: tasks.completedAt,
      metadata: tasks.metadata,
    })
      .from(tasks)
      .where(and(
        eq(tasks.connectorInstanceId, config.id),
        eq(tasks.depth, 0),
      ));
    const knownRecurringTitleKeys = inferRecurringTitleKeys(recurringHistory);
    const archivedDuplicateRows = await db.select({ sourceId: syncDeletionSnapshots.sourceId })
      .from(syncDeletionSnapshots)
      .where(and(
        eq(syncDeletionSnapshots.connectorId, config.id),
        like(syncDeletionSnapshots.reason, 'Duplicate open Microsoft To Do recurrence%'),
      ));
    const archivedDuplicateSourceIds = new Set(archivedDuplicateRows.map(row => row.sourceId));
    const suppressedArchivedSourceIds = new Set(
      remoteTasks.flatMap((task) => {
        const sourceId = `${task.ParentFolderId}:${task.Id}`;
        return archivedDuplicateSourceIds.has(sourceId)
          && knownRecurringTitleKeys.has(getRecurringTitleKey({
            title: task.Subject,
            sourceListId: task.ParentFolderId,
          }))
          ? [sourceId]
          : [];
      }),
    );

    // Map non-suppressed remote tasks to their sourceIds (format: listId:taskId)
    // Substrate uses ParentFolderId as listId and Id as taskId
    const remoteSourceIds = new Set(
      remoteTasks
        .map(t => `${t.ParentFolderId}:${t.Id}`)
        .filter(sourceId => !suppressedArchivedSourceIds.has(sourceId))
    );
    const localTasksBySourceId = new Map<string, {
      id: string;
      sourceId: string;
      metadata: unknown;
      status: string;
    }>();
    const remoteSourceIdList = [...remoteSourceIds];
    for (let index = 0; index < remoteSourceIdList.length; index += MY_DAY_QUERY_BATCH_SIZE) {
      const rows = await db.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        metadata: tasks.metadata,
        status: tasks.status,
      })
        .from(tasks)
        .where(and(
          eq(tasks.connectorType, 'microsoft-todo'),
          eq(tasks.connectorInstanceId, config.id),
          inArray(tasks.sourceId, remoteSourceIdList.slice(index, index + MY_DAY_QUERY_BATCH_SIZE)),
        ));
      for (const row of rows) {
        if (row.sourceId) localTasksBySourceId.set(row.sourceId, {
          id: row.id,
          sourceId: row.sourceId,
          metadata: row.metadata,
          status: row.status,
        });
      }
    }
    const completedSiblingRows = await db.select({
      sourceListId: tasks.sourceListId,
      title: tasks.title,
      completedAt: tasks.completedAt,
      metadata: tasks.metadata,
    })
      .from(tasks)
      .innerJoin(myDayItems, eq(myDayItems.taskId, tasks.id))
      .where(and(
        eq(tasks.connectorType, 'microsoft-todo'),
        eq(tasks.connectorInstanceId, config.id),
        eq(tasks.status, 'done'),
        eq(myDayItems.date, today),
      ));
    const completedSiblings = new Map(
      completedSiblingRows.map((row) => [
        recurringSiblingKey(row.sourceListId, row.title),
        row,
      ]),
    );

    let added = 0;
    let removed = 0;
    const myDayRowsToInsert: Array<typeof myDayItems.$inferInsert> = [];
    const myDayIdsToRemove: string[] = [];
    const suppressedRecurringSourceIds = new Set<string>();

    // Add tasks that are in remote My Day but not locally
    let created = 0;
    let skippedFutureRecurring = 0;
    let skippedArchivedRecurring = 0;
    for (const remoteTask of remoteTasks) {
      const sourceId = `${remoteTask.ParentFolderId}:${remoteTask.Id}`;
      if (suppressedArchivedSourceIds.has(sourceId)) {
        skippedArchivedRecurring++;
        continue;
      }

      // Skip recurring tasks whose due date is strictly after today.
      // When a recurring task is completed, MS Todo creates the next occurrence
      // and often auto-adds it to My Day. We don't want that next instance to
      // reappear in today's view — it should surface when its due date arrives.
      const remoteDueDate = remoteTask.DueDateTime?.DateTime?.split('T')[0];

      // Determine if this remote task is recurring — either from Substrate's Recurrence
      // field, or by checking our local DB for known recurrence metadata.
      const isRecurringFromRemote = !!remoteTask.Recurrence;
      let localRecurrencePattern: string | null = null;
      if (!isRecurringFromRemote) {
        const recurrenceCheck = localTasksBySourceId.get(sourceId);
        if (recurrenceCheck) {
          try {
            const meta = typeof recurrenceCheck.metadata === 'string'
              ? JSON.parse(recurrenceCheck.metadata)
              : recurrenceCheck.metadata || {};
            localRecurrencePattern = typeof meta.recurrence === 'string' ? meta.recurrence : null;
          } catch { /* ignore */ }
        }
      }

      const recurrencePattern = parseSubstrateRecurrence(remoteTask.Recurrence) || localRecurrencePattern;
      const isRecurring = !!recurrencePattern;

      let successorCreatedAfterMyDayCompletion = false;
      if (isRecurring) {
        const completedSibling = completedSiblings.get(
          recurringSiblingKey(remoteTask.ParentFolderId, remoteTask.Subject),
        );
        successorCreatedAfterMyDayCompletion = isMatchingRecurringSuccessor({
          incomingRecurrence: recurrencePattern,
          completedSiblingMetadata: completedSibling?.metadata,
          successorCreatedAt: remoteTask.CreatedDateTime,
          completedAt: completedSibling?.completedAt || null,
        });
      }

      if (shouldSuppressRecurringMyDaySuccessor({
        isRecurring,
        dueDate: remoteDueDate,
        today,
        successorCreatedAfterMyDayCompletion,
      })) {
        skippedFutureRecurring++;
        suppressedRecurringSourceIds.add(sourceId);
        const existingMyDayItem = localMyDayItemsBySourceId.get(sourceId);
        if (existingMyDayItem?.isAutoIncluded) {
          myDayIdsToRemove.push(existingMyDayItem.id);
        }
        logger.info(
          { title: remoteTask.Subject, remoteDueDate, date: today, successorCreatedAfterMyDayCompletion },
          'Skipping Microsoft To Do recurring successor in My Day',
        );
        continue;
      }
      if (localSourceIds.has(sourceId)) continue;

      // Find matching task in our DB by sourceId
      let localTask = localTasksBySourceId.get(sourceId);

      // If not in DB, create a minimal task record from substrate data
      // But skip future-dated tasks — let the main sync handle those properly
      // (they'll get recurrence metadata, tags, etc.)
      if (!localTask) {
        if (remoteTask.Status === 'Completed') continue; // Skip completed tasks
        if (remoteDueDate && remoteDueDate > today) {
          skippedFutureRecurring++;
          logger.info({ title: remoteTask.Subject, remoteDueDate }, 'Skipping future My Day task not yet in the database');
          continue;
        }
        const newTaskId = crypto.randomUUID();
        const now = new Date().toISOString();
        try {
          const dueDateStr = remoteTask.DueDateTime?.DateTime
            ? remoteTask.DueDateTime.DateTime.split('T')[0]
            : null;
          const insertResult = await db.insert(tasks).values({
            id: newTaskId,
            sourceId,
            connectorType: 'microsoft-todo',
            connectorInstanceId: config.id,
            title: remoteTask.Subject,
            description: null,
            status: 'todo',
            priority: remoteTask.Importance === 'High' ? 'high' : 'none',
            dueDate: dueDateStr,
            createdAt: remoteTask.CreatedDateTime || now,
            updatedAt: remoteTask.LastModifiedDateTime || now,
            completedAt: null,
            parentId: null,
            depth: 0,
            isChecklistItem: false,
            sourceListId: remoteTask.ParentFolderId || null,
            sourceListName: null,
            assignee: null,
            metadata: JSON.stringify({}),
            syncStatus: 'synced' as const,
            lastSyncedAt: now,
          }).onConflictDoNothing();
          if (insertResult.changes > 0) {
            localTask = { id: newTaskId, sourceId, metadata: {}, status: 'todo' };
            localTasksBySourceId.set(sourceId, localTask);
            created++;
          }
        } catch (insertErr) {
          logger.error({ err: insertErr, title: remoteTask.Subject }, 'Failed to insert My Day task');
          continue; // Skip this task but keep syncing others
        }
        if (!localTask) {
          [localTask] = await db.select({
            id: tasks.id,
            sourceId: tasks.sourceId,
            metadata: tasks.metadata,
            status: tasks.status,
          })
            .from(tasks)
            .where(and(
              eq(tasks.sourceId, sourceId),
              eq(tasks.connectorInstanceId, config.id),
            ))
            .limit(1);
        }
        if (!localTask) {
          logger.error({ title: remoteTask.Subject, sourceId }, 'My Day task insert did not produce a local task');
          continue;
        }
      }

      if (localTask.status === 'cancelled') continue;

      // Check if already in My Day (by taskId)
      const existing = localItems.find(i => i.taskId === localTask.id);
      if (existing) continue;

      // Skip if user explicitly removed this task from My Day today
      if (excludedTaskIds.has(localTask.id)) continue;

      // Add to My Day
      myDayRowsToInsert.push({
        id: `md-sync-${crypto.randomUUID().slice(0, 8)}`,
        taskId: localTask.id,
        date: today,
        addedAt: new Date().toISOString(),
        isAutoIncluded: true,
        order: localItems.length + myDayRowsToInsert.length + 1,
      });
    }
    added = await insertMyDayRows(myDayRowsToInsert);
    for (const item of myDayRowsToInsert) {
      appendPlanningSignal({
        taskId: item.taskId,
        eventType: 'my_day_committed',
        date: today,
        occurredAt: item.addedAt,
        provenance: 'microsoft-todo-substrate',
        metadata: { origin: 'remote-observed' },
      });
    }

    // Remove tasks that are no longer in remote My Day
    // Only remove auto-included ones (preserve user-added items)
    // But DON'T remove due-today items — they're auto-included locally
    // Remote-dependent cleanup is skipped when remote returns an empty set.
    // Auto-included cancellations are still safe to remove after a successful fetch.
    for (const localItem of localItems) {
      if (localItem.status === 'cancelled' && localItem.isAutoIncluded) {
        myDayIdsToRemove.push(localItem.id);
      }
    }

    if (remoteTasks.length > 0) {
      const { dayStart, nextDayStart } = getLocalDateBoundsISO(today);
      const dueTodayTaskIds = new Set(
        (await db.select({ id: tasks.id })
          .from(tasks)
          .where(
            and(
              eq(tasks.connectorType, 'microsoft-todo'),
              like(tasks.dueDate, `${today}%`),
              ne(tasks.status, 'done'),
              ne(tasks.status, 'cancelled'),
            )
          )).map(t => t.id)
      );

      for (const localItem of localItems) {
        if (localItem.status === 'cancelled') continue;
        if (!localItem.sourceId) continue;
        if (remoteSourceIds.has(localItem.sourceId)) continue;
        if (dueTodayTaskIds.has(localItem.taskId)) continue; // Keep due-today items
        if (
          localItem.status === 'done'
          && localItem.completedAt
          && isTimestampWithinBounds(localItem.completedAt, dayStart, nextDayStart)
        ) {
          continue;
        }

        if (localItem.isAutoIncluded) {
          myDayIdsToRemove.push(localItem.id);
        }
      }
    }
    const localItemsById = new Map(localItems.map(item => [item.id, item]));
    const withdrawnAt = new Date().toISOString();
    for (const itemId of myDayIdsToRemove) {
      const item = localItemsById.get(itemId);
      if (!item) continue;
      appendPlanningSignal({
        taskId: item.taskId,
        eventType: 'my_day_withdrawn',
        date: today,
        occurredAt: withdrawnAt,
        provenance: 'microsoft-todo-substrate',
        metadata: { origin: 'remote-observed' },
      });
    }
    for (let index = 0; index < myDayIdsToRemove.length; index += MY_DAY_QUERY_BATCH_SIZE) {
      const result = await db.delete(myDayItems).where(
        inArray(myDayItems.id, myDayIdsToRemove.slice(index, index + MY_DAY_QUERY_BATCH_SIZE)),
      );
      removed += result.changes;
    }

    // Also auto-include tasks due today that aren't already in My Day
    // (mimics Microsoft Todo's behavior of showing due-today tasks in My Day)
    let dueTodayAdded = 0;
    const dueTodayRows: Array<typeof myDayItems.$inferInsert> = [];
    const dueTodayTasks = await db.select({ id: tasks.id, sourceId: tasks.sourceId, status: tasks.status })
      .from(tasks)
      .where(
        and(
          eq(tasks.connectorType, 'microsoft-todo'),
          eq(tasks.connectorInstanceId, config.id),
          like(tasks.dueDate, `${today}%`),
          ne(tasks.status, 'done'),
          ne(tasks.status, 'cancelled'),
        )
      );

    const existingMyDayTaskIds = new Set(
      (await db.select({ taskId: myDayItems.taskId })
        .from(myDayItems)
        .where(eq(myDayItems.date, today))
      ).map(r => r.taskId)
    );

    for (const dueTodayTask of dueTodayTasks) {
      if (dueTodayTask.sourceId && suppressedRecurringSourceIds.has(dueTodayTask.sourceId)) continue;
      if (existingMyDayTaskIds.has(dueTodayTask.id)) continue;
      if (excludedTaskIds.has(dueTodayTask.id)) continue; // Skip user-removed
      dueTodayRows.push({
        id: `md-due-${crypto.randomUUID().slice(0, 8)}`,
        taskId: dueTodayTask.id,
        date: today,
        addedAt: new Date().toISOString(),
        isAutoIncluded: true,
        order: localItems.length + added + dueTodayRows.length + 1,
      });
    }
    dueTodayAdded = await insertMyDayRows(dueTodayRows);
    const historicalObserved = await observeRecentRemoteMyDay(
      connector,
      config.id,
      today,
    );
    if (historicalObserved > 0) {
      try {
        finalizePlanningSignals();
      } catch (error) {
        logger.warn({ err: error }, 'Historical planning signals will finalize later');
      }
    }

    const result = {
      synced: true,
      added,
      removed,
      created,
      dueTodayAdded,
      historicalObserved,
      skippedFutureRecurring,
      skippedArchivedRecurring,
      remoteCount: remoteTasks.length,
      substrateError: substrateError || undefined,
      suggestedCount: remoteSuggestions.length,
      suggestions: remoteSuggestions.map(t => ({
        subject: t.Subject,
        sourceId: `${t.ParentFolderId}:${t.Id}`,
        importance: t.Importance,
        dueDateTime: t.DueDateTime,
      })),
    };
    logger.info({
      date: today,
      remoteCount: remoteTasks.length,
      localTaskQueryBatches: Math.ceil(remoteSourceIds.size / MY_DAY_QUERY_BATCH_SIZE),
      coalescedCallers: flightStats.coalescedCallers,
      durationMs: Date.now() - startedAt,
      mutations: { added, removed, created, dueTodayAdded, skippedArchivedRecurring },
    }, 'Completed My Day reconciliation');
    return NextResponse.json(result);
  } catch (error) {
    logger.error({
      err: error,
      date: today,
      coalescedCallers: flightStats.coalescedCallers,
      durationMs: Date.now() - startedAt,
    }, 'My Day sync failed');
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { error: `My Day sync failed: ${message}` },
      { status: 500 }
    );
  }
}

async function observeRecentRemoteMyDay(
  connector: MicrosoftTodoConnector,
  connectorInstanceId: string,
  today: string,
): Promise<number> {
  const observedDates: string[] = [];
  const cursor = new Date(`${today}T12:00:00Z`);
  for (let daysAgo = 1; daysAgo <= 3; daysAgo++) {
    cursor.setUTCDate(cursor.getUTCDate() - 1);
    observedDates.push(cursor.toISOString().slice(0, 10));
  }

  let observed = 0;
  for (const date of observedDates) {
    let remoteTasks: Awaited<ReturnType<MicrosoftTodoConnector['fetchMyDayTasks']>>;
    try {
      remoteTasks = await withTimeout(
        connector.fetchMyDayTasks(date),
        MY_DAY_SYNC_TIMEOUT_MS,
        `Microsoft To Do historical My Day request timed out for ${date}`,
      );
    } catch (error) {
      logger.warn({ err: error, date }, 'Skipped historical My Day observation');
      continue;
    }
    if (remoteTasks.length === 0 || remoteTasks.length > MAX_REMOTE_MY_DAY_TASKS) continue;

    const sourceIds = remoteTasks
      .filter(task => task.CommittedDay?.slice(0, 10) === date)
      .map(task => `${task.ParentFolderId}:${task.Id}`);
    if (sourceIds.length === 0) continue;
    const localTasks: Array<{ id: string; sourceId: string }> = [];
    for (let index = 0; index < sourceIds.length; index += MY_DAY_QUERY_BATCH_SIZE) {
      localTasks.push(...await db.select({
        id: tasks.id,
        sourceId: tasks.sourceId,
      })
        .from(tasks)
        .where(and(
          eq(tasks.connectorInstanceId, connectorInstanceId),
          inArray(tasks.sourceId, sourceIds.slice(index, index + MY_DAY_QUERY_BATCH_SIZE)),
        )));
    }

    const { dayStart } = getLocalDateBoundsISO(date);
    for (const task of localTasks) {
      if (appendPlanningSignal({
        taskId: task.id,
        eventType: 'my_day_committed',
        date,
        occurredAt: dayStart,
        provenance: 'microsoft-todo-substrate',
        metadata: { origin: 'remote-observed', lateObservation: true },
      })) observed++;
    }
  }
  return observed;
}

function recurringSiblingKey(sourceListId: string | null, title: string): string {
  return `${sourceListId ?? ''}\u0000${title}`;
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function insertMyDayRows(rows: Array<typeof myDayItems.$inferInsert>): Promise<number> {
  let inserted = 0;
  for (let index = 0; index < rows.length; index += MY_DAY_QUERY_BATCH_SIZE) {
    const result = await db.insert(myDayItems)
      .values(rows.slice(index, index + MY_DAY_QUERY_BATCH_SIZE))
      .onConflictDoNothing();
    inserted += result.changes;
  }
  return inserted;
}
