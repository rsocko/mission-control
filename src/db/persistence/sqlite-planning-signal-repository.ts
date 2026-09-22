import type Database from 'better-sqlite3';
import type {
  PlanningSignalFinalizationResult,
  PlanningSignalInput,
  PlanningSignalRepository,
  PlanningSignalType,
} from './planning-signals';
import { getLocalDateBoundsISO, parseStoredTimestamp } from '@/lib/utils/date';

const FINALIZATION_LOOKBACK_DAYS = 120;
const AUTOMATIC_FINALIZATION_INTERVAL_MS = 5 * 60 * 1000;
const FINALIZATION_MARKER_TASK_ID = '__planning-signal-finalizer__';
const FINALIZATION_MARKER_EVENT_TYPE = 'planning_signal_finalized';

interface CommitmentRow {
  taskId: string;
  date: string | null;
  occurredAt: string;
  completedAt: string | null;
}

interface WithdrawalRow {
  taskId: string;
  date: string | null;
  occurredAt: string;
}

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

function append(
  sqlite: Database.Database,
  input: PlanningSignalInput,
): boolean {
  const result = sqlite.prepare(`
    INSERT OR IGNORE INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, metadata
    ) VALUES (?, ?, 'planningDate', NULL, ?, ?, ?, ?, ?)
  `).run(
    input.taskId,
    input.eventType,
    input.date,
    input.occurredAt,
    new Date().toISOString(),
    input.provenance,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
  return result.changes > 0;
}

function completedByDayClose(completedAt: string | null, date: string): boolean {
  if (!completedAt) return false;
  return parseStoredTimestamp(completedAt)
    < parseStoredTimestamp(getLocalDateBoundsISO(date).nextDayStart);
}

function backfillCommitments(
  sqlite: Database.Database,
  today: string,
): number {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const myDayRows = sqlite.prepare(`
    SELECT task_id AS taskId, date, added_at AS addedAt
    FROM my_day_items
    WHERE is_auto_included = 0 AND date >= ? AND date < ?
  `).all(oldestDate, today) as Array<{ taskId: string; date: string; addedAt: string }>;
  const focusRows = sqlite.prepare(`
    SELECT task_id AS taskId, date, added_at AS addedAt, is_ai_suggested AS isAiSuggested
    FROM focus_items
    WHERE scope = 'today' AND date >= ? AND date < ?
  `).all(oldestDate, today) as Array<{
    taskId: string;
    date: string;
    addedAt: string;
    isAiSuggested: number;
  }>;

  let inserted = 0;
  for (const item of myDayRows) {
    if (append(sqlite, {
      taskId: item.taskId,
      eventType: 'my_day_committed',
      date: item.date,
      occurredAt: item.addedAt,
      provenance: 'my-day-history-backfill',
      metadata: { origin: 'explicit-local', backfilled: true },
    })) inserted++;
  }
  for (const item of focusRows) {
    if (append(sqlite, {
      taskId: item.taskId,
      eventType: 'focus_committed',
      date: item.date,
      occurredAt: item.addedAt,
      provenance: 'focus-history-backfill',
      metadata: {
        origin: item.isAiSuggested ? 'accepted-ai-suggestion' : 'explicit-local',
        backfilled: true,
      },
    })) inserted++;
  }
  return inserted;
}

function finalizeCommitmentMisses(
  sqlite: Database.Database,
  today: string,
  commitmentType: PlanningSignalType,
  withdrawalType: PlanningSignalType,
  missedType: PlanningSignalType,
): number {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const commitments = sqlite.prepare(`
    SELECT event.task_id AS taskId, event.new_value AS date,
           event.occurred_at AS occurredAt, task.completed_at AS completedAt
    FROM task_history_events event
    INNER JOIN tasks task ON task.id = event.task_id
    WHERE event.event_type = ? AND event.new_value >= ? AND event.new_value < ?
      AND task.status <> 'cancelled'
  `).all(commitmentType, oldestDate, today) as CommitmentRow[];
  const withdrawals = sqlite.prepare(`
    SELECT task_id AS taskId, new_value AS date, occurred_at AS occurredAt
    FROM task_history_events
    WHERE event_type = ? AND new_value >= ? AND new_value < ?
  `).all(withdrawalType, oldestDate, today) as WithdrawalRow[];

  const latestWithdrawal = new Map<string, string>();
  for (const item of withdrawals) {
    const key = `${item.taskId}:${item.date}`;
    if ((latestWithdrawal.get(key) ?? '') < item.occurredAt) {
      latestWithdrawal.set(key, item.occurredAt);
    }
  }
  const latestCommitment = new Map<string, CommitmentRow>();
  for (const item of commitments) {
    const key = `${item.taskId}:${item.date}`;
    if ((latestCommitment.get(key)?.occurredAt ?? '') < item.occurredAt) {
      latestCommitment.set(key, item);
    }
  }

  let inserted = 0;
  for (const [key, item] of latestCommitment) {
    if (!item.date || (latestWithdrawal.get(key) ?? '') >= item.occurredAt) continue;
    if (completedByDayClose(item.completedAt, item.date)) continue;
    if (append(sqlite, {
      taskId: item.taskId,
      eventType: missedType,
      date: item.date,
      occurredAt: getLocalDateBoundsISO(item.date).nextDayStart,
      provenance: 'planning-signal-finalizer',
      metadata: { commitmentType },
    })) inserted++;
  }
  return inserted;
}

function finalizeElapsedBlocks(sqlite: Database.Database, today: string): number {
  const rows = sqlite.prepare(`
    SELECT schedule.task_id AS taskId, schedule.scheduled_date AS date,
           schedule.scheduled_time AS scheduledTime,
           schedule.estimated_duration AS estimatedDuration,
           task.completed_at AS completedAt
    FROM task_schedules schedule
    INNER JOIN tasks task ON task.id = schedule.task_id
    WHERE schedule.is_time_blocked = 1
      AND schedule.scheduled_date >= ? AND schedule.scheduled_date < ?
      AND task.status <> 'cancelled'
  `).all(daysBefore(today, FINALIZATION_LOOKBACK_DAYS), today) as Array<{
    taskId: string;
    date: string;
    scheduledTime: string | null;
    estimatedDuration: number | null;
    completedAt: string | null;
  }>;
  let inserted = 0;
  for (const item of rows) {
    if (completedByDayClose(item.completedAt, item.date)) continue;
    if (append(sqlite, {
      taskId: item.taskId,
      eventType: 'scheduled_block_elapsed',
      date: item.date,
      occurredAt: getLocalDateBoundsISO(item.date).nextDayStart,
      provenance: 'planning-signal-finalizer',
      metadata: {
        scheduledTime: item.scheduledTime,
        estimatedDuration: item.estimatedDuration,
      },
    })) inserted++;
  }
  return inserted;
}

function finalizeOverdueTransitions(sqlite: Database.Database, today: string): number {
  const rows = sqlite.prepare(`
    SELECT id AS taskId, due_date AS dueDate
    FROM tasks
    WHERE due_date < ? AND status NOT IN ('done', 'cancelled')
      AND (snoozed_until IS NULL OR snoozed_until <= ?)
  `).all(today, new Date().toISOString()) as Array<{ taskId: string; dueDate: string }>;
  let inserted = 0;
  for (const item of rows) {
    const dueDate = item.dueDate?.slice(0, 10);
    if (!dueDate) continue;
    if (append(sqlite, {
      taskId: item.taskId,
      eventType: 'became_overdue',
      date: dueDate,
      occurredAt: getLocalDateBoundsISO(dueDate).nextDayStart,
      provenance: 'planning-signal-finalizer',
    })) inserted++;
  }
  return inserted;
}

function finalize(
  sqlite: Database.Database,
  today: string,
): PlanningSignalFinalizationResult {
  const commitmentsBackfilled = backfillCommitments(sqlite, today);
  return {
    commitmentsBackfilled,
    myDayMisses: finalizeCommitmentMisses(
      sqlite,
      today,
      'my_day_committed',
      'my_day_withdrawn',
      'my_day_missed',
    ),
    focusMisses: finalizeCommitmentMisses(
      sqlite,
      today,
      'focus_committed',
      'focus_withdrawn',
      'focus_missed',
    ),
    elapsedBlocks: finalizeElapsedBlocks(sqlite, today),
    overdueTransitions: finalizeOverdueTransitions(sqlite, today),
  };
}

function windowKey(now: Date): string {
  return new Date(
    Math.floor(now.getTime() / AUTOMATIC_FINALIZATION_INTERVAL_MS)
      * AUTOMATIC_FINALIZATION_INTERVAL_MS,
  ).toISOString();
}

function isWindowFinalized(sqlite: Database.Database, window: string): boolean {
  return Boolean(sqlite.prepare(`
    SELECT 1
    FROM task_history_events
    WHERE task_id = ? AND event_type = ? AND new_value = ?
    LIMIT 1
  `).get(FINALIZATION_MARKER_TASK_ID, FINALIZATION_MARKER_EVENT_TYPE, window));
}

export function createSqlitePlanningSignalRepository(
  sqlite: Database.Database,
): PlanningSignalRepository {
  return {
    append(input) {
      return Promise.resolve(append(sqlite, input));
    },
    finalize(today) {
      return Promise.resolve(sqlite.transaction(() => finalize(sqlite, today)).immediate());
    },
    finalizeIfDue({ today, now }) {
      const window = windowKey(now);
      if (isWindowFinalized(sqlite, window)) return Promise.resolve(null);
      return Promise.resolve(sqlite.transaction(() => {
        if (isWindowFinalized(sqlite, window)) return null;
        const result = finalize(sqlite, today);
        sqlite.prepare(`
          INSERT INTO task_history_events (
            task_id, event_type, field_name, previous_value, new_value,
            occurred_at, recorded_at, provenance, metadata
          ) VALUES (?, ?, 'planningDate', NULL, ?, ?, ?, 'planning-signal-finalizer', NULL)
        `).run(
          FINALIZATION_MARKER_TASK_ID,
          FINALIZATION_MARKER_EVENT_TYPE,
          window,
          window,
          new Date().toISOString(),
        );
        return result;
      }).immediate());
    },
  };
}
