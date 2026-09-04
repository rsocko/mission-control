import type { Pool } from 'pg';
import type {
  AnalyticsDeliveryFilter,
  AnalyticsDeliveryRecord,
  AnalyticsFilterOptions,
  AnalyticsFlowTask,
  AnalyticsFocusItemStatus,
  AnalyticsInstantRange,
  AnalyticsLocalDateRange,
  AnalyticsPersistence,
  AnalyticsPlanningFrictionEvent,
  AnalyticsProject,
  AnalyticsRankedTaskValue,
  AnalyticsRoutine,
  AnalyticsRoutineCompletion,
  AnalyticsRoutineCompletionCount,
  AnalyticsSourceCount,
  AnalyticsTag,
  AnalyticsTaggedTask,
  AnalyticsTagUsage,
  AnalyticsTaskProjectMembership,
  AnalyticsTaskTagLink,
  AnalyticsTaskTagName,
  AnalyticsTaskTransition,
  AnalyticsWordInsightTask,
  FlowAnalyticsRepository,
  InsightsAnalyticsRepository,
  KpiAnalyticsRepository,
  TagInsightsAnalyticsRepository,
  WordInsightsAnalyticsRepository,
} from '@/db/persistence/analytics';

/**
 * PostgreSQL adapter for the L17 derived-analytics read boundary.
 *
 * Every method issues one pooled statement and releases it. Nothing here opens
 * a transaction, takes a row lock, or raises the isolation level: the SQLite
 * surface this replaces runs each read in autocommit, and its multi-query
 * composites are deliberately non-atomic. Introducing a snapshot would give
 * callers a consistency guarantee they do not have today and would pin a
 * pooled connection across a wide fan-out.
 *
 * Three deliberate translations keep results identical to SQLite:
 *
 * 1. SQLite compares instants with `julianday(...)`, which tolerates precision
 *    and offset variation, yields `NULL` (so the row is excluded rather than
 *    raising) for unparsable text, and reads offsetless text as UTC.
 *    {@link instant} reproduces all three with a guarded `CASE`; a bare
 *    `col::timestamptz` would raise on bad text and resolve offsetless text
 *    against the session `TimeZone`.
 * 2. SQLite's default `BINARY` collation orders text by bytes, so every text
 *    `ORDER BY`, window `ORDER BY`, and `row_number()` partition order here is
 *    pinned with `COLLATE "C"`. The database's locale-aware default collation
 *    would silently reorder hyphenated IDs and punctuated names.
 * 3. SQLite's `lower()` folds ASCII only, so the synthetic-tag prefix scan uses
 *    `translate(...)` rather than a locale-aware `lower()`.
 */

/**
 * SQLite's date parser (`parseYyyyMmDd` / `parseHhMmSs` / `parseTimezone`)
 * validates each field independently against a fixed range and then computes a
 * Julian day arithmetically. Reproducing it means matching both halves: the
 * accepted domain, and the normalization of anything inside it.
 *
 * Accepted domain, field by field, exactly as SQLite bounds it:
 * year 4 digits, month `01-12`, day `01-31` (never checked against the month's
 * real length), hour `00-24`, minute and second `00-59`, optional fractional
 * seconds of any length, and a zone that is either `Z`/`z` or a signed offset
 * of `00-14` hours and `00-59` minutes. SQLite requires the colon inside that
 * offset, so `+0500` is rejected even though PostgreSQL would accept it. The
 * date/time separator is `T` or whitespace (`t` is not a separator, though `z`
 * is a valid zone), and leading whitespace before the zone and trailing
 * whitespace are both allowed.
 */
const INSTANT_TEXT_PATTERN = String.raw`^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])`
  + String.raw`([T\s]+([01]\d|2[0-4]):[0-5]\d(:[0-5]\d(\.\d+)?)?`
  + String.raw`(\s*([Zz]|[+-](0\d|1[0-4]):[0-5]\d))?)?\s*$`;

const HOUR_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+(\d{2}):`;
const MINUTE_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+\d{2}:(\d{2})`;
const SECOND_CAPTURE = String.raw`^\d{4}-\d{2}-\d{2}[T\s]+\d{2}:\d{2}:(\d{2}(\.\d+)?)`;
const ZONE_SIGN_CAPTURE = String.raw`([+-])\d{2}:\d{2}\s*$`;
const ZONE_HOUR_CAPTURE = String.raw`[+-](\d{2}):\d{2}\s*$`;
const ZONE_MINUTE_CAPTURE = String.raw`[+-]\d{2}:(\d{2})\s*$`;

/**
 * The `julianday()` equivalent: `NULL` for anything outside the domain above,
 * so the row is excluded rather than the query failing.
 *
 * Inside the domain, the value is *constructed* rather than cast, because
 * SQLite normalizes where a cast would reject. Its Julian-day formula adds the
 * day, hour, minute, and second fields linearly, so `2026-02-31` is exactly
 * `2026-02-01` plus 30 days (`2026-03-03`) and `24:30` is exactly the next day
 * at `00:30`. `col::timestamptz` and `pg_input_is_valid` both reject those, and
 * `pg_input_is_valid` also accepts the colon-less offsets SQLite refuses, so
 * neither can express this boundary. Building from `make_date` plus
 * `make_interval` reproduces the linear arithmetic directly. Year 0 exists in
 * SQLite's proleptic calendar and is 1 BC in PostgreSQL's, which `make_date`
 * spells as `-1`.
 *
 * Deliberately not reproduced, and out of the domain above: SQLite's `'now'`
 * keyword, bare Julian-day numbers, time-only strings, and negative years.
 * No writer in this codebase stores any of them in a timestamp column, and
 * honouring `'now'` would make a read nondeterministic.
 */
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

/** `[start, end)` on a stored timestamp column, matching `julianday` bounds. */
function withinInstantRange(column: string, startParam: number, endParam: number): string {
  return `${instant(column)} >= $${startParam}::timestamptz
    AND ${instant(column)} < $${endParam}::timestamptz`;
}

const OPEN_TASK_CONDITION = `status NOT IN ('done', 'cancelled')`;

/**
 * The Drizzle `notificationNeedsAttention()` predicate, reproduced exactly.
 * Note this is deliberately NOT `NOTIFICATION_NEEDS_ATTENTION_SQL`, whose
 * `level <> 'digest'` clause drops rows with a `NULL` level.
 */
function notificationNeedsAttention(nowParam: number): string {
  return `disposition = 'inbox'
    AND source_state IN ('active', 'unknown')
    AND (snoozed_until IS NULL OR snoozed_until <= $${nowParam})
    AND read_state = 'unread'
    AND (level IS NULL OR level IN ('urgent', 'action_needed', 'heads_up', 'fyi'))`;
}

function createKpiRepository(pool: Pool): KpiAnalyticsRepository {
  async function countOpen(extra = '', params: unknown[] = []): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tasks WHERE ${OPEN_TASK_CONDITION}${extra}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  return {
    countOpenTasks: () => countOpen(),
    countOpenTasksDueBefore: (date) => countOpen(' AND due_date < $1', [date]),
    countOpenTasksDueBetween: ({ from, to }) => countOpen(
      ' AND due_date >= $1 AND due_date <= $2',
      [from, to],
    ),
    countOpenTasksInIds: (taskIds) => countOpen(' AND id = ANY($1::text[])', [[...taskIds]]),
    countOpenTasksWithPriorities: (priorities) => countOpen(
      ' AND priority = ANY($1::text[])',
      [[...priorities]],
    ),
    countOpenTasksWithAssignee: () => countOpen(' AND assignee IS NOT NULL'),
    countOpenTasksByConnectorType: (connectorType) => countOpen(
      ' AND connector_type = $1',
      [connectorType],
    ),

    async countNotificationsNeedingAttention() {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM notifications
         WHERE ${notificationNeedsAttention(1)}`,
        [new Date().toISOString()],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async countNotificationsNeedingAttentionInCategory(connectorType, category) {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM notifications
         WHERE connector_type = $2
           AND (${notificationNeedsAttention(1)})
           AND category = $3`,
        [new Date().toISOString(), connectorType, category],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async listMyDayTaskIds(date) {
      const { rows } = await pool.query<{ task_id: string }>(
        'SELECT task_id FROM my_day_items WHERE "date" = $1',
        [date],
      );
      return rows.map((row) => row.task_id);
    },

    countTasksCompletedIn: (range) => countTasksCompletedIn(pool, range),

    async countNonCancelledTasksDueBetween({ from, to }) {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM tasks
         WHERE status <> 'cancelled' AND due_date >= $1 AND due_date <= $2`,
        [from, to],
      );
      return Number(rows[0]?.count ?? 0);
    },

    listActiveRoutines: () => listActiveRoutines(pool),
    listRoutineCompletionsBetween: (range) => listRoutineCompletionsBetween(pool, range),
    listCompletedTimestampsSince: (startInclusive) => listCompletedTimestampsSince(
      pool,
      startInclusive,
    ),

    async listFocusItemStatuses(scope, date) {
      const { rows } = await pool.query<AnalyticsFocusItemStatus>(
        `SELECT item.id AS id, task.status AS status
         FROM focus_items item
         INNER JOIN tasks task ON item.task_id = task.id
         WHERE item.scope = $1 AND item."date" = $2`,
        [scope, date],
      );
      return rows;
    },

    async countTriageItemsWithStatus(status) {
      const { rows } = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM triage_items WHERE status = $1',
        [status],
      );
      return Number(rows[0]?.count ?? 0);
    },

    async countTriageItemsWithStatusCapturedBefore(status, capturedBefore) {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM triage_items
         WHERE status = $1 AND captured_at < $2`,
        [status, capturedBefore],
      );
      return Number(rows[0]?.count ?? 0);
    },
  };
}

async function countTasksCompletedIn(
  pool: Pool,
  { startInclusive, endExclusive }: AnalyticsInstantRange,
): Promise<number> {
  const { rows } = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM tasks
     WHERE status = 'done' AND ${withinInstantRange('completed_at', 1, 2)}`,
    [startInclusive, endExclusive],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Shared by the KPI and insights repositories; `id` is the added tiebreaker. */
async function listActiveRoutines(pool: Pool): Promise<AnalyticsRoutine[]> {
  const { rows } = await pool.query<{
    id: string;
    name: string;
    icon: string | null;
    cadence_type: string;
    cadence_config: unknown;
  }>(
    `SELECT id, name, icon, cadence_type, cadence_config
     FROM routines
     WHERE is_active = true AND is_archived = false
     ORDER BY id COLLATE "C"`,
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    icon: row.icon,
    cadenceType: row.cadence_type,
    cadenceConfig: row.cadence_config,
  }));
}

async function listRoutineCompletionsBetween(
  pool: Pool,
  { from, to }: AnalyticsLocalDateRange,
): Promise<AnalyticsRoutineCompletion[]> {
  const { rows } = await pool.query<{ routine_id: string; date: string }>(
    `SELECT routine_id, "date"
     FROM routine_completions
     WHERE "date" >= $1 AND "date" <= $2
     ORDER BY routine_id COLLATE "C", "date" COLLATE "C"`,
    [from, to],
  );
  return rows.map((row) => ({ routineId: row.routine_id, date: row.date }));
}

async function listCompletedTimestampsSince(
  pool: Pool,
  startInclusive: string,
): Promise<Array<string | null>> {
  const { rows } = await pool.query<{ completed_at: string | null }>(
    `SELECT completed_at FROM tasks
     WHERE status = 'done' AND ${instant('completed_at')} >= $1::timestamptz`,
    [startInclusive],
  );
  return rows.map((row) => row.completed_at);
}

function createInsightsRepository(pool: Pool): InsightsAnalyticsRepository {
  const completedIn = withinInstantRange('completed_at', 1, 2);
  const createdTopLevelIn = `depth = 0 AND is_checklist_item = false
    AND ${withinInstantRange('created_at', 1, 2)}`;

  async function countTasks(where: string, range: AnalyticsInstantRange): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM tasks WHERE ${where}`,
      [range.startInclusive, range.endExclusive],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async function countProjectTasks(
    where: string,
    params: unknown[],
  ): Promise<number> {
    const { rows } = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM task_projects membership
       INNER JOIN tasks task ON membership.task_id = task.id
       WHERE ${where}`,
      params,
    );
    return Number(rows[0]?.count ?? 0);
  }

  return {
    countTasksCompletedIn: (range) => countTasks(`status = 'done' AND ${completedIn}`, range),
    countTopLevelTasksCreatedIn: (range) => countTasks(createdTopLevelIn, range),

    async listCompletedTimestampsIn({ startInclusive, endExclusive }) {
      const { rows } = await pool.query<{ timestamp: string | null }>(
        `SELECT completed_at AS timestamp FROM tasks
         WHERE status = 'done' AND ${completedIn}`,
        [startInclusive, endExclusive],
      );
      return rows.map((row) => row.timestamp);
    },

    async listCreatedTimestampsIn({ startInclusive, endExclusive }) {
      const { rows } = await pool.query<{ timestamp: string }>(
        `SELECT created_at AS timestamp FROM tasks WHERE ${createdTopLevelIn}`,
        [startInclusive, endExclusive],
      );
      return rows.map((row) => row.timestamp);
    },

    async listCompletionSpansIn({ startInclusive, endExclusive }) {
      const { rows } = await pool.query<{
        created_at: string;
        completed_at: string | null;
      }>(
        `SELECT created_at, completed_at FROM tasks
         WHERE status = 'done' AND ${completedIn}`,
        [startInclusive, endExclusive],
      );
      return rows.map((row) => ({ createdAt: row.created_at, completedAt: row.completed_at }));
    },

    listCompletedTimestampsSince: (startInclusive) => listCompletedTimestampsSince(
      pool,
      startInclusive,
    ),

    async sourceBreakdownIn({ startInclusive, endExclusive }) {
      // `connector_type` is the added tiebreaker for equal counts.
      const { rows } = await pool.query<{ source: string; count: number }>(
        `SELECT connector_type AS source, count(*)::int AS count
         FROM tasks
         WHERE status = 'done' AND ${completedIn}
         GROUP BY connector_type
         ORDER BY count(*) DESC, connector_type COLLATE "C" ASC`,
        [startInclusive, endExclusive],
      );
      return rows.map((row): AnalyticsSourceCount => ({
        source: row.source,
        count: Number(row.count),
      }));
    },

    async listOpenTaskCreatedTimestamps() {
      const { rows } = await pool.query<{ created_at: string }>(
        `SELECT created_at FROM tasks WHERE ${OPEN_TASK_CONDITION}`,
      );
      return rows.map((row) => row.created_at);
    },

    async listPlanningFrictionEvents(eventTypes, { startInclusive, endExclusive }) {
      const { rows } = await pool.query<{
        task_id: string;
        event_type: string;
        previous_value: string | null;
        new_value: string | null;
        title: string;
        due_date: string | null;
        push_count: number;
        source_list_name: string | null;
      }>(
        `SELECT history.task_id, history.event_type, history.previous_value, history.new_value,
                task.title, task.due_date, task.push_count, task.source_list_name
         FROM task_history_events history
         INNER JOIN tasks task ON history.task_id = task.id
         WHERE history.event_type = ANY($3::text[])
           AND ${withinInstantRange('history.occurred_at', 1, 2)}
           AND task.depth = 0
           AND task.is_checklist_item = false`,
        [startInclusive, endExclusive, [...eventTypes]],
      );
      return rows.map((row): AnalyticsPlanningFrictionEvent => ({
        taskId: row.task_id,
        eventType: row.event_type,
        previousValue: row.previous_value,
        newValue: row.new_value,
        title: row.title,
        dueDate: row.due_date,
        pushCount: Number(row.push_count),
        sourceListName: row.source_list_name,
      }));
    },

    async listTaskTagNames(taskIds) {
      const { rows } = await pool.query<{ task_id: string; name: string }>(
        `SELECT link.task_id, tag.name
         FROM task_tags link
         INNER JOIN tags tag ON link.tag_id = tag.id
         WHERE link.task_id = ANY($1::text[])`,
        [[...taskIds]],
      );
      return rows.map((row): AnalyticsTaskTagName => ({ taskId: row.task_id, name: row.name }));
    },

    async listActiveProjects() {
      // `name, id` is the added tiebreaker; the caller's later sort is stable.
      const { rows } = await pool.query<AnalyticsProject>(
        `SELECT id, name, color FROM hub_projects
         WHERE status = 'active'
         ORDER BY name COLLATE "C", id COLLATE "C"`,
      );
      return rows;
    },

    countProjectTasksCompletedIn: (projectId, range) => countProjectTasks(
      `membership.project_id = $3 AND task.status = 'done'
       AND ${withinInstantRange('task.completed_at', 1, 2)}`,
      [range.startInclusive, range.endExclusive, projectId],
    ),

    async countProjectOpenTasks(projectId) {
      const { rows } = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM task_projects membership
         INNER JOIN tasks task ON membership.task_id = task.id
         WHERE membership.project_id = $1 AND task.${OPEN_TASK_CONDITION}`,
        [projectId],
      );
      return Number(rows[0]?.count ?? 0);
    },

    countProjectTopLevelTasksCreatedIn: (projectId, range) => countProjectTasks(
      `membership.project_id = $3 AND task.depth = 0 AND task.is_checklist_item = false
       AND ${withinInstantRange('task.created_at', 1, 2)}`,
      [range.startInclusive, range.endExclusive, projectId],
    ),

    listActiveRoutines: () => listActiveRoutines(pool),
    listRoutineCompletionsBetween: (range) => listRoutineCompletionsBetween(pool, range),

    async listRoutineCompletionsInHalfOpenRange(fromInclusive, toExclusive) {
      const { rows } = await pool.query<{ routine_id: string; date: string }>(
        `SELECT routine_id, "date"
         FROM routine_completions
         WHERE "date" >= $1 AND "date" < $2
         ORDER BY routine_id COLLATE "C", "date" COLLATE "C"`,
        [fromInclusive, toExclusive],
      );
      return rows.map((row) => ({ routineId: row.routine_id, date: row.date }));
    },

    async countRoutineCompletionsByDate({ from, to }) {
      const { rows } = await pool.query<{ date: string; count: number }>(
        `SELECT "date", count(*)::int AS count
         FROM routine_completions
         WHERE "date" >= $1 AND "date" <= $2
         GROUP BY "date"`,
        [from, to],
      );
      return rows.map((row): AnalyticsRoutineCompletionCount => ({
        date: row.date,
        count: Number(row.count),
      }));
    },

    async deliveryFilterOptions(): Promise<AnalyticsFilterOptions> {
      // `id` is the added tiebreaker for equal project names.
      const [projects, sources] = await Promise.all([
        pool.query<{ value: string; label: string }>(
          `SELECT id AS value, name AS label FROM hub_projects
           WHERE hidden = false
           ORDER BY name COLLATE "C", id COLLATE "C"`,
        ),
        pool.query<{ value: string }>(
          // `GROUP BY` rather than `DISTINCT`: PostgreSQL requires a
          // `SELECT DISTINCT` query's `ORDER BY` expressions to appear in the
          // select list, which a collated expression never does.
          `SELECT connector_type AS value FROM tasks
           GROUP BY connector_type
           ORDER BY connector_type COLLATE "C"`,
        ),
      ]);
      return {
        projects: projects.rows,
        sources: sources.rows.map((row) => row.value),
      };
    },

    async listDeliveryRecords(
      { startInclusive, endExclusive }: AnalyticsInstantRange,
      filters: AnalyticsDeliveryFilter,
    ) {
      const params: unknown[] = [startInclusive, endExclusive];
      let sourceClause = '';
      if (filters.source) {
        params.push(filters.source);
        sourceClause = ` AND task.connector_type = $${params.length}`;
      }
      const selection = `task.id, task.title, task.created_at, task.completed_at,
        task.connector_type AS source, task.status_reason`;
      const conditions = `task.status = 'done'
        AND task.completed_at IS NOT NULL
        AND ${withinInstantRange('task.completed_at', 1, 2)}${sourceClause}`;
      // `completed_at, id` is the added tiebreaker.
      const ordering = 'ORDER BY task.completed_at COLLATE "C", task.id COLLATE "C"';

      let text: string;
      if (filters.projectId) {
        params.push(filters.projectId);
        // `GROUP BY task.id` deduplicates a task in several projects exactly as
        // `SELECT DISTINCT` does (the id is the primary key), without
        // PostgreSQL's rule that a `DISTINCT` query's `ORDER BY` expressions
        // must appear in the select list - which a collated one never does.
        text = `SELECT ${selection}
          FROM tasks task
          INNER JOIN task_projects membership ON membership.task_id = task.id
          WHERE ${conditions} AND membership.project_id = $${params.length}
          GROUP BY task.id
          ${ordering}`;
      } else {
        text = `SELECT ${selection} FROM tasks task WHERE ${conditions} ${ordering}`;
      }

      const { rows } = await pool.query<{
        id: string;
        title: string;
        created_at: string;
        completed_at: string | null;
        source: string;
        status_reason: string | null;
      }>(text, params);
      return rows.map((row): AnalyticsDeliveryRecord => ({
        id: row.id,
        title: row.title,
        createdAt: row.created_at,
        completedAt: row.completed_at,
        source: row.source,
        statusReason: row.status_reason,
      }));
    },
  };
}

function createFlowRepository(pool: Pool): FlowAnalyticsRepository {
  return {
    async listFlowTasks() {
      const { rows } = await pool.query<AnalyticsFlowTask>(
        `SELECT id, title, status, priority, connector_type AS source
         FROM tasks WHERE is_checklist_item = false`,
      );
      return rows;
    },

    async listTaskProjectMemberships() {
      const { rows } = await pool.query<{ task_id: string; project_id: string }>(
        'SELECT task_id, project_id FROM task_projects',
      );
      return rows.map((row): AnalyticsTaskProjectMembership => ({
        taskId: row.task_id,
        projectId: row.project_id,
      }));
    },

    async listVisibleProjects() {
      const { rows } = await pool.query<AnalyticsProject>(
        `SELECT id, name, color FROM hub_projects
         WHERE hidden = false
         ORDER BY name COLLATE "C"`,
      );
      return rows;
    },

    async listTaskTransitions({ startInclusive, endExclusive }, eventTypes) {
      // Mirrors `getTaskTransitionsInRange`: an empty type filter selects
      // nothing, and the range is compared as stored text, not as an instant.
      if (eventTypes.length === 0) return [];
      const { rows } = await pool.query<{
        id: number;
        task_id: string;
        event_type: string;
        previous_value: string | null;
        new_value: string | null;
        project_id: string | null;
        occurred_at: string;
        provenance: string;
      }>(
        `SELECT id, task_id, event_type, previous_value, new_value,
                project_id, occurred_at, provenance
         FROM task_history_events
         WHERE occurred_at >= $1 AND occurred_at < $2 AND event_type = ANY($3::text[])
         ORDER BY occurred_at COLLATE "C" ASC, id ASC`,
        [startInclusive, endExclusive, [...eventTypes]],
      );
      return rows.map((row): AnalyticsTaskTransition => ({
        id: Number(row.id),
        taskId: row.task_id,
        eventType: row.event_type,
        previousValue: row.previous_value,
        newValue: row.new_value,
        projectId: row.project_id,
        occurredAt: row.occurred_at,
        provenance: row.provenance,
      }));
    },
  };
}

/** ASCII-only folding: SQLite's `lower()` never folds non-ASCII letters. */
const ASCII_FOLDED_TAG_NAME =
  `translate(btrim(name), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;

function createTagInsightsRepository(pool: Pool): TagInsightsAnalyticsRepository {
  return {
    async listSyntheticTagCandidates() {
      const { rows } = await pool.query<AnalyticsTag>(
        `SELECT id, name FROM tags
         WHERE ${ASCII_FOLDED_TAG_NAME} LIKE 'priority%'
            OR ${ASCII_FOLDED_TAG_NAME} IN ('p0', 'p1', 'p2', 'p3')
            OR ${ASCII_FOLDED_TAG_NAME} LIKE 'effort%'
            OR ${ASCII_FOLDED_TAG_NAME} LIKE 'size%'
            OR ${ASCII_FOLDED_TAG_NAME} LIKE 'estimate%'
            OR ${ASCII_FOLDED_TAG_NAME} LIKE 't-shirt%'
            OR ${ASCII_FOLDED_TAG_NAME} LIKE 'mc:%'`,
      );
      return rows;
    },

    async listBoundedTaggedTasks(excludedTagIds, limit) {
      const params: unknown[] = [];
      let exclusion = '';
      if (excludedTagIds.length > 0) {
        params.push([...excludedTagIds]);
        exclusion = `WHERE NOT (link.tag_id = ANY($${params.length}::text[]))`;
      }
      params.push(limit);
      const { rows } = await pool.query<AnalyticsTaggedTask>(
        `SELECT task.id, task.title, task.status
         FROM tasks task
         INNER JOIN task_tags link ON link.task_id = task.id
         ${exclusion}
         GROUP BY task.id, task.title, task.status
         ORDER BY task.id COLLATE "C"
         LIMIT $${params.length}`,
        params,
      );
      return rows;
    },

    async listTopTags(taskIds, excludedTagIds, topN) {
      const params: unknown[] = [[...taskIds]];
      let exclusion = '';
      if (excludedTagIds.length > 0) {
        params.push([...excludedTagIds]);
        exclusion = ` AND NOT (link.tag_id = ANY($${params.length}::text[]))`;
      }
      params.push(topN);
      const { rows } = await pool.query<{
        id: string;
        name: string;
        color: string | null;
        usage_count: number;
      }>(
        `SELECT tag.id, tag.name, tag.color, count(DISTINCT link.task_id)::int AS usage_count
         FROM tags tag
         INNER JOIN task_tags link ON link.tag_id = tag.id
         WHERE link.task_id = ANY($1::text[])${exclusion}
         GROUP BY tag.id, tag.name, tag.color
         ORDER BY count(DISTINCT link.task_id) DESC,
                  tag.name COLLATE "C" ASC,
                  tag.id COLLATE "C" ASC
         LIMIT $${params.length}`,
        params,
      );
      return rows.map((row): AnalyticsTagUsage => ({
        id: row.id,
        name: row.name,
        color: row.color,
        usageCount: Number(row.usage_count),
      }));
    },

    async listTaskTagLinks(taskIds, tagIds) {
      const { rows } = await pool.query<{ task_id: string; tag_id: string }>(
        `SELECT task_id, tag_id FROM task_tags
         WHERE task_id = ANY($1::text[]) AND tag_id = ANY($2::text[])
         ORDER BY task_id COLLATE "C", tag_id COLLATE "C"`,
        [[...taskIds], [...tagIds]],
      );
      return rows.map((row): AnalyticsTaskTagLink => ({
        taskId: row.task_id,
        tagId: row.tag_id,
      }));
    },
  };
}

function createWordInsightsRepository(pool: Pool): WordInsightsAnalyticsRepository {
  async function listRanked(
    text: string,
    taskIds: readonly string[],
    perTaskLimit: number,
    limit: number,
  ): Promise<AnalyticsRankedTaskValue[]> {
    const { rows } = await pool.query<{ task_id: string; id: string; name: string }>(
      text,
      [[...taskIds], perTaskLimit, limit],
    );
    return rows.map((row) => ({ taskId: row.task_id, id: row.id, name: row.name }));
  }

  const rankedQuery = (
    relation: string,
    joinTable: string,
    joinCondition: string,
    taskColumn: string,
  ) => `
    WITH ranked AS (
      SELECT ${taskColumn} AS task_id, target.id AS id, target.name AS name,
             row_number() OVER (
               PARTITION BY ${taskColumn}
               ORDER BY target.name COLLATE "C", target.id COLLATE "C"
             ) AS source_rank
      FROM ${relation} link
      INNER JOIN ${joinTable} target ON ${joinCondition}
      WHERE ${taskColumn} = ANY($1::text[])
    )
    SELECT task_id, id, name FROM ranked
    WHERE source_rank <= $2
    ORDER BY task_id COLLATE "C", name COLLATE "C", id COLLATE "C"
    LIMIT $3`;

  return {
    async listTasksWithLiveConnector(limit) {
      const { rows } = await pool.query<{
        id: string;
        title: string;
        description: string | null;
        status: string;
        source_list_id: string | null;
        source_list_name: string | null;
      }>(
        `SELECT task.id, task.title, task.description, task.status,
                task.source_list_id, task.source_list_name
         FROM tasks task
         LEFT JOIN connector_configs connector
           ON task.connector_instance_id = connector.id
         WHERE connector.deleted_at IS NULL
         ORDER BY task.id COLLATE "C"
         LIMIT $1`,
        [limit],
      );
      return rows.map((row): AnalyticsWordInsightTask => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        sourceListId: row.source_list_id,
        sourceListName: row.source_list_name,
      }));
    },

    listRankedTaskTags: (taskIds, perTaskLimit, limit) => listRanked(
      rankedQuery('task_tags', 'tags', 'link.tag_id = target.id', 'link.task_id'),
      taskIds,
      perTaskLimit,
      limit,
    ),

    listRankedTaskProjects: (taskIds, perTaskLimit, limit) => listRanked(
      rankedQuery('task_projects', 'hub_projects', 'link.project_id = target.id', 'link.task_id'),
      taskIds,
      perTaskLimit,
      limit,
    ),

    listRankedTaskPhases: (taskIds, perTaskLimit, limit) => listRanked(
      rankedQuery(
        'project_phase_items',
        'project_phases',
        'link.phase_id = target.id',
        'link.task_id',
      ),
      taskIds,
      perTaskLimit,
      limit,
    ),
  };
}

export function createPostgresAnalyticsPersistence(pool: Pool): AnalyticsPersistence {
  return {
    kpis: createKpiRepository(pool),
    insights: createInsightsRepository(pool),
    flow: createFlowRepository(pool),
    tagInsights: createTagInsightsRepository(pool),
    wordInsights: createWordInsightsRepository(pool),
  };
}
