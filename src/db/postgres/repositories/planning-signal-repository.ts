import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  PlanningSignalFinalizationResult,
  PlanningSignalInput,
  PlanningSignalRepository,
  PlanningSignalType,
} from '@/db/persistence/planning-signals';
import { getLocalDateBoundsISO, parseStoredTimestamp } from '@/lib/utils/date';

const FINALIZATION_LOOKBACK_DAYS = 120;
const AUTOMATIC_FINALIZATION_INTERVAL_MS = 5 * 60 * 1000;
const FINALIZATION_LOCK_KEY = 0x4d435053;
const FINALIZATION_MARKER_TASK_ID = '__planning-signal-finalizer__';
const FINALIZATION_MARKER_EVENT_TYPE = 'planning_signal_finalized';

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
  tryLock = false,
): Promise<T | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      if (tryLock) {
        const lock = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_xact_lock($1) AS acquired',
          [FINALIZATION_LOCK_KEY],
        );
        if (!lock.rows[0]?.acquired) {
          await client.query('ROLLBACK');
          return null;
        }
      } else {
        await client.query('SELECT pg_advisory_xact_lock($1)', [FINALIZATION_LOCK_KEY]);
      }
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

function daysBefore(date: string, days: number): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - days);
  return value.toISOString().slice(0, 10);
}

async function append(
  client: Pool | PoolClient,
  input: PlanningSignalInput,
): Promise<boolean> {
  const result = await client.query(`
    INSERT INTO task_history_events (
      task_id, event_type, field_name, previous_value, new_value,
      occurred_at, recorded_at, provenance, metadata
    ) VALUES ($1, $2, 'planningDate', NULL, $3, $4, $5, $6, $7)
    ON CONFLICT DO NOTHING
  `, [
    input.taskId,
    input.eventType,
    input.date,
    input.occurredAt,
    new Date().toISOString(),
    input.provenance,
    input.metadata ?? null,
  ]);
  return result.rowCount === 1;
}

function completedByDayClose(completedAt: string | null, date: string): boolean {
  if (!completedAt) return false;
  return parseStoredTimestamp(completedAt)
    < parseStoredTimestamp(getLocalDateBoundsISO(date).nextDayStart);
}

async function backfillCommitments(client: PoolClient, today: string): Promise<number> {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const myDayRows = await query<{
    taskId: string;
    date: string;
    addedAt: string;
  }>(client, `
    SELECT task_id AS "taskId", date, added_at AS "addedAt"
    FROM my_day_items
    WHERE is_auto_included = FALSE AND date >= $1 AND date < $2
  `, [oldestDate, today]);
  const focusRows = await query<{
    taskId: string;
    date: string;
    addedAt: string;
    isAiSuggested: boolean;
  }>(client, `
    SELECT task_id AS "taskId", date, added_at AS "addedAt",
           is_ai_suggested AS "isAiSuggested"
    FROM focus_items
    WHERE scope = 'today' AND date >= $1 AND date < $2
  `, [oldestDate, today]);

  let inserted = 0;
  for (const item of myDayRows) {
    if (await append(client, {
      taskId: item.taskId,
      eventType: 'my_day_committed',
      date: item.date,
      occurredAt: item.addedAt,
      provenance: 'my-day-history-backfill',
      metadata: { origin: 'explicit-local', backfilled: true },
    })) inserted++;
  }
  for (const item of focusRows) {
    if (await append(client, {
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

async function finalizeCommitmentMisses(
  client: PoolClient,
  today: string,
  commitmentType: PlanningSignalType,
  withdrawalType: PlanningSignalType,
  missedType: PlanningSignalType,
): Promise<number> {
  const oldestDate = daysBefore(today, FINALIZATION_LOOKBACK_DAYS);
  const commitments = await query<{
    taskId: string;
    date: string | null;
    occurredAt: string;
    completedAt: string | null;
  }>(client, `
    SELECT event.task_id AS "taskId", event.new_value AS date,
           event.occurred_at AS "occurredAt", task.completed_at AS "completedAt"
    FROM task_history_events event
    INNER JOIN tasks task ON task.id = event.task_id
    WHERE event.event_type = $1 AND event.new_value >= $2 AND event.new_value < $3
      AND task.status <> 'cancelled'
  `, [commitmentType, oldestDate, today]);
  const withdrawals = await query<{
    taskId: string;
    date: string | null;
    occurredAt: string;
  }>(client, `
    SELECT task_id AS "taskId", new_value AS date, occurred_at AS "occurredAt"
    FROM task_history_events
    WHERE event_type = $1 AND new_value >= $2 AND new_value < $3
  `, [withdrawalType, oldestDate, today]);

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
    if (completedByDayClose(item.completedAt, item.date)) continue;
    if (await append(client, {
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

async function finalizeElapsedBlocks(client: PoolClient, today: string): Promise<number> {
  const rows = await query<{
    taskId: string;
    date: string;
    scheduledTime: string | null;
    estimatedDuration: number | null;
    completedAt: string | null;
  }>(client, `
    SELECT schedule.task_id AS "taskId", schedule.scheduled_date AS date,
           schedule.scheduled_time AS "scheduledTime",
           schedule.estimated_duration AS "estimatedDuration",
           task.completed_at AS "completedAt"
    FROM task_schedules schedule
    INNER JOIN tasks task ON task.id = schedule.task_id
    WHERE schedule.is_time_blocked = TRUE
      AND schedule.scheduled_date >= $1 AND schedule.scheduled_date < $2
      AND task.status <> 'cancelled'
  `, [daysBefore(today, FINALIZATION_LOOKBACK_DAYS), today]);
  let inserted = 0;
  for (const item of rows) {
    if (completedByDayClose(item.completedAt, item.date)) continue;
    if (await append(client, {
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

async function finalizeOverdueTransitions(client: PoolClient, today: string): Promise<number> {
  const rows = await query<{ taskId: string; dueDate: string }>(client, `
    SELECT id AS "taskId", due_date AS "dueDate"
    FROM tasks
    WHERE due_date < $1 AND status NOT IN ('done', 'cancelled')
      AND (snoozed_until IS NULL OR snoozed_until <= $2)
  `, [today, new Date().toISOString()]);
  let inserted = 0;
  for (const item of rows) {
    const dueDate = item.dueDate?.slice(0, 10);
    if (!dueDate) continue;
    if (await append(client, {
      taskId: item.taskId,
      eventType: 'became_overdue',
      date: dueDate,
      occurredAt: getLocalDateBoundsISO(dueDate).nextDayStart,
      provenance: 'planning-signal-finalizer',
    })) inserted++;
  }
  return inserted;
}

async function finalize(
  client: PoolClient,
  today: string,
): Promise<PlanningSignalFinalizationResult> {
  const commitmentsBackfilled = await backfillCommitments(client, today);
  return {
    commitmentsBackfilled,
    myDayMisses: await finalizeCommitmentMisses(
      client,
      today,
      'my_day_committed',
      'my_day_withdrawn',
      'my_day_missed',
    ),
    focusMisses: await finalizeCommitmentMisses(
      client,
      today,
      'focus_committed',
      'focus_withdrawn',
      'focus_missed',
    ),
    elapsedBlocks: await finalizeElapsedBlocks(client, today),
    overdueTransitions: await finalizeOverdueTransitions(client, today),
  };
}

function windowKey(now: Date): string {
  return new Date(
    Math.floor(now.getTime() / AUTOMATIC_FINALIZATION_INTERVAL_MS)
      * AUTOMATIC_FINALIZATION_INTERVAL_MS,
  ).toISOString();
}

export function createPostgresPlanningSignalRepository(pool: Pool): PlanningSignalRepository {
  return {
    append: (input) => append(pool, input),
    async finalize(today) {
      const result = await transaction(pool, (client) => finalize(client, today));
      if (!result) throw new Error('Planning signal finalization lock was not acquired');
      return result;
    },
    finalizeIfDue: ({ today, now }) => transaction(pool, async (client) => {
      const window = windowKey(now);
      const completed = await query(client, `
        SELECT 1
        FROM task_history_events
        WHERE task_id = $1 AND event_type = $2 AND new_value = $3
        LIMIT 1
      `, [FINALIZATION_MARKER_TASK_ID, FINALIZATION_MARKER_EVENT_TYPE, window]);
      if (completed.length > 0) return null;
      const result = await finalize(client, today);
      await client.query(`
        INSERT INTO task_history_events (
          task_id, event_type, field_name, previous_value, new_value,
          occurred_at, recorded_at, provenance, metadata
        ) VALUES ($1, $2, 'planningDate', NULL, $3, $3, $4, 'planning-signal-finalizer', NULL)
      `, [
        FINALIZATION_MARKER_TASK_ID,
        FINALIZATION_MARKER_EVENT_TYPE,
        window,
        new Date().toISOString(),
      ]);
      return result;
    }, true),
  };
}
