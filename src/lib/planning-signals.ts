import 'server-only';

import db from '@/db';
import {
  focusItems,
  myDayItems,
  taskHistoryEvents,
  taskSchedules,
  tasks,
} from '@/db/schema';
import {
  and,
  eq,
  gte,
  inArray,
  isNull,
  lte,
  lt,
  ne,
  or,
} from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type * as schema from '@/db/schema';
import {
  getLocalDateBoundsISO,
  getLocalToday,
  parseStoredTimestamp,
} from '@/lib/utils/date';

export const PLANNING_FRICTION_EVENT_TYPES = [
  'due_date_pushed',
  'my_day_missed',
  'focus_missed',
  'snooze_extended',
  'scheduled_block_elapsed',
  'became_overdue',
] as const;

export type PlanningFrictionEventType = typeof PLANNING_FRICTION_EVENT_TYPES[number];
type PlanningRootDatabase = BetterSQLite3Database<typeof schema>;
type PlanningDatabase = Pick<PlanningRootDatabase, 'insert' | 'select'>;
type PlanningSignalType =
  | Exclude<PlanningFrictionEventType, 'due_date_pushed' | 'snooze_extended'>
  | 'my_day_committed'
  | 'my_day_withdrawn'
  | 'focus_committed'
  | 'focus_withdrawn';

interface PlanningSignalInput {
  taskId: string;
  eventType: PlanningSignalType;
  date: string;
  occurredAt: string;
  provenance: string;
  metadata?: Record<string, unknown>;
}

export interface PlanningSignalFinalizationResult {
  commitmentsBackfilled: number;
  myDayMisses: number;
  focusMisses: number;
  elapsedBlocks: number;
  overdueTransitions: number;
}

const FINALIZATION_LOOKBACK_DAYS = 120;
const AUTOMATIC_FINALIZATION_INTERVAL_MS = 5 * 60 * 1000;
let lastAutomaticFinalizationAt = 0;

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

export function appendPlanningSignal(
  input: PlanningSignalInput,
  database: PlanningDatabase = db,
): boolean {
  const result = database.insert(taskHistoryEvents).values({
    taskId: input.taskId,
    eventType: input.eventType,
    fieldName: 'planningDate',
    previousValue: null,
    newValue: input.date,
    occurredAt: input.occurredAt,
    recordedAt: new Date().toISOString(),
    provenance: input.provenance,
    metadata: input.metadata ?? null,
  }).onConflictDoNothing().run();
  return result.changes > 0;
}

function wasCompletedByDayClose(completedAt: string | null, date: string): boolean {
  if (!completedAt) return false;
  const { nextDayStart } = getLocalDateBoundsISO(date);
  return parseStoredTimestamp(completedAt) < parseStoredTimestamp(nextDayStart);
}

function backfillCommitments(database: PlanningDatabase, today: string): number {
  let inserted = 0;
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const myDayRows = database.select({
    taskId: myDayItems.taskId,
    date: myDayItems.date,
    addedAt: myDayItems.addedAt,
  })
    .from(myDayItems)
    .where(and(
      eq(myDayItems.isAutoIncluded, false),
      gte(myDayItems.date, oldestDate),
      lt(myDayItems.date, today),
    ))
    .all();

  for (const item of myDayRows) {
    if (appendPlanningSignal({
      taskId: item.taskId,
      eventType: 'my_day_committed',
      date: item.date,
      occurredAt: item.addedAt,
      provenance: 'my-day-history-backfill',
      metadata: { origin: 'explicit-local', backfilled: true },
    }, database)) inserted++;
  }

  const focusRows = database.select({
    taskId: focusItems.taskId,
    date: focusItems.date,
    addedAt: focusItems.addedAt,
    isAiSuggested: focusItems.isAiSuggested,
  })
    .from(focusItems)
    .where(and(
      eq(focusItems.scope, 'today'),
      gte(focusItems.date, oldestDate),
      lt(focusItems.date, today),
    ))
    .all();

  for (const item of focusRows) {
    if (appendPlanningSignal({
      taskId: item.taskId,
      eventType: 'focus_committed',
      date: item.date,
      occurredAt: item.addedAt,
      provenance: 'focus-history-backfill',
      metadata: { origin: item.isAiSuggested ? 'accepted-ai-suggestion' : 'explicit-local', backfilled: true },
    }, database)) inserted++;
  }

  return inserted;
}

function finalizeCommitmentMisses(
  database: PlanningDatabase,
  today: string,
  commitmentType: 'my_day_committed' | 'focus_committed',
  withdrawalType: 'my_day_withdrawn' | 'focus_withdrawn',
  missedType: 'my_day_missed' | 'focus_missed',
): number {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const commitments = database.select({
    taskId: taskHistoryEvents.taskId,
    date: taskHistoryEvents.newValue,
    occurredAt: taskHistoryEvents.occurredAt,
    status: tasks.status,
    completedAt: tasks.completedAt,
  })
    .from(taskHistoryEvents)
    .innerJoin(tasks, eq(taskHistoryEvents.taskId, tasks.id))
    .where(and(
      eq(taskHistoryEvents.eventType, commitmentType),
      gte(taskHistoryEvents.newValue, oldestDate),
      lt(taskHistoryEvents.newValue, today),
      ne(tasks.status, 'cancelled'),
    ))
    .all();

  const withdrawals = database.select({
    taskId: taskHistoryEvents.taskId,
    date: taskHistoryEvents.newValue,
    occurredAt: taskHistoryEvents.occurredAt,
  })
    .from(taskHistoryEvents)
    .where(and(
      eq(taskHistoryEvents.eventType, withdrawalType),
      gte(taskHistoryEvents.newValue, oldestDate),
      lt(taskHistoryEvents.newValue, today),
    ))
    .all();
  const latestWithdrawal = new Map<string, string>();
  for (const item of withdrawals) {
    const key = `${item.taskId}:${item.date}`;
    if ((latestWithdrawal.get(key) ?? '') < item.occurredAt) {
      latestWithdrawal.set(key, item.occurredAt);
    }
  }

  const latestCommitment = new Map<string, typeof commitments[number]>();
  for (const item of commitments) {
    const key = `${item.taskId}:${item.date}`;
    if ((latestCommitment.get(key)?.occurredAt ?? '') < item.occurredAt) {
      latestCommitment.set(key, item);
    }
  }

  let inserted = 0;
  for (const [key, item] of latestCommitment) {
    if (!item.date || (latestWithdrawal.get(key) ?? '') >= item.occurredAt) continue;
    if (wasCompletedByDayClose(item.completedAt, item.date)) continue;
    const { nextDayStart } = getLocalDateBoundsISO(item.date);
    if (appendPlanningSignal({
      taskId: item.taskId,
      eventType: missedType,
      date: item.date,
      occurredAt: nextDayStart,
      provenance: 'planning-signal-finalizer',
      metadata: { commitmentType },
    }, database)) inserted++;
  }
  return inserted;
}

function finalizeElapsedBlocks(database: PlanningDatabase, today: string): number {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const rows = database.select({
    taskId: taskSchedules.taskId,
    date: taskSchedules.scheduledDate,
    scheduledTime: taskSchedules.scheduledTime,
    estimatedDuration: taskSchedules.estimatedDuration,
    completedAt: tasks.completedAt,
  })
    .from(taskSchedules)
    .innerJoin(tasks, eq(taskSchedules.taskId, tasks.id))
    .where(and(
      eq(taskSchedules.isTimeBlocked, true),
      gte(taskSchedules.scheduledDate, oldestDate),
      lt(taskSchedules.scheduledDate, today),
      ne(tasks.status, 'cancelled'),
    ))
    .all();

  let inserted = 0;
  for (const item of rows) {
    if (wasCompletedByDayClose(item.completedAt, item.date)) continue;
    const { nextDayStart } = getLocalDateBoundsISO(item.date);
    if (appendPlanningSignal({
      taskId: item.taskId,
      eventType: 'scheduled_block_elapsed',
      date: item.date,
      occurredAt: nextDayStart,
      provenance: 'planning-signal-finalizer',
      metadata: {
        scheduledTime: item.scheduledTime,
        estimatedDuration: item.estimatedDuration,
      },
    }, database)) inserted++;
  }
  return inserted;
}

function finalizeOverdueTransitions(database: PlanningDatabase, today: string): number {
  const rows = database.select({
    taskId: tasks.id,
    dueDate: tasks.dueDate,
  })
    .from(tasks)
    .where(and(
      lt(tasks.dueDate, today),
      ne(tasks.status, 'done'),
      ne(tasks.status, 'cancelled'),
      or(
        isNull(tasks.snoozedUntil),
        lte(tasks.snoozedUntil, new Date().toISOString()),
      ),
    ))
    .all();

  let inserted = 0;
  for (const item of rows) {
    const dueDate = item.dueDate?.slice(0, 10);
    if (!dueDate) continue;
    const { nextDayStart } = getLocalDateBoundsISO(dueDate);
    if (appendPlanningSignal({
      taskId: item.taskId,
      eventType: 'became_overdue',
      date: dueDate,
      occurredAt: nextDayStart,
      provenance: 'planning-signal-finalizer',
    }, database)) inserted++;
  }
  return inserted;
}

export function finalizePlanningSignals(
  today = getLocalToday(),
  database: PlanningRootDatabase = db,
): PlanningSignalFinalizationResult {
  return database.transaction((tx) => {
    const commitmentsBackfilled = backfillCommitments(tx, today);
    return {
      commitmentsBackfilled,
      myDayMisses: finalizeCommitmentMisses(
        tx,
        today,
        'my_day_committed',
        'my_day_withdrawn',
        'my_day_missed',
      ),
      focusMisses: finalizeCommitmentMisses(
        tx,
        today,
        'focus_committed',
        'focus_withdrawn',
        'focus_missed',
      ),
      elapsedBlocks: finalizeElapsedBlocks(tx, today),
      overdueTransitions: finalizeOverdueTransitions(tx, today),
    };
  }, { behavior: 'immediate' });
}

export function finalizePlanningSignalsIfDue(
  today = getLocalToday(),
): PlanningSignalFinalizationResult | null {
  const now = Date.now();
  if (now - lastAutomaticFinalizationAt < AUTOMATIC_FINALIZATION_INTERVAL_MS) return null;
  const result = finalizePlanningSignals(today);
  lastAutomaticFinalizationAt = now;
  return result;
}

export function planningFrictionEventTypes(): readonly PlanningFrictionEventType[] {
  return PLANNING_FRICTION_EVENT_TYPES;
}
