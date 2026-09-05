import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import type { PersistenceJson } from '@/db/persistence/contracts';
import type {
  AddFocusItemResult,
  AddMyDayItemResult,
  DailyPlanningPersistence,
  EnergyCheckinRecord,
  FocusItemRecord,
  FocusScope,
  MobileDashboardActivityRecord,
  MyDayAutoIncludeResult,
  MyDayDayViewProjection,
  MyDayItemRecord,
  MyDayPhaseMembershipRecord,
  MyDayRowInsert,
  MyDaySignalledSuggestionRecord,
  MyDaySuggestionRecord,
  MyDaySyncCompletedSibling,
  MyDaySyncLocalItem,
  MyDaySyncLocalTask,
  MyDaySyncRecurringHistoryRecord,
  MyDayTagRecord,
  PlanningSignalCommand,
  RecentWinRecord,
  ScheduledTaskRecord,
  WeeklyOneThingCandidate,
  WeeklyOneThingRecord,
} from '@/db/persistence/daily-planning';

const BATCH_SIZE = 400;

const NOTIFICATION_ONLY_LIST = NOTIFICATION_ONLY_CONNECTOR_TYPES
  .map((type) => `'${type}'`)
  .join(', ');

const INSTANT_TEXT_PATTERN = String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`
  + String.raw`([T\s]+([01]\d|2[0-4]):[0-5]\d(:[0-5]\d(\.\d+)?)?`
  + String.raw`(\s*([Zz]|[+-](0\d|1[0-4]):[0-5]\d))?)?\s*$`;
const HOUR_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+(\d{2}):`;
const MINUTE_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+\d{2}:(\d{2})`;
const SECOND_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+\d{2}:\d{2}:(\d{2}(\.\d+)?)`;
const ZONE_SIGN_CAPTURE = String.raw`([+-])\d{2}:\d{2}\s*$`;
const ZONE_HOUR_CAPTURE = String.raw`[+-](\d{2}):\d{2}\s*$`;
const ZONE_MINUTE_CAPTURE = String.raw`[+-]\d{2}:(\d{2})\s*$`;

function focusLockKey(scope: FocusScope, date: string): string {
  return `daily-planning:focus:${scope}:${date}`;
}

function myDayLockKey(date: string): string {
  return `daily-planning:my-day:${date}`;
}

function oneThingLockKey(weekMonday: string): string {
  return `daily-planning:one-thing:${weekMonday}`;
}

/** The portable equivalent of `getTaskSourceVisibilityConditions()`. */
function visibleTask(alias: string): string {
  return `${alias}.connector_instance_id NOT IN (
      SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
    )
    AND ${alias}.connector_type NOT IN (${NOTIFICATION_ONLY_LIST})`;
}

function activeVisibleTask(alias: string): string {
  return `${visibleTask(alias)} AND ${alias}.local_disposition = 'active'`;
}

function topLevelTask(alias: string): string {
  return `${alias}.depth = 0 AND ${alias}.parent_id IS NULL`;
}

function openTask(alias: string): string {
  return `${alias}.status NOT IN ('done', 'cancelled')`;
}

function instant(column: string): string {
  const year = `substr(${column}, 1, 4)::int`;
  const month = `substr(${column}, 6, 2)::int`;
  const day = `substr(${column}, 9, 2)::int`;
  const hours = `COALESCE(substring(${column} from '${HOUR_CAPTURE}')::int, 0)`;
  const minutes = `COALESCE(substring(${column} from '${MINUTE_CAPTURE}')::int, 0)`;
  const seconds =
    `COALESCE(substring(${column} from '${SECOND_CAPTURE}')::double precision, 0)`;
  const offsetMinutes =
    `(CASE WHEN substring(${column} from '${ZONE_SIGN_CAPTURE}') = '-' THEN -1 ELSE 1 END)
      * (substring(${column} from '${ZONE_HOUR_CAPTURE}')::int * 60
         + substring(${column} from '${ZONE_MINUTE_CAPTURE}')::int)`;
  return `(CASE
    WHEN ${column} ~ '${INSTANT_TEXT_PATTERN}'
    THEN (
      (
        make_date(CASE WHEN ${year} = 0 THEN -1 ELSE ${year} END, ${month}, 1)::timestamp
        + make_interval(
            days => ${day} - 1,
            hours => ${hours},
            mins => ${minutes},
            secs => ${seconds}
          )
      ) AT TIME ZONE 'UTC'
    ) - COALESCE(make_interval(mins => ${offsetMinutes}), INTERVAL '0')
    ELSE NULL
  END)`;
}

function chunk<T>(values: readonly T[], size = BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push([...values.slice(index, index + size)]);
  }
  return batches;
}

function toCount(value: unknown): number {
  return Number(value ?? 0);
}

function toJson(value: unknown): PersistenceJson {
  return (value ?? null) as PersistenceJson;
}

/** Escapes the LIKE wildcards in a caller-supplied literal prefix. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

async function withMutationTransaction<T>(
  pool: Pool,
  lockKeys: readonly string[],
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const keys = [...new Set(lockKeys)].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      for (const key of keys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
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

const SUGGESTION_COLUMNS = `
  t.id AS id, t.title AS title, t.status AS status, t.micro_status AS "microStatus",
  t.priority AS priority, t.planning_horizon AS "planningHorizon", t.due_date AS "dueDate",
  t.push_count AS "pushCount", t.connector_type AS "connectorType",
  t.connector_instance_id AS "connectorInstanceId", t.source_id AS "sourceId",
  t.source_list_id AS "sourceListId", t.source_list_name AS "sourceListName",
  t.metadata AS metadata, t.local_disposition AS "localDisposition"
`;

const FOCUS_COLUMNS = `
  f.id AS id, f.task_id AS "taskId", f.scope AS scope, f.date AS date, f.slot AS slot,
  f.added_at AS "addedAt", f.is_ai_suggested AS "isAiSuggested",
  t.title AS title, t.status AS status, t.micro_status AS "microStatus",
  t.priority AS priority, t.due_date AS "dueDate", t.connector_type AS "connectorType",
  t.connector_instance_id AS "connectorInstanceId", t.source_id AS "sourceId",
  t.source_list_id AS "sourceListId", t.source_list_name AS "sourceListName"
`;

const ONE_THING_COLUMNS = `
  w.id AS id, w.task_id AS "taskId", w.week_monday AS "weekMonday",
  w.is_manual_override AS "isManualOverride", w.completed_at AS "completedAt",
  w.created_at AS "createdAt", t.title AS title, t.status AS status,
  t.priority AS priority, t.due_date AS "dueDate", t.connector_type AS "connectorType",
  t.source_list_name AS "sourceListName"
`;

interface RawSuggestionRow extends Omit<MyDaySuggestionRecord, 'metadata'> {
  metadata: unknown;
}

function suggestionFromRow(row: RawSuggestionRow): MyDaySuggestionRecord {
  return { ...row, pushCount: toCount(row.pushCount), metadata: toJson(row.metadata) };
}

export function createPostgresDailyPlanningPersistence(
  pool: Pool,
): DailyPlanningPersistence {
  async function appendSignal(
    client: PoolClient,
    taskId: string,
    eventType: string,
    date: string,
    occurredAt: string,
    signal: PlanningSignalCommand,
  ): Promise<void> {
    await client.query(`
      INSERT INTO task_history_events (
        task_id, event_type, field_name, previous_value, new_value,
        occurred_at, recorded_at, provenance, metadata
      ) VALUES ($1, $2, 'planningDate', NULL, $3, $4, $5, $6, $7)
      ON CONFLICT DO NOTHING
    `, [
      taskId,
      eventType,
      date,
      occurredAt,
      new Date().toISOString(),
      signal.provenance,
      signal.metadata ?? null,
    ]);
  }

  async function scalar(
    text: string,
    values: readonly unknown[] = [],
  ): Promise<number> {
    const [row] = await query<{ count: number }>(pool, text, values);
    return toCount(row?.count);
  }

  async function listSuggestions(
    text: string,
    values: readonly unknown[],
    excluded: Set<string>,
  ): Promise<MyDaySuggestionRecord[]> {
    return (await query<RawSuggestionRow>(pool, text, values))
      .filter((row) => !excluded.has(row.id))
      .map(suggestionFromRow);
  }

  async function listPendingAutoIncludes(
    client: Pool | PoolClient,
    date: string,
    dayStart: string,
    nextDayStart: string,
  ): Promise<Array<{ id: string; completedAt: string }>> {
    return query<{ id: string; completedAt: string }>(client, `
      SELECT t.id AS id, t.completed_at AS "completedAt"
      FROM tasks t
      WHERE t.status = 'done'
        AND ${instant('t.completed_at')} >= $2::timestamptz
        AND ${instant('t.completed_at')} < $3::timestamptz
        AND ${topLevelTask('t')}
        AND ${activeVisibleTask('t')}
        AND t.completed_at IS NOT NULL
        AND t.id NOT IN (SELECT task_id FROM my_day_items WHERE date = $1)
        AND t.id NOT IN (SELECT task_id FROM my_day_exclusions WHERE date = $1)
      ORDER BY t.id
    `, [date, dayStart, nextDayStart]);
  }

  /**
   * Conflict-safe My Day insert. PostgreSQL has no unique `(task_id, date)`
   * index, so the guard is an explicit `NOT EXISTS` executed under the date's
   * advisory lock rather than `ON CONFLICT`.
   */
  async function insertMyDayRowsLocked(
    client: PoolClient,
    rows: readonly MyDayRowInsert[],
    signal?: PlanningSignalCommand,
  ): Promise<number> {
    let inserted = 0;
    for (const row of rows) {
      const result = await client.query(`
        INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
        SELECT $1, $2, $3, $4, $5, $6
        WHERE NOT EXISTS (
          SELECT 1 FROM my_day_items WHERE task_id = $2 AND date = $3
        ) AND NOT EXISTS (
          SELECT 1 FROM my_day_items WHERE id = $1
        )
      `, [row.id, row.taskId, row.date, row.addedAt, row.isAutoIncluded, row.order]);
      const changed = result.rowCount ?? 0;
      inserted += changed;
      if (changed > 0 && signal) {
        await appendSignal(
          client,
          row.taskId,
          'my_day_committed',
          row.date,
          row.addedAt,
          signal,
        );
      }
    }
    return inserted;
  }

  async function readOneThing(
    client: Pool | PoolClient,
    weekMonday: string,
  ): Promise<WeeklyOneThingRecord | null> {
    const [row] = await query<WeeklyOneThingRecord>(client, `
      SELECT ${ONE_THING_COLUMNS}
      FROM weekly_one_thing w
      INNER JOIN tasks t ON t.id = w.task_id
      WHERE w.week_monday = $1
      ORDER BY w.created_at, w.id
      LIMIT 1
    `, [weekMonday]);
    return row ?? null;
  }

  return {
    energy: {
      async getForDate(date) {
        const [row] = await query<EnergyCheckinRecord>(pool, `
          SELECT id, date, level, note, created_at AS "createdAt"
          FROM energy_checkins WHERE date = $1
          ORDER BY created_at, id
          LIMIT 1
        `, [date]);
        return row ?? null;
      },

      async replaceForDate(record) {
        await withMutationTransaction(pool, [], async (client) => {
          await client.query('LOCK TABLE energy_checkins IN SHARE ROW EXCLUSIVE MODE');
          await client.query('DELETE FROM energy_checkins WHERE date = $1', [record.date]);
          await client.query(`
            INSERT INTO energy_checkins (id, date, level, note, created_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [record.id, record.date, record.level, record.note, record.createdAt]);
        });
      },
    },

    focus: {
      async listBoard({ date, weekMonday }) {
        const read = (scope: FocusScope, scopeDate: string) => query<FocusItemRecord>(pool, `
          SELECT ${FOCUS_COLUMNS}
          FROM focus_items f
          INNER JOIN tasks t ON t.id = f.task_id
          WHERE f.scope = $1 AND f.date = $2
          ORDER BY f.slot, f.id
        `, [scope, scopeDate]);
        const [today, week] = await Promise.all([
          read('today', date),
          read('week', weekMonday),
        ]);
        return { today, week };
      },

      async add(command): Promise<AddFocusItemResult> {
        return withMutationTransaction(
          pool,
          [focusLockKey(command.scope, command.date)],
          async (client): Promise<AddFocusItemResult> => {
            const existing = await query<{ id: string; slot: number; taskId: string }>(client, `
              SELECT id, slot, task_id AS "taskId" FROM focus_items
              WHERE scope = $1 AND date = $2 ORDER BY slot
            `, [command.scope, command.date]);

            if (existing.some((item) => item.taskId === command.taskId)) {
              return { outcome: 'duplicate' };
            }
            if (existing.length >= command.maxSlots) return { outcome: 'full' };

            const used = new Set(existing.map((item) => item.slot));
            let slot = 1;
            while (used.has(slot) && slot <= command.maxSlots) slot++;

            await client.query(`
              INSERT INTO focus_items (id, task_id, scope, date, slot, added_at, is_ai_suggested)
              VALUES ($1, $2, $3, $4, $5, $6, $7)
            `, [
              command.id,
              command.taskId,
              command.scope,
              command.date,
              slot,
              command.addedAt,
              command.isAiSuggested,
            ]);
            if (command.scope === 'today') {
              await appendSignal(
                client,
                command.taskId,
                'focus_committed',
                command.date,
                command.addedAt,
                command.signal,
              );
            }
            return { outcome: 'added', id: command.id, slot };
          },
        );
      },

      async removeById(command) {
        const [item] = await query<{ taskId: string; scope: FocusScope; date: string }>(pool, `
          SELECT task_id AS "taskId", scope, date FROM focus_items WHERE id = $1
        `, [command.id]);
        if (!item) return { removed: false };

        return withMutationTransaction(
          pool,
          [focusLockKey(item.scope, item.date)],
          async (client) => {
            const [current] = await query<{ taskId: string; scope: FocusScope; date: string }>(
              client,
              'SELECT task_id AS "taskId", scope, date FROM focus_items WHERE id = $1',
              [command.id],
            );
            if (!current) return { removed: false };
            const result = await client.query(
              'DELETE FROM focus_items WHERE id = $1',
              [command.id],
            );
            const removed = (result.rowCount ?? 0) > 0;
            if (removed && current.scope === 'today') {
              await appendSignal(
                client,
                current.taskId,
                'focus_withdrawn',
                current.date,
                command.removedAt,
                command.signal,
              );
            }
            return { removed };
          },
        );
      },

      async removeByTask(command) {
        return withMutationTransaction(
          pool,
          [focusLockKey(command.scope, command.date)],
          async (client) => {
            const result = await client.query(`
              DELETE FROM focus_items WHERE task_id = $1 AND scope = $2 AND date = $3
            `, [command.taskId, command.scope, command.date]);
            const removed = (result.rowCount ?? 0) > 0;
            if (removed && command.scope === 'today') {
              await appendSignal(
                client,
                command.taskId,
                'focus_withdrawn',
                command.date,
                command.removedAt,
                command.signal,
              );
            }
            return { removed };
          },
        );
      },

      async moveToSlot({ id, slot }) {
        const [item] = await query<{ scope: FocusScope; date: string }>(
          pool,
          'SELECT scope, date FROM focus_items WHERE id = $1',
          [id],
        );
        if (!item) return { outcome: 'not-found' };

        return withMutationTransaction(
          pool,
          [focusLockKey(item.scope, item.date)],
          async (client): Promise<{ outcome: 'moved' | 'not-found' }> => {
            const [current] = await query<{ scope: string; date: string; slot: number }>(
              client,
              'SELECT scope, date, slot FROM focus_items WHERE id = $1',
              [id],
            );
            if (!current) return { outcome: 'not-found' };

            const [occupant] = await query<{ id: string; slot: number }>(client, `
              SELECT id, slot FROM focus_items
              WHERE scope = $1 AND date = $2 AND slot = $3 AND id <> $4
              LIMIT 1
            `, [current.scope, current.date, slot, id]);

            if (occupant) {
              // Mirrors the SQLite swap: the occupant is parked on the reserved
              // sentinel slot so no slot is ever occupied twice mid-swap.
              await client.query('UPDATE focus_items SET slot = 0 WHERE id = $1', [occupant.id]);
              await client.query('UPDATE focus_items SET slot = $1 WHERE id = $2', [slot, id]);
              await client.query(
                'UPDATE focus_items SET slot = $1 WHERE id = $2',
                [current.slot, occupant.id],
              );
            } else {
              await client.query('UPDATE focus_items SET slot = $1 WHERE id = $2', [slot, id]);
            }
            return { outcome: 'moved' };
          },
        );
      },
    },

    dashboard: {
      async snapshot(input) {
        const openTopLevel = `${openTask('t')} AND t.parent_id IS NULL`;
        const [
          totalOpen,
          completedToday,
          inProgress,
          overdue,
          triage,
          sort,
          queueOverdue,
          recentActivity,
        ] = await Promise.all([
          scalar(`SELECT count(*)::int AS count FROM tasks t WHERE ${openTopLevel}`),
          scalar(`
            SELECT count(*)::int AS count FROM tasks t
            WHERE t.status = 'done' AND t.parent_id IS NULL
              AND ${instant('t.completed_at')} >= $1::timestamptz
              AND ${instant('t.completed_at')} < $2::timestamptz
          `, [input.completedFrom, input.completedTo]),
          scalar(`
            SELECT count(*)::int AS count FROM tasks t
            WHERE t.status = 'in_progress' AND t.parent_id IS NULL
          `),
          scalar(`
            SELECT count(*)::int AS count FROM tasks t
            WHERE ${openTopLevel} AND t.due_date < $1
          `, [input.overdueBefore]),
          scalar("SELECT count(*)::int AS count FROM triage_items WHERE status = 'pending'"),
          scalar(`
            SELECT count(*)::int AS count FROM tasks t
            WHERE ${openTopLevel}
              AND (t.priority IS NULL OR t.priority = '' OR t.priority = 'none')
          `),
          scalar(`
            SELECT count(*)::int AS count FROM tasks t
            WHERE ${openTopLevel} AND t.due_date < $1
          `, [input.queueOverdueBefore]),
          query<MobileDashboardActivityRecord>(pool, `
            SELECT t.id AS id, t.title AS title, t.completed_at AS "completedAt"
            FROM tasks t
            WHERE t.status = 'done' AND t.parent_id IS NULL
            ORDER BY t.completed_at DESC NULLS LAST, t.id
            LIMIT $1
          `, [input.recentActivityLimit]),
        ]);

        return {
          totalOpen,
          completedToday,
          inProgress,
          overdue,
          queues: { triage, sort, overdue: queueOverdue },
          recentActivity,
        };
      },
    },

    navigation: {
      async counts({ date, now }) {
        const openVisibleTopLevel = `${visibleTask('t')} AND ${openTask('t')}
          AND t.parent_id IS NULL`;
        const inbox = `n.disposition = 'inbox'
          AND n.source_state IN ('active', 'unknown')
          AND (n.snoozed_until IS NULL OR n.snoozed_until <= $1)`;
        const attention = `${inbox} AND (
            n.level IN ('urgent', 'action_needed')
            OR (n.read_state = 'unread' AND (n.level IS NULL OR n.level IN ('heads_up', 'fyi')))
          )`;

        const [myDay, triage, quickSort, reconciliation, overdue, notificationRows] =
          await Promise.all([
            scalar(`
              SELECT count(*)::int AS count FROM my_day_items m
              INNER JOIN tasks t ON t.id = m.task_id
              WHERE m.date = $1 AND ${openVisibleTopLevel}
            `, [date]),
            scalar("SELECT count(*)::int AS count FROM triage_items WHERE status = 'pending'"),
            scalar(`
              SELECT count(*)::int AS count FROM tasks t
              WHERE ${openVisibleTopLevel}
                AND (t.snoozed_until IS NULL OR t.snoozed_until <= $1)
                AND t.priority = 'none'
            `, [now]),
            scalar(`
              SELECT count(*)::int AS count FROM scout_reconciliation_suggestions s
              INNER JOIN tasks t ON t.id = s.task_id
              WHERE s.status = 'pending' AND s.expires_at > $1
                AND t.status IN ('todo', 'in_progress')
            `, [now]),
            scalar(`
              SELECT count(*)::int AS count FROM tasks t
              WHERE ${openVisibleTopLevel} AND t.due_date < $1
            `, [date]),
            query<{
              attention: number;
              unread: number;
              urgent: number;
              actionNeeded: number;
              headsUp: number;
              fyi: number;
            }>(pool, `
              SELECT
                COALESCE(SUM(CASE WHEN ${attention} THEN 1 ELSE 0 END), 0)::int AS attention,
                COALESCE(
                  SUM(CASE WHEN ${inbox} AND n.read_state = 'unread' THEN 1 ELSE 0 END), 0
                )::int AS unread,
                COALESCE(
                  SUM(CASE WHEN ${attention} AND n.level = 'urgent' THEN 1 ELSE 0 END), 0
                )::int AS urgent,
                COALESCE(
                  SUM(CASE WHEN ${attention} AND n.level = 'action_needed' THEN 1 ELSE 0 END), 0
                )::int AS "actionNeeded",
                COALESCE(
                  SUM(CASE WHEN ${attention} AND n.level = 'heads_up' THEN 1 ELSE 0 END), 0
                )::int AS "headsUp",
                COALESCE(
                  SUM(CASE WHEN ${attention} AND n.level = 'fyi' THEN 1 ELSE 0 END), 0
                )::int AS fyi
              FROM notifications n
              WHERE n.connector_instance_id NOT IN (
                SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
              )
            `, [now]),
          ]);

        const notifications = notificationRows[0];
        return {
          myDay,
          triage,
          quickSort,
          reconciliation,
          overdue,
          notifications: {
            attention: toCount(notifications?.attention),
            unread: toCount(notifications?.unread),
            urgent: toCount(notifications?.urgent),
            actionNeeded: toCount(notifications?.actionNeeded),
            headsUp: toCount(notifications?.headsUp),
            fyi: toCount(notifications?.fyi),
          },
        };
      },
    },

    myDay: {
      async dayView(input): Promise<MyDayDayViewProjection> {
        const itemRows = await query<Omit<
          MyDayItemRecord,
          'tags' | 'subtaskTotal' | 'subtaskDone' | 'hubProjectIds' | 'projectPhases'
            | 'estimatedDuration' | 'metadata'
        > & { metadata: unknown }>(pool, `
          SELECT
            m.id AS id, m.task_id AS "taskId", m."order" AS "order",
            m.is_auto_included AS "isAutoIncluded", m.added_at AS "addedAt",
            t.title AS title,
            (length(btrim(coalesce(t.description, ''), E' \\t\\n\\r')) > 0) AS "hasDescription",
            t.status AS status, t.status_reason AS "statusReason", t.priority AS priority,
            t.planning_horizon AS "planningHorizon", t.due_date AS "dueDate",
            t.push_count AS "pushCount", t.connector_type AS "connectorType",
            t.connector_instance_id AS "connectorInstanceId", t.source_id AS "sourceId",
            t.source_list_id AS "sourceListId", t.source_list_name AS "sourceListName",
            t.assignee AS assignee, t.created_at AS "createdAt", t.completed_at AS "completedAt",
            t.metadata AS metadata, t.effort AS effort, t.micro_status AS "microStatus",
            t.local_disposition AS "localDisposition"
          FROM my_day_items m
          INNER JOIN tasks t ON t.id = m.task_id
          WHERE m.date = $1 AND ${activeVisibleTask('t')}
          ORDER BY m."order", m.id
        `, [input.date]);

        const taskIds = itemRows.map((row) => row.taskId);
        const excluded = new Set(taskIds);

        const tagsByTask = new Map<string, MyDayTagRecord[]>();
        const subtasks = new Map<string, { total: number; done: number }>();
        const durations = new Map<string, number | null>();
        const projectsByTask = new Map<string, string[]>();
        const phasesByTask = new Map<string, MyDayPhaseMembershipRecord[]>();

        for (const batch of chunk(taskIds)) {
          const [tagRows, subtaskRows, durationRows, projectRows, phaseRows] = await Promise.all([
            query<MyDayTagRecord & { taskId: string }>(pool, `
              SELECT tt.task_id AS "taskId", g.id AS id, g.name AS name, g.slug AS slug,
                     g.type AS type, g.color AS color
              FROM task_tags tt
              INNER JOIN tags g ON g.id = tt.tag_id
              WHERE tt.task_id = ANY($1::text[])
              ORDER BY tt.task_id, g.id
            `, [batch]),
            query<{ parentId: string | null; total: number; done: number }>(pool, `
              SELECT t.parent_id AS "parentId", COUNT(*)::int AS total,
                     SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)::int AS done
              FROM tasks t
              WHERE t.parent_id = ANY($1::text[]) AND ${activeVisibleTask('t')}
              GROUP BY t.parent_id
            `, [batch]),
            query<{ taskId: string; estimatedDuration: number | null }>(pool, `
              SELECT task_id AS "taskId", estimated_duration AS "estimatedDuration"
              FROM task_schedules WHERE task_id = ANY($1::text[])
            `, [batch]),
            query<{ taskId: string; projectId: string }>(pool, `
              SELECT task_id AS "taskId", project_id AS "projectId"
              FROM task_projects WHERE task_id = ANY($1::text[])
              ORDER BY task_id, project_id
            `, [batch]),
            query<MyDayPhaseMembershipRecord & { taskId: string }>(pool, `
              SELECT i.task_id AS "taskId", p.project_id AS "projectId",
                     p.id AS "phaseId", p.name AS "phaseName"
              FROM project_phase_items i
              INNER JOIN project_phases p ON p.id = i.phase_id
              WHERE i.task_id = ANY($1::text[]) AND p.project_id IS NOT NULL
              ORDER BY i.task_id, p.project_id, p.id
            `, [batch]),
          ]);

          for (const { taskId, ...tag } of tagRows) {
            if (!tagsByTask.has(taskId)) tagsByTask.set(taskId, []);
            tagsByTask.get(taskId)!.push(tag);
          }
          for (const row of subtaskRows) {
            if (row.parentId) {
              subtasks.set(row.parentId, {
                total: toCount(row.total),
                done: toCount(row.done),
              });
            }
          }
          for (const row of durationRows) durations.set(row.taskId, row.estimatedDuration);
          for (const row of projectRows) {
            if (!projectsByTask.has(row.taskId)) projectsByTask.set(row.taskId, []);
            projectsByTask.get(row.taskId)!.push(row.projectId);
          }
          for (const { taskId, ...membership } of phaseRows) {
            if (!phasesByTask.has(taskId)) phasesByTask.set(taskId, []);
            phasesByTask.get(taskId)!.push(membership);
          }
        }

        const items: MyDayItemRecord[] = itemRows.map((row) => {
          const counts = subtasks.get(row.taskId);
          return {
            ...row,
            order: Number(row.order ?? 0),
            pushCount: toCount(row.pushCount),
            effort: row.effort === null || row.effort === undefined ? null : Number(row.effort),
            metadata: toJson(row.metadata),
            tags: tagsByTask.get(row.taskId) ?? [],
            subtaskTotal: counts?.total ?? 0,
            subtaskDone: counts?.done ?? 0,
            hubProjectIds: projectsByTask.get(row.taskId) ?? [],
            projectPhases: phasesByTask.get(row.taskId) ?? [],
            estimatedDuration: durations.get(row.taskId) ?? null,
          };
        });

        const limit = input.suggestionLimit;
        const openTopVisible = `${openTask('t')} AND ${topLevelTask('t')}
          AND ${activeVisibleTask('t')}`;

        const [carriedRows, signalRows] = await Promise.all([
          query<{ taskId: string }>(pool, `
            SELECT task_id AS "taskId" FROM my_day_items
            GROUP BY task_id HAVING COUNT(*) >= $1
            ORDER BY task_id
          `, [input.carriedForwardMinimum]),
          input.frictionEventTypes.length > 0
            ? query<{ taskId: string; count: number }>(pool, `
                SELECT task_id AS "taskId", COUNT(*)::int AS count
                FROM task_history_events
                WHERE event_type = ANY($1::text[]) AND occurred_at >= $2
                GROUP BY task_id
                ORDER BY COUNT(*) DESC, task_id
                LIMIT $3
              `, [[...input.frictionEventTypes], input.frictionSince, limit])
            : Promise.resolve([]),
        ]);

        const carriedIds = carriedRows
          .map((row) => row.taskId)
          .filter((taskId) => !excluded.has(taskId));
        const signalCounts = new Map(signalRows.map((row) => [row.taskId, toCount(row.count)]));
        const signalIds = signalRows
          .map((row) => row.taskId)
          .filter((taskId) => !excluded.has(taskId));

        const byIds = async (ids: readonly string[]): Promise<MyDaySuggestionRecord[]> => (
          ids.length === 0 ? [] : (await query<RawSuggestionRow>(pool, `
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.id = ANY($1::text[]) AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $2
          `, [[...ids], limit])).map(suggestionFromRow)
        );

        const [
          signalledTasks,
          carriedForward,
          yesterday,
          overdue,
          dueToday,
          dueThisWeek,
          planningNext,
          highPriority,
          aiRecommended,
          recentlyAdded,
          repeatedlyRescheduled,
        ] = await Promise.all([
          byIds(signalIds),
          byIds(carriedIds),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM my_day_items m
            INNER JOIN tasks t ON t.id = m.task_id
            WHERE m.date = $1 AND ${openTask('t')} AND ${topLevelTask('t')}
              AND ${activeVisibleTask('t')}
            ORDER BY m."order", m.id
            LIMIT $2
          `, [input.yesterday, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.due_date < $1 AND t.status = 'todo' AND ${topLevelTask('t')}
              AND ${activeVisibleTask('t')}
            ORDER BY t.id
            LIMIT $2
          `, [input.date, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.due_date = $1 AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $2
          `, [input.date, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.due_date > $1 AND t.due_date <= $2 AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $3
          `, [input.date, input.dueThrough, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.planning_horizon = 'next' AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $1
          `, [limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.status = 'todo' AND t.priority IN ('critical', 'high')
              AND ${topLevelTask('t')} AND ${activeVisibleTask('t')}
            ORDER BY t.id
            LIMIT $1
          `, [limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.updated_at >= $1 AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $2
          `, [input.activitySince, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.created_at >= $1 AND ${openTopVisible}
            ORDER BY t.id
            LIMIT $2
          `, [input.activitySince, limit], excluded),
          listSuggestions(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.push_count >= 2 AND ${openTopVisible}
            ORDER BY t.push_count DESC, t.due_date ASC NULLS FIRST, t.id
            LIMIT $1
          `, [limit], excluded),
        ]);

        const planningSignals: MyDaySignalledSuggestionRecord[] = signalledTasks
          .map((task) => ({ ...task, planningSignalCount: signalCounts.get(task.id) ?? 0 }));

        return {
          items,
          suggestions: {
            planningSignals,
            carriedForward,
            yesterday,
            overdue,
            dueToday,
            dueThisWeek,
            planningNext,
            highPriority,
            aiRecommended,
            recentlyAdded,
            repeatedlyRescheduled,
          },
        };
      },

      async includeCompletedTasks({ date, dayStart, nextDayStart }): Promise<
        MyDayAutoIncludeResult
      > {
        if ((await listPendingAutoIncludes(pool, date, dayStart, nextDayStart)).length === 0) {
          return { outcome: 'noop' };
        }
        return withMutationTransaction(
          pool,
          [myDayLockKey(date)],
          async (client): Promise<MyDayAutoIncludeResult> => {
            const pending = await listPendingAutoIncludes(client, date, dayStart, nextDayStart);
            if (pending.length === 0) return { outcome: 'noop' };
            const [max] = await query<{ max: number | null }>(
              client,
              'SELECT MAX("order") AS max FROM my_day_items WHERE date = $1',
              [date],
            );
            let order = (max?.max || 0) + 1;
            const rows: MyDayRowInsert[] = pending.map((task) => ({
              id: `md-completed-${crypto.randomUUID().slice(0, 8)}`,
              taskId: task.id,
              date,
              addedAt: task.completedAt,
              isAutoIncluded: true,
              order: order++,
            }));
            return { outcome: 'applied', inserted: await insertMyDayRowsLocked(client, rows) };
          },
        );
      },

      async replaceOrder({ date, orderedItemIds }) {
        return withMutationTransaction(
          pool,
          [myDayLockKey(date)],
          async (client): Promise<{ outcome: 'saved' | 'stale' }> => {
            const visible = new Set((await query<{ id: string }>(client, `
              SELECT m.id AS id FROM my_day_items m
              INNER JOIN tasks t ON t.id = m.task_id
              WHERE m.date = $1 AND ${activeVisibleTask('t')}
            `, [date])).map((row) => row.id));

            if (
              visible.size !== orderedItemIds.length
              || orderedItemIds.some((id) => !visible.has(id))
            ) {
              return { outcome: 'stale' };
            }

            const hidden = (await query<{ id: string }>(
              client,
              'SELECT id FROM my_day_items WHERE date = $1 ORDER BY "order", id',
              [date],
            )).map((row) => row.id).filter((id) => !visible.has(id));

            const complete = [...orderedItemIds, ...hidden];
            for (let index = 0; index < complete.length; index++) {
              await client.query(
                'UPDATE my_day_items SET "order" = $1 WHERE id = $2 AND date = $3',
                [index + 1, complete[index], date],
              );
            }
            return { outcome: 'saved' };
          },
        );
      },

      async add(command): Promise<AddMyDayItemResult> {
        return withMutationTransaction(
          pool,
          [myDayLockKey(command.date)],
          async (client): Promise<AddMyDayItemResult> => {
            const [existing] = await query<{ id: string }>(client, `
              SELECT id FROM my_day_items WHERE task_id = $1 AND date = $2 LIMIT 1
            `, [command.taskId, command.date]);
            if (existing) return { outcome: 'exists', id: existing.id };

            const [max] = await query<{ max: number | null }>(
              client,
              'SELECT MAX("order") AS max FROM my_day_items WHERE date = $1',
              [command.date],
            );
            const order = (max?.max || 0) + 1;

            await client.query(`
              INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
              VALUES ($1, $2, $3, $4, FALSE, $5)
            `, [command.id, command.taskId, command.date, command.addedAt, order]);
            await appendSignal(
              client,
              command.taskId,
              'my_day_committed',
              command.date,
              command.addedAt,
              command.signal,
            );
            return { outcome: 'added', id: command.id, order };
          },
        );
      },

      async remove(command) {
        const [addressed] = command.itemId
          ? await query<{ date: string }>(
              pool,
              'SELECT date FROM my_day_items WHERE id = $1',
              [command.itemId],
            )
          : [{ date: command.date }];
        const lockDate = addressed?.date ?? command.date;

        return withMutationTransaction(
          pool,
          [myDayLockKey(lockDate)],
          async (client): Promise<{ taskId: string | null }> => {
            let removedTaskId = command.taskId;
            let removedDate = command.date;
            let removed = false;

            if (command.itemId) {
              const [item] = await query<{ taskId: string; date: string }>(
                client,
                'SELECT task_id AS "taskId", date FROM my_day_items WHERE id = $1',
                [command.itemId],
              );
              removedTaskId = item?.taskId || null;
              removedDate = item?.date || removedDate;
              const result = await client.query(
                'DELETE FROM my_day_items WHERE id = $1',
                [command.itemId],
              );
              removed = (result.rowCount ?? 0) > 0;
            } else if (command.taskId) {
              const result = await client.query(
                'DELETE FROM my_day_items WHERE task_id = $1 AND date = $2',
                [command.taskId, removedDate],
              );
              removed = (result.rowCount ?? 0) > 0;
            }

            if (removedTaskId && removed) {
              await appendSignal(
                client,
                removedTaskId,
                'my_day_withdrawn',
                removedDate,
                command.removedAt,
                command.signal,
              );
              await client.query(`
                INSERT INTO my_day_exclusions (id, task_id, date, removed_at)
                SELECT $1, $2, $3, $4
                WHERE NOT EXISTS (
                  SELECT 1 FROM my_day_exclusions WHERE task_id = $2 AND date = $3
                )
              `, [command.exclusionId, removedTaskId, removedDate, command.removedAt]);
            }
            return { taskId: removedTaskId };
          },
        );
      },

      async getRemoteIdentity(taskId) {
        const [row] = await query<{
          sourceId: string;
          connectorType: string;
          connectorInstanceId: string;
        }>(pool, `
          SELECT source_id AS "sourceId", connector_type AS "connectorType",
                 connector_instance_id AS "connectorInstanceId"
          FROM tasks WHERE id = $1
        `, [taskId]);
        return row ?? null;
      },
    },

    myDaySync: {
      async snapshot({ date, connectorInstanceId, archivedDuplicateReasonPrefix }) {
        const [localItems, excluded, recurringHistory, archived] = await Promise.all([
          query<MyDaySyncLocalItem>(pool, `
            SELECT m.id AS id, m.task_id AS "taskId", t.source_id AS "sourceId",
                   m.is_auto_included AS "isAutoIncluded", t.status AS status,
                   t.completed_at AS "completedAt"
            FROM my_day_items m
            INNER JOIN tasks t ON t.id = m.task_id
            WHERE m.date = $1
            ORDER BY m."order", m.id
          `, [date]),
          query<{ taskId: string }>(
            pool,
            'SELECT task_id AS "taskId" FROM my_day_exclusions WHERE date = $1 ORDER BY task_id',
            [date],
          ),
          query<Omit<MyDaySyncRecurringHistoryRecord, 'metadata'> & { metadata: unknown }>(
            pool,
            `SELECT title, source_list_id AS "sourceListId", status,
                    due_date AS "dueDate", completed_at AS "completedAt", metadata
             FROM tasks
             WHERE connector_instance_id = $1 AND depth = 0
             ORDER BY id`,
            [connectorInstanceId],
          ),
          query<{ sourceId: string }>(pool, `
            SELECT source_id AS "sourceId" FROM sync_deletion_snapshots
            WHERE connector_id = $1 AND reason LIKE $2 ESCAPE '\\'
            ORDER BY source_id
          `, [connectorInstanceId, `${escapeLike(archivedDuplicateReasonPrefix)}%`]),
        ]);

        return {
          localItems,
          excludedTaskIds: excluded.map((row) => row.taskId),
          recurringHistory: recurringHistory.map((row) => ({
            ...row,
            metadata: toJson(row.metadata),
          })),
          archivedDuplicateSourceIds: archived.map((row) => row.sourceId),
        };
      },

      async findTasksBySourceIds({ connectorType, connectorInstanceId, sourceIds }) {
        const results: MyDaySyncLocalTask[] = [];
        for (const batch of chunk(sourceIds)) {
          const rows = await query<Omit<MyDaySyncLocalTask, 'metadata'> & { metadata: unknown }>(
            pool,
            `SELECT id, source_id AS "sourceId", metadata, status
             FROM tasks
             WHERE connector_instance_id = $1
               ${connectorType ? 'AND connector_type = $3' : ''}
               AND source_id = ANY($2::text[])`,
            connectorType ? [connectorInstanceId, batch, connectorType] : [
              connectorInstanceId,
              batch,
            ],
          );
          for (const row of rows) {
            if (row.sourceId) results.push({ ...row, metadata: toJson(row.metadata) });
          }
        }
        return results;
      },

      async listCompletedMyDaySiblings({ connectorInstanceId, date }) {
        const rows = await query<
          Omit<MyDaySyncCompletedSibling, 'metadata'> & { metadata: unknown }
        >(pool, `
          SELECT t.source_list_id AS "sourceListId", t.title AS title,
                 t.completed_at AS "completedAt", t.metadata AS metadata
          FROM tasks t
          INNER JOIN my_day_items m ON m.task_id = t.id
          WHERE t.connector_type = 'microsoft-todo' AND t.connector_instance_id = $1
            AND t.status = 'done' AND m.date = $2
          ORDER BY t.id
        `, [connectorInstanceId, date]);
        return rows.map((row) => ({ ...row, metadata: toJson(row.metadata) }));
      },

      async createTaskFromRemote(command) {
        const insert = await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, created_at, updated_at, completed_at, parent_id,
            depth, is_checklist_item, source_list_id, source_list_name, assignee,
            metadata, sync_status, last_synced_at
          ) VALUES (
            $1, $2, 'microsoft-todo', $3, $4, NULL, 'todo', $5, $6, $7, $8, NULL, NULL,
            0, FALSE, $9, NULL, NULL, '{}'::jsonb, 'synced', $10
          )
          ON CONFLICT DO NOTHING
        `, [
          command.id,
          command.sourceId,
          command.connectorInstanceId,
          command.title,
          command.priority,
          command.dueDate,
          command.createdAt,
          command.updatedAt,
          command.sourceListId,
          command.lastSyncedAt,
        ]);

        const [row] = await query<Omit<MyDaySyncLocalTask, 'metadata'> & { metadata: unknown }>(
          pool,
          `SELECT id, source_id AS "sourceId", metadata, status FROM tasks
           WHERE source_id = $1 AND connector_instance_id = $2
           LIMIT 1`,
          [command.sourceId, command.connectorInstanceId],
        );

        return {
          created: (insert.rowCount ?? 0) > 0,
          task: row ? { ...row, metadata: toJson(row.metadata) } : null,
        };
      },

      async applyReconciliation(command) {
        return withMutationTransaction(pool, [myDayLockKey(command.date)], async (client) => {
          const removedRows: Array<{ taskId: string; date: string }> = [];
          for (const batch of chunk(command.removeItemIds)) {
            removedRows.push(...await query<{ taskId: string; date: string }>(
              client,
              `DELETE FROM my_day_items
               WHERE id = ANY($1::text[])
               RETURNING task_id AS "taskId", date`,
              [batch],
            ));
          }
          for (const item of removedRows) {
            await appendSignal(
              client,
              item.taskId,
              'my_day_withdrawn',
              item.date,
              command.removedAt,
              command.signal,
            );
          }

          const [max] = await query<{ max: number | null }>(
            client,
            'SELECT MAX("order") AS max FROM my_day_items WHERE date = $1',
            [command.date],
          );
          let order = (max?.max || 0) + 1;
          const committedRows =
            command.committedRows.map((row) => ({ ...row, order: order++ }));
          const autoIncludedRows =
            command.autoIncludedRows.map((row) => ({ ...row, order: order++ }));
          return {
            added: await insertMyDayRowsLocked(client, committedRows, command.signal),
            dueTodayAdded: await insertMyDayRowsLocked(client, autoIncludedRows),
            removed: removedRows.length,
          };
        });
      },

      async listOpenDueTodayTaskIds({ connectorType, date }) {
        return (await query<{ id: string }>(pool, `
          SELECT id FROM tasks t
          WHERE t.connector_type = $1 AND t.due_date LIKE $2 ESCAPE '\\' AND ${openTask('t')}
          ORDER BY id
        `, [connectorType, `${escapeLike(date)}%`])).map((row) => row.id);
      },

      async listOpenDueTodayTasks({ connectorType, connectorInstanceId, date }) {
        return query<{ id: string; sourceId: string | null; status: string }>(pool, `
          SELECT id, source_id AS "sourceId", status FROM tasks t
          WHERE t.connector_type = $1 AND t.connector_instance_id = $2
            AND t.due_date LIKE $3 ESCAPE '\\' AND ${openTask('t')}
          ORDER BY id
        `, [connectorType, connectorInstanceId, `${escapeLike(date)}%`]);
      },

      async listMyDayTaskIds(date) {
        return (await query<{ taskId: string }>(
          pool,
          'SELECT task_id AS "taskId" FROM my_day_items WHERE date = $1 ORDER BY task_id',
          [date],
        )).map((row) => row.taskId);
      },

      async resolveTaskIdsBySourceIds({ connectorInstanceId, sourceIds }) {
        const results: Array<{ id: string; sourceId: string }> = [];
        for (const batch of chunk(sourceIds)) {
          results.push(...await query<{ id: string; sourceId: string }>(pool, `
            SELECT id, source_id AS "sourceId" FROM tasks
            WHERE connector_instance_id = $1 AND source_id = ANY($2::text[])
            ORDER BY id
          `, [connectorInstanceId, batch]));
        }
        return results;
      },
    },

    oneThing: {
      async getForWeek(weekMonday) {
        return readOneThing(pool, weekMonday);
      },

      async markCompleted({ id, completedAt }) {
        await pool.query(
          'UPDATE weekly_one_thing SET completed_at = $1 WHERE id = $2 AND completed_at IS NULL',
          [completedAt, id],
        );
      },

      async subtaskProgress(taskId) {
        const [row] = await query<{ total: number; done: number | null }>(pool, `
          SELECT COUNT(*)::int AS total,
                 SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END)::int AS done
          FROM tasks WHERE parent_id = $1
        `, [taskId]);
        return { total: toCount(row?.total), done: toCount(row?.done) };
      },

      async listCandidates(limit) {
        return query<WeeklyOneThingCandidate>(pool, `
          SELECT id, title, status, priority, due_date AS "dueDate",
                 connector_type AS "connectorType", source_list_name AS "sourceListName",
                 updated_at AS "updatedAt", depth
          FROM tasks
          WHERE status <> 'done' AND status <> 'cancelled' AND depth = 0
          ORDER BY id
          LIMIT $1
        `, [limit]);
      },

      async listMyDayTaskIds(date) {
        return (await query<{ taskId: string }>(
          pool,
          'SELECT task_id AS "taskId" FROM my_day_items WHERE date = $1 ORDER BY task_id',
          [date],
        )).map((row) => row.taskId);
      },

      async selectAuto(command) {
        return withMutationTransaction(
          pool,
          [oneThingLockKey(command.weekMonday)],
          async (client): Promise<{ outcome: 'selected' | 'existing' }> => {
            const existing = await query(
              client,
              'SELECT 1 FROM weekly_one_thing WHERE week_monday = $1 LIMIT 1',
              [command.weekMonday],
            );
            if (existing.length > 0) return { outcome: 'existing' };
            await client.query(`
              INSERT INTO weekly_one_thing
                (id, task_id, week_monday, is_manual_override, completed_at, created_at)
              VALUES ($1, $2, $3, FALSE, NULL, $4)
            `, [command.id, command.taskId, command.weekMonday, command.createdAt]);
            return { outcome: 'selected' };
          },
        );
      },

      async selectManual(command) {
        return withMutationTransaction(
          pool,
          [oneThingLockKey(command.weekMonday)],
          async (client): Promise<{ outcome: 'selected' | 'task-not-found' }> => {
            const task = await query(
              client,
              'SELECT 1 FROM tasks WHERE id = $1 LIMIT 1',
              [command.taskId],
            );
            if (task.length === 0) return { outcome: 'task-not-found' };
            await client.query(
              'DELETE FROM weekly_one_thing WHERE week_monday = $1',
              [command.weekMonday],
            );
            await client.query(`
              INSERT INTO weekly_one_thing
                (id, task_id, week_monday, is_manual_override, completed_at, created_at)
              VALUES ($1, $2, $3, TRUE, NULL, $4)
            `, [command.id, command.taskId, command.weekMonday, command.createdAt]);
            return { outcome: 'selected' };
          },
        );
      },

      async clearForWeek(weekMonday) {
        await withMutationTransaction(pool, [oneThingLockKey(weekMonday)], async (client) => {
          await client.query(
            'DELETE FROM weekly_one_thing WHERE week_monday = $1',
            [weekMonday],
          );
        });
      },
    },

    schedule: {
      async listForDate(date) {
        return query<ScheduledTaskRecord>(pool, `
          SELECT s.task_id AS "taskId", s.scheduled_date AS "scheduledDate",
                 s.scheduled_time AS "scheduledTime",
                 s.estimated_duration AS "estimatedDuration",
                 s.is_time_blocked AS "isTimeBlocked", s.recurrence AS recurrence,
                 t.title AS title, t.status AS status, t.priority AS priority,
                 t.due_date AS "dueDate", t.connector_type AS "connectorType",
                 t.source_list_name AS "sourceListName"
          FROM task_schedules s
          INNER JOIN tasks t ON t.id = s.task_id
          WHERE s.scheduled_date = $1
          ORDER BY s.scheduled_time ASC NULLS FIRST, s.task_id
        `, [date]);
      },

      async upsert(command) {
        await pool.query(`
          INSERT INTO task_schedules (
            task_id, scheduled_date, scheduled_time, estimated_duration,
            is_time_blocked, recurrence
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (task_id) DO UPDATE SET
            scheduled_date = excluded.scheduled_date,
            scheduled_time = excluded.scheduled_time,
            estimated_duration = excluded.estimated_duration,
            is_time_blocked = excluded.is_time_blocked,
            recurrence = excluded.recurrence
        `, [
          command.taskId,
          command.scheduledDate,
          command.scheduledTime,
          command.estimatedDuration,
          command.isTimeBlocked,
          command.recurrence,
        ]);
      },

      async remove(taskId) {
        await pool.query('DELETE FROM task_schedules WHERE task_id = $1', [taskId]);
      },
    },

    recentWins: {
      async listRecentCompletions({ completedFrom }) {
        return query<RecentWinRecord>(pool, `
          SELECT t.id AS id, t.title AS title, t.priority AS priority,
                 t.completed_at AS "completedAt", t.connector_type AS "connectorType",
                 t.source_list_name AS "sourceListName", t.due_date AS "dueDate",
                 s.recurrence AS recurrence
          FROM tasks t
          LEFT JOIN task_schedules s ON s.task_id = t.id
          WHERE t.status = 'done' AND t.completed_at >= $1
          ORDER BY t.completed_at DESC NULLS LAST, t.id
        `, [completedFrom]);
      },
    },
  };
}
