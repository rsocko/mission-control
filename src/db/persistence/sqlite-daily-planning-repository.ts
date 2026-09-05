import type Database from 'better-sqlite3';
import { isDatabaseContentionError } from '@/db/contention';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import type { PersistenceJson } from './contracts';
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
} from './daily-planning';

const BATCH_SIZE = 400;

const NOTIFICATION_ONLY_LIST = NOTIFICATION_ONLY_CONNECTOR_TYPES
  .map((type) => `'${type}'`)
  .join(', ');

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

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function chunk<T>(values: readonly T[], size = BATCH_SIZE): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    batches.push([...values.slice(index, index + size)]);
  }
  return batches;
}

function toBoolean(value: unknown): boolean {
  return value === 1 || value === true;
}

function toJson(value: unknown): PersistenceJson {
  if (typeof value !== 'string') return (value ?? null) as PersistenceJson;
  try {
    return JSON.parse(value) as PersistenceJson;
  } catch {
    return value;
  }
}

function toCount(value: unknown): number {
  return Number(value ?? 0);
}

const SUGGESTION_COLUMNS = `
  t.id AS id, t.title AS title, t.status AS status, t.micro_status AS microStatus,
  t.priority AS priority, t.planning_horizon AS planningHorizon, t.due_date AS dueDate,
  t.push_count AS pushCount, t.connector_type AS connectorType,
  t.connector_instance_id AS connectorInstanceId, t.source_id AS sourceId,
  t.source_list_id AS sourceListId, t.source_list_name AS sourceListName,
  t.metadata AS metadata, t.local_disposition AS localDisposition
`;

interface RawSuggestionRow {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  pushCount: number;
  connectorType: string;
  connectorInstanceId: string;
  sourceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  metadata: unknown;
  localDisposition: string;
}

function suggestionFromRow(row: RawSuggestionRow): MyDaySuggestionRecord {
  return { ...row, pushCount: Number(row.pushCount ?? 0), metadata: toJson(row.metadata) };
}

const FOCUS_COLUMNS = `
  f.id AS id, f.task_id AS taskId, f.scope AS scope, f.date AS date, f.slot AS slot,
  f.added_at AS addedAt, f.is_ai_suggested AS isAiSuggested,
  t.title AS title, t.status AS status, t.micro_status AS microStatus,
  t.priority AS priority, t.due_date AS dueDate, t.connector_type AS connectorType,
  t.connector_instance_id AS connectorInstanceId, t.source_id AS sourceId,
  t.source_list_id AS sourceListId, t.source_list_name AS sourceListName
`;

const ONE_THING_COLUMNS = `
  w.id AS id, w.task_id AS taskId, w.week_monday AS weekMonday,
  w.is_manual_override AS isManualOverride, w.completed_at AS completedAt,
  w.created_at AS createdAt, t.title AS title, t.status AS status,
  t.priority AS priority, t.due_date AS dueDate, t.connector_type AS connectorType,
  t.source_list_name AS sourceListName
`;

export function createSqliteDailyPlanningPersistence(
  sqlite: Database.Database,
): DailyPlanningPersistence {
  function appendSignal(
    taskId: string,
    eventType: string,
    date: string,
    occurredAt: string,
    signal: PlanningSignalCommand,
  ): void {
    sqlite.prepare(`
      INSERT OR IGNORE INTO task_history_events (
        task_id, event_type, field_name, previous_value, new_value,
        occurred_at, recorded_at, provenance, metadata
      ) VALUES (?, ?, 'planningDate', NULL, ?, ?, ?, ?, ?)
    `).run(
      taskId,
      eventType,
      date,
      occurredAt,
      new Date().toISOString(),
      signal.provenance,
      signal.metadata === null ? null : JSON.stringify(signal.metadata),
    );
  }

  function listSuggestions(
    sql: string,
    values: readonly unknown[],
    excluded: Set<string>,
  ): MyDaySuggestionRecord[] {
    return (sqlite.prepare(sql).all(...values) as RawSuggestionRow[])
      .filter((row) => !excluded.has(row.id))
      .map(suggestionFromRow);
  }

  function listPendingAutoIncludes(
    date: string,
    dayStart: string,
    nextDayStart: string,
  ): Array<{ id: string; completedAt: string }> {
    return sqlite.prepare(`
      SELECT t.id AS id, t.completed_at AS completedAt
      FROM tasks t
      WHERE t.status = 'done'
        AND julianday(t.completed_at) >= julianday(?)
        AND julianday(t.completed_at) < julianday(?)
        AND ${topLevelTask('t')}
        AND ${activeVisibleTask('t')}
        AND t.completed_at IS NOT NULL
        AND t.id NOT IN (SELECT task_id FROM my_day_items WHERE date = ?)
        AND t.id NOT IN (SELECT task_id FROM my_day_exclusions WHERE date = ?)
      ORDER BY t.id
    `).all(dayStart, nextDayStart, date, date) as Array<{ id: string; completedAt: string }>;
  }

  function insertMyDayRows(
    rows: readonly MyDayRowInsert[],
    signal?: PlanningSignalCommand,
  ): number {
    if (rows.length === 0) return 0;
    const insert = sqlite.prepare(`
      INSERT OR IGNORE INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    return sqlite.transaction(() => {
      let inserted = 0;
      for (const row of rows) {
        const changed = insert.run(
          row.id,
          row.taskId,
          row.date,
          row.addedAt,
          row.isAutoIncluded ? 1 : 0,
          row.order,
        ).changes;
        inserted += changed;
        if (changed > 0 && signal) {
          appendSignal(
            row.taskId,
            'my_day_committed',
            row.date,
            row.addedAt,
            signal,
          );
        }
      }
      return inserted;
    }).immediate();
  }

  function readOneThing(weekMonday: string): WeeklyOneThingRecord | null {
    const row = sqlite.prepare(`
      SELECT ${ONE_THING_COLUMNS}
      FROM weekly_one_thing w
      INNER JOIN tasks t ON t.id = w.task_id
      WHERE w.week_monday = ?
      ORDER BY w.created_at, w.id
      LIMIT 1
    `).get(weekMonday) as (Omit<WeeklyOneThingRecord, 'isManualOverride'> & {
      isManualOverride: number;
    }) | undefined;
    return row ? { ...row, isManualOverride: toBoolean(row.isManualOverride) } : null;
  }

  return {
    energy: {
      async getForDate(date) {
        const row = sqlite.prepare(`
          SELECT id, date, level, note, created_at AS createdAt
          FROM energy_checkins WHERE date = ?
          ORDER BY created_at, id
          LIMIT 1
        `).get(date) as EnergyCheckinRecord | undefined;
        return row ?? null;
      },

      async replaceForDate(record) {
        sqlite.transaction(() => {
          sqlite.prepare('DELETE FROM energy_checkins WHERE date = ?').run(record.date);
          sqlite.prepare(`
            INSERT INTO energy_checkins (id, date, level, note, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(record.id, record.date, record.level, record.note, record.createdAt);
        }).immediate();
      },
    },

    focus: {
      async listBoard({ date, weekMonday }) {
        const read = (scope: FocusScope, scopeDate: string): FocusItemRecord[] => (
          sqlite.prepare(`
            SELECT ${FOCUS_COLUMNS}
            FROM focus_items f
            INNER JOIN tasks t ON t.id = f.task_id
            WHERE f.scope = ? AND f.date = ?
            ORDER BY f.slot, f.id
          `).all(scope, scopeDate) as Array<
            Omit<FocusItemRecord, 'isAiSuggested'> & { isAiSuggested: number }
          >
        ).map((row) => ({ ...row, isAiSuggested: toBoolean(row.isAiSuggested) }));
        return { today: read('today', date), week: read('week', weekMonday) };
      },

      async add(command): Promise<AddFocusItemResult> {
        return sqlite.transaction((): AddFocusItemResult => {
          const existing = sqlite.prepare(`
            SELECT id, slot, task_id AS taskId FROM focus_items
            WHERE scope = ? AND date = ? ORDER BY slot
          `).all(command.scope, command.date) as Array<{
            id: string;
            slot: number;
            taskId: string;
          }>;

          if (existing.some((item) => item.taskId === command.taskId)) {
            return { outcome: 'duplicate' };
          }
          if (existing.length >= command.maxSlots) return { outcome: 'full' };

          const used = new Set(existing.map((item) => item.slot));
          let slot = 1;
          while (used.has(slot) && slot <= command.maxSlots) slot++;

          sqlite.prepare(`
            INSERT INTO focus_items (id, task_id, scope, date, slot, added_at, is_ai_suggested)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            command.id,
            command.taskId,
            command.scope,
            command.date,
            slot,
            command.addedAt,
            command.isAiSuggested ? 1 : 0,
          );
          if (command.scope === 'today') {
            appendSignal(
              command.taskId,
              'focus_committed',
              command.date,
              command.addedAt,
              command.signal,
            );
          }
          return { outcome: 'added', id: command.id, slot };
        }).immediate();
      },

      async removeById(command) {
        return sqlite.transaction((): { removed: boolean } => {
          const item = sqlite.prepare(
            'SELECT task_id AS taskId, scope, date FROM focus_items WHERE id = ?',
          ).get(command.id) as { taskId: string; scope: FocusScope; date: string } | undefined;
          if (!item) return { removed: false };
          const removed = sqlite.prepare('DELETE FROM focus_items WHERE id = ?')
            .run(command.id).changes > 0;
          if (removed && item.scope === 'today') {
            appendSignal(
              item.taskId,
              'focus_withdrawn',
              item.date,
              command.removedAt,
              command.signal,
            );
          }
          return { removed };
        }).immediate();
      },

      async removeByTask(command) {
        return sqlite.transaction((): { removed: boolean } => {
          const removed = sqlite.prepare(`
            DELETE FROM focus_items WHERE task_id = ? AND scope = ? AND date = ?
          `).run(command.taskId, command.scope, command.date).changes > 0;
          if (removed && command.scope === 'today') {
            appendSignal(
              command.taskId,
              'focus_withdrawn',
              command.date,
              command.removedAt,
              command.signal,
            );
          }
          return { removed };
        }).immediate();
      },

      async moveToSlot({ id, slot }) {
        return sqlite.transaction((): { outcome: 'moved' | 'not-found' } => {
          const item = sqlite.prepare(
            'SELECT id, scope, date, slot FROM focus_items WHERE id = ?',
          ).get(id) as { id: string; scope: string; date: string; slot: number } | undefined;
          if (!item) return { outcome: 'not-found' };

          const occupant = sqlite.prepare(`
            SELECT id, slot FROM focus_items
            WHERE scope = ? AND date = ? AND slot = ? AND id <> ?
            LIMIT 1
          `).get(item.scope, item.date, slot, id) as { id: string; slot: number } | undefined;

          if (occupant) {
            // Park the occupant on the reserved sentinel slot so the unique
            // (scope, date, slot) index never sees two rows in one slot.
            sqlite.prepare('UPDATE focus_items SET slot = 0 WHERE id = ?').run(occupant.id);
            sqlite.prepare('UPDATE focus_items SET slot = ? WHERE id = ?').run(slot, id);
            sqlite.prepare('UPDATE focus_items SET slot = ? WHERE id = ?')
              .run(item.slot, occupant.id);
          } else {
            sqlite.prepare('UPDATE focus_items SET slot = ? WHERE id = ?').run(slot, id);
          }
          return { outcome: 'moved' };
        }).immediate();
      },
    },

    dashboard: {
      async snapshot(query) {
        const scalar = (sql: string, values: readonly unknown[] = []): number => toCount(
          (sqlite.prepare(sql).get(...values) as { count: number } | undefined)?.count,
        );
        const openTopLevel = `${openTask('t')} AND t.parent_id IS NULL`;
        return {
          totalOpen: scalar(
            `SELECT count(*) AS count FROM tasks t WHERE ${openTopLevel}`,
          ),
          completedToday: scalar(`
            SELECT count(*) AS count FROM tasks t
            WHERE t.status = 'done' AND t.parent_id IS NULL
              AND julianday(t.completed_at) >= julianday(?)
              AND julianday(t.completed_at) < julianday(?)
          `, [query.completedFrom, query.completedTo]),
          inProgress: scalar(`
            SELECT count(*) AS count FROM tasks t
            WHERE t.status = 'in_progress' AND t.parent_id IS NULL
          `),
          overdue: scalar(`
            SELECT count(*) AS count FROM tasks t
            WHERE ${openTopLevel} AND t.due_date < ?
          `, [query.overdueBefore]),
          queues: {
            triage: scalar(
              "SELECT count(*) AS count FROM triage_items WHERE status = 'pending'",
            ),
            sort: scalar(`
              SELECT count(*) AS count FROM tasks t
              WHERE ${openTopLevel}
                AND (t.priority IS NULL OR t.priority = '' OR t.priority = 'none')
            `),
            overdue: scalar(`
              SELECT count(*) AS count FROM tasks t
              WHERE ${openTopLevel} AND t.due_date < ?
            `, [query.queueOverdueBefore]),
          },
          recentActivity: sqlite.prepare(`
            SELECT t.id AS id, t.title AS title, t.completed_at AS completedAt
            FROM tasks t
            WHERE t.status = 'done' AND t.parent_id IS NULL
            ORDER BY t.completed_at DESC, t.id
            LIMIT ?
          `).all(query.recentActivityLimit) as MobileDashboardActivityRecord[],
        };
      },
    },

    navigation: {
      async counts({ date, now }) {
        const scalar = (sql: string, values: readonly unknown[] = []): number => toCount(
          (sqlite.prepare(sql).get(...values) as { count: number } | undefined)?.count,
        );
        const openVisibleTopLevel = `${visibleTask('t')} AND ${openTask('t')}
          AND t.parent_id IS NULL`;
        const inbox = `n.disposition = 'inbox'
          AND n.source_state IN ('active', 'unknown')
          AND (n.snoozed_until IS NULL OR n.snoozed_until <= @now)`;
        const attention = `${inbox} AND (
            n.level IN ('urgent', 'action_needed')
            OR (n.read_state = 'unread' AND (n.level IS NULL OR n.level IN ('heads_up', 'fyi')))
          )`;

        const notifications = sqlite.prepare(`
          SELECT
            COALESCE(SUM(CASE WHEN ${attention} THEN 1 ELSE 0 END), 0) AS attention,
            COALESCE(SUM(CASE WHEN ${inbox} AND n.read_state = 'unread' THEN 1 ELSE 0 END), 0)
              AS unread,
            COALESCE(SUM(CASE WHEN ${attention} AND n.level = 'urgent' THEN 1 ELSE 0 END), 0)
              AS urgent,
            COALESCE(
              SUM(CASE WHEN ${attention} AND n.level = 'action_needed' THEN 1 ELSE 0 END), 0
            ) AS actionNeeded,
            COALESCE(SUM(CASE WHEN ${attention} AND n.level = 'heads_up' THEN 1 ELSE 0 END), 0)
              AS headsUp,
            COALESCE(SUM(CASE WHEN ${attention} AND n.level = 'fyi' THEN 1 ELSE 0 END), 0) AS fyi
          FROM notifications n
          WHERE n.connector_instance_id NOT IN (
            SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL
          )
        `).get({ now }) as {
          attention: number;
          unread: number;
          urgent: number;
          actionNeeded: number;
          headsUp: number;
          fyi: number;
        } | undefined;

        return {
          myDay: scalar(`
            SELECT count(*) AS count FROM my_day_items m
            INNER JOIN tasks t ON t.id = m.task_id
            WHERE m.date = ? AND ${openVisibleTopLevel}
          `, [date]),
          triage: scalar("SELECT count(*) AS count FROM triage_items WHERE status = 'pending'"),
          quickSort: scalar(`
            SELECT count(*) AS count FROM tasks t
            WHERE ${openVisibleTopLevel}
              AND (t.snoozed_until IS NULL OR t.snoozed_until <= ?)
              AND t.priority = 'none'
          `, [now]),
          reconciliation: scalar(`
            SELECT count(*) AS count FROM scout_reconciliation_suggestions s
            INNER JOIN tasks t ON t.id = s.task_id
            WHERE s.status = 'pending' AND s.expires_at > ?
              AND t.status IN ('todo', 'in_progress')
          `, [now]),
          overdue: scalar(`
            SELECT count(*) AS count FROM tasks t
            WHERE ${openVisibleTopLevel} AND t.due_date < ?
          `, [date]),
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
      async dayView(query): Promise<MyDayDayViewProjection> {
        const itemRows = sqlite.prepare(`
          SELECT
            m.id AS id, m.task_id AS taskId, m."order" AS "order",
            m.is_auto_included AS isAutoIncluded, m.added_at AS addedAt,
            t.title AS title,
            CASE WHEN length(trim(
              coalesce(t.description, ''), char(9) || char(10) || char(13) || ' '
            )) > 0 THEN 1 ELSE 0 END AS hasDescription,
            t.status AS status, t.status_reason AS statusReason, t.priority AS priority,
            t.planning_horizon AS planningHorizon, t.due_date AS dueDate,
            t.push_count AS pushCount, t.connector_type AS connectorType,
            t.connector_instance_id AS connectorInstanceId, t.source_id AS sourceId,
            t.source_list_id AS sourceListId, t.source_list_name AS sourceListName,
            t.assignee AS assignee, t.created_at AS createdAt, t.completed_at AS completedAt,
            t.metadata AS metadata, t.effort AS effort, t.micro_status AS microStatus,
            t.local_disposition AS localDisposition
          FROM my_day_items m
          INNER JOIN tasks t ON t.id = m.task_id
          WHERE m.date = ? AND ${activeVisibleTask('t')}
          ORDER BY m."order", m.id
        `).all(query.date) as Array<Record<string, unknown>>;

        const taskIds = itemRows.map((row) => String(row.taskId));
        const excluded = new Set(taskIds);

        const tagsByTask = new Map<string, MyDayTagRecord[]>();
        const subtasks = new Map<string, { total: number; done: number }>();
        const durations = new Map<string, number | null>();
        const projectsByTask = new Map<string, string[]>();
        const phasesByTask = new Map<string, MyDayPhaseMembershipRecord[]>();

        for (const batch of chunk(taskIds)) {
          const marks = placeholders(batch.length);
          for (const row of sqlite.prepare(`
            SELECT tt.task_id AS taskId, g.id AS id, g.name AS name, g.slug AS slug,
                   g.type AS type, g.color AS color
            FROM task_tags tt
            INNER JOIN tags g ON g.id = tt.tag_id
            WHERE tt.task_id IN (${marks})
            ORDER BY tt.task_id, g.id
          `).all(...batch) as Array<MyDayTagRecord & { taskId: string }>) {
            const { taskId, ...tag } = row;
            if (!tagsByTask.has(taskId)) tagsByTask.set(taskId, []);
            tagsByTask.get(taskId)!.push(tag);
          }

          for (const row of sqlite.prepare(`
            SELECT t.parent_id AS parentId, COUNT(*) AS total,
                   SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
            FROM tasks t
            WHERE t.parent_id IN (${marks}) AND ${activeVisibleTask('t')}
            GROUP BY t.parent_id
          `).all(...batch) as Array<{ parentId: string | null; total: number; done: number }>) {
            if (row.parentId) {
              subtasks.set(row.parentId, {
                total: toCount(row.total),
                done: toCount(row.done),
              });
            }
          }

          for (const row of sqlite.prepare(`
            SELECT task_id AS taskId, estimated_duration AS estimatedDuration
            FROM task_schedules WHERE task_id IN (${marks})
          `).all(...batch) as Array<{ taskId: string; estimatedDuration: number | null }>) {
            durations.set(row.taskId, row.estimatedDuration);
          }

          for (const row of sqlite.prepare(`
            SELECT task_id AS taskId, project_id AS projectId
            FROM task_projects WHERE task_id IN (${marks})
            ORDER BY task_id, project_id
          `).all(...batch) as Array<{ taskId: string; projectId: string }>) {
            if (!projectsByTask.has(row.taskId)) projectsByTask.set(row.taskId, []);
            projectsByTask.get(row.taskId)!.push(row.projectId);
          }

          for (const row of sqlite.prepare(`
            SELECT i.task_id AS taskId, p.project_id AS projectId,
                   p.id AS phaseId, p.name AS phaseName
            FROM project_phase_items i
            INNER JOIN project_phases p ON p.id = i.phase_id
            WHERE i.task_id IN (${marks}) AND p.project_id IS NOT NULL
            ORDER BY i.task_id, p.project_id, p.id
          `).all(...batch) as Array<MyDayPhaseMembershipRecord & { taskId: string }>) {
            const { taskId, ...membership } = row;
            if (!phasesByTask.has(taskId)) phasesByTask.set(taskId, []);
            phasesByTask.get(taskId)!.push(membership);
          }
        }

        const items: MyDayItemRecord[] = itemRows.map((row) => {
          const taskId = String(row.taskId);
          const counts = subtasks.get(taskId);
          return {
            id: String(row.id),
            taskId,
            order: Number(row.order ?? 0),
            isAutoIncluded: toBoolean(row.isAutoIncluded),
            addedAt: String(row.addedAt),
            title: String(row.title),
            hasDescription: toBoolean(row.hasDescription),
            status: String(row.status),
            statusReason: (row.statusReason ?? null) as string | null,
            priority: String(row.priority),
            planningHorizon: (row.planningHorizon ?? null) as string | null,
            dueDate: (row.dueDate ?? null) as string | null,
            pushCount: toCount(row.pushCount),
            connectorType: String(row.connectorType),
            connectorInstanceId: String(row.connectorInstanceId),
            sourceId: String(row.sourceId),
            sourceListId: (row.sourceListId ?? null) as string | null,
            sourceListName: (row.sourceListName ?? null) as string | null,
            assignee: (row.assignee ?? null) as string | null,
            createdAt: String(row.createdAt),
            completedAt: (row.completedAt ?? null) as string | null,
            metadata: toJson(row.metadata),
            effort: row.effort === null || row.effort === undefined ? null : Number(row.effort),
            microStatus: (row.microStatus ?? null) as string | null,
            localDisposition: String(row.localDisposition),
            tags: tagsByTask.get(taskId) ?? [],
            subtaskTotal: counts?.total ?? 0,
            subtaskDone: counts?.done ?? 0,
            hubProjectIds: projectsByTask.get(taskId) ?? [],
            projectPhases: phasesByTask.get(taskId) ?? [],
            estimatedDuration: durations.get(taskId) ?? null,
          };
        });

        const limit = query.suggestionLimit;
        const openTopVisible = `${openTask('t')} AND ${topLevelTask('t')}
          AND ${activeVisibleTask('t')}`;

        const carriedIds = (sqlite.prepare(`
          SELECT task_id AS taskId FROM my_day_items
          GROUP BY task_id HAVING COUNT(*) >= ?
          ORDER BY task_id
        `).all(query.carriedForwardMinimum) as Array<{ taskId: string }>)
          .map((row) => row.taskId)
          .filter((taskId) => !excluded.has(taskId));

        const signalRows = query.frictionEventTypes.length > 0
          ? sqlite.prepare(`
              SELECT task_id AS taskId, COUNT(*) AS count
              FROM task_history_events
              WHERE event_type IN (${placeholders(query.frictionEventTypes.length)})
                AND occurred_at >= ?
              GROUP BY task_id
              ORDER BY COUNT(*) DESC, task_id
              LIMIT ?
            `).all(...query.frictionEventTypes, query.frictionSince, limit) as Array<{
              taskId: string;
              count: number;
            }>
          : [];
        const signalCounts = new Map(signalRows.map((row) => [row.taskId, toCount(row.count)]));
        const signalIds = signalRows
          .map((row) => row.taskId)
          .filter((taskId) => !excluded.has(taskId));

        const byIds = (ids: readonly string[]): MyDaySuggestionRecord[] => (
          ids.length === 0 ? [] : (sqlite.prepare(`
            SELECT ${SUGGESTION_COLUMNS} FROM tasks t
            WHERE t.id IN (${placeholders(ids.length)}) AND ${openTopVisible}
            ORDER BY t.id
            LIMIT ?
          `).all(...ids, limit) as RawSuggestionRow[]).map(suggestionFromRow)
        );

        const planningSignals: MyDaySignalledSuggestionRecord[] = byIds(signalIds)
          .map((task) => ({ ...task, planningSignalCount: signalCounts.get(task.id) ?? 0 }));

        return {
          items,
          suggestions: {
            planningSignals,
            carriedForward: byIds(carriedIds),
            yesterday: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM my_day_items m
              INNER JOIN tasks t ON t.id = m.task_id
              WHERE m.date = ? AND ${openTask('t')} AND ${topLevelTask('t')}
                AND ${activeVisibleTask('t')}
              ORDER BY m."order", m.id
              LIMIT ?
            `, [query.yesterday, limit], excluded),
            overdue: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.due_date < ? AND t.status = 'todo' AND ${topLevelTask('t')}
                AND ${activeVisibleTask('t')}
              ORDER BY t.id
              LIMIT ?
            `, [query.date, limit], excluded),
            dueToday: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.due_date = ? AND ${openTopVisible}
              ORDER BY t.id
              LIMIT ?
            `, [query.date, limit], excluded),
            dueThisWeek: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.due_date > ? AND t.due_date <= ? AND ${openTopVisible}
              ORDER BY t.id
              LIMIT ?
            `, [query.date, query.dueThrough, limit], excluded),
            planningNext: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.planning_horizon = 'next' AND ${openTopVisible}
              ORDER BY t.id
              LIMIT ?
            `, [limit], excluded),
            highPriority: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.status = 'todo' AND t.priority IN ('critical', 'high')
                AND ${topLevelTask('t')} AND ${activeVisibleTask('t')}
              ORDER BY t.id
              LIMIT ?
            `, [limit], excluded),
            aiRecommended: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.updated_at >= ? AND ${openTopVisible}
              ORDER BY t.id
              LIMIT ?
            `, [query.activitySince, limit], excluded),
            recentlyAdded: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.created_at >= ? AND ${openTopVisible}
              ORDER BY t.id
              LIMIT ?
            `, [query.activitySince, limit], excluded),
            repeatedlyRescheduled: listSuggestions(`
              SELECT ${SUGGESTION_COLUMNS} FROM tasks t
              WHERE t.push_count >= 2 AND ${openTopVisible}
              ORDER BY t.push_count DESC, t.due_date, t.id
              LIMIT ?
            `, [limit], excluded),
          },
        };
      },

      async includeCompletedTasks({ date, dayStart, nextDayStart }): Promise<
        MyDayAutoIncludeResult
      > {
        // Read outside the writer lock first: a reader must never contend for
        // the lock when there is nothing to auto-include.
        if (listPendingAutoIncludes(date, dayStart, nextDayStart).length === 0) {
          return { outcome: 'noop' };
        }
        try {
          return sqlite.transaction((): MyDayAutoIncludeResult => {
            const pending = listPendingAutoIncludes(date, dayStart, nextDayStart);
            if (pending.length === 0) return { outcome: 'noop' };
            const max = sqlite.prepare(
              'SELECT MAX("order") AS max FROM my_day_items WHERE date = ?',
            ).get(date) as { max: number | null } | undefined;
            let order = (max?.max || 0) + 1;
            let inserted = 0;
            for (const task of pending) {
              inserted += sqlite.prepare(`
                INSERT OR IGNORE INTO my_day_items
                  (id, task_id, date, added_at, is_auto_included, "order")
                VALUES (?, ?, ?, ?, 1, ?)
              `).run(
                `md-completed-${crypto.randomUUID().slice(0, 8)}`,
                task.id,
                date,
                task.completedAt,
                order,
              ).changes;
              order++;
            }
            return { outcome: 'applied', inserted };
          }).immediate();
        } catch (error) {
          if (!isDatabaseContentionError(error)) throw error;
          return { outcome: 'skipped-write-contention' };
        }
      },

      async replaceOrder({ date, orderedItemIds }) {
        return sqlite.transaction((): { outcome: 'saved' | 'stale' } => {
          const visible = new Set((sqlite.prepare(`
            SELECT m.id AS id FROM my_day_items m
            INNER JOIN tasks t ON t.id = m.task_id
            WHERE m.date = ? AND ${activeVisibleTask('t')}
          `).all(date) as Array<{ id: string }>).map((row) => row.id));

          if (
            visible.size !== orderedItemIds.length
            || orderedItemIds.some((id) => !visible.has(id))
          ) {
            return { outcome: 'stale' };
          }

          const hidden = (sqlite.prepare(`
            SELECT id FROM my_day_items WHERE date = ? ORDER BY "order", id
          `).all(date) as Array<{ id: string }>)
            .map((row) => row.id)
            .filter((id) => !visible.has(id));

          const update = sqlite.prepare(
            'UPDATE my_day_items SET "order" = ? WHERE id = ? AND date = ?',
          );
          [...orderedItemIds, ...hidden].forEach((id, index) => {
            update.run(index + 1, id, date);
          });
          return { outcome: 'saved' };
        }).immediate();
      },

      async add(command): Promise<AddMyDayItemResult> {
        return sqlite.transaction((): AddMyDayItemResult => {
          const existing = sqlite.prepare(`
            SELECT id FROM my_day_items WHERE task_id = ? AND date = ? LIMIT 1
          `).get(command.taskId, command.date) as { id: string } | undefined;
          if (existing) return { outcome: 'exists', id: existing.id };

          const max = sqlite.prepare(
            'SELECT MAX("order") AS max FROM my_day_items WHERE date = ?',
          ).get(command.date) as { max: number | null } | undefined;
          const order = (max?.max || 0) + 1;

          sqlite.prepare(`
            INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order")
            VALUES (?, ?, ?, ?, 0, ?)
          `).run(command.id, command.taskId, command.date, command.addedAt, order);
          appendSignal(
            command.taskId,
            'my_day_committed',
            command.date,
            command.addedAt,
            command.signal,
          );
          return { outcome: 'added', id: command.id, order };
        }).immediate();
      },

      async remove(command) {
        return sqlite.transaction((): { taskId: string | null } => {
          let removedTaskId = command.taskId;
          let removedDate = command.date;
          let removed = false;

          if (command.itemId) {
            const item = sqlite.prepare(
              'SELECT task_id AS taskId, date FROM my_day_items WHERE id = ?',
            ).get(command.itemId) as { taskId: string; date: string } | undefined;
            removedTaskId = item?.taskId || null;
            removedDate = item?.date || removedDate;
            removed = sqlite.prepare('DELETE FROM my_day_items WHERE id = ?')
              .run(command.itemId).changes > 0;
          } else if (command.taskId) {
            removed = sqlite.prepare(
              'DELETE FROM my_day_items WHERE task_id = ? AND date = ?',
            ).run(command.taskId, removedDate).changes > 0;
          }

          if (removedTaskId && removed) {
            appendSignal(
              removedTaskId,
              'my_day_withdrawn',
              removedDate,
              command.removedAt,
              command.signal,
            );
            const exclusion = sqlite.prepare(`
              SELECT id FROM my_day_exclusions WHERE task_id = ? AND date = ? LIMIT 1
            `).get(removedTaskId, removedDate);
            if (!exclusion) {
              sqlite.prepare(`
                INSERT INTO my_day_exclusions (id, task_id, date, removed_at)
                VALUES (?, ?, ?, ?)
              `).run(command.exclusionId, removedTaskId, removedDate, command.removedAt);
            }
          }
          return { taskId: removedTaskId };
        }).immediate();
      },

      async getRemoteIdentity(taskId) {
        const row = sqlite.prepare(`
          SELECT source_id AS sourceId, connector_type AS connectorType,
                 connector_instance_id AS connectorInstanceId
          FROM tasks WHERE id = ?
        `).get(taskId) as {
          sourceId: string;
          connectorType: string;
          connectorInstanceId: string;
        } | undefined;
        return row ?? null;
      },
    },

    myDaySync: {
      async snapshot({ date, connectorInstanceId, archivedDuplicateReasonPrefix }) {
        const localItems = (sqlite.prepare(`
          SELECT m.id AS id, m.task_id AS taskId, t.source_id AS sourceId,
                 m.is_auto_included AS isAutoIncluded, t.status AS status,
                 t.completed_at AS completedAt
          FROM my_day_items m
          INNER JOIN tasks t ON t.id = m.task_id
          WHERE m.date = ?
          ORDER BY m."order", m.id
        `).all(date) as Array<
          Omit<MyDaySyncLocalItem, 'isAutoIncluded'> & { isAutoIncluded: number }
        >)
          .map((row) => ({ ...row, isAutoIncluded: toBoolean(row.isAutoIncluded) }));

        const recurringHistory = (sqlite.prepare(`
          SELECT title, source_list_id AS sourceListId, status,
                 due_date AS dueDate, completed_at AS completedAt, metadata
          FROM tasks
          WHERE connector_instance_id = ? AND depth = 0
          ORDER BY id
        `).all(connectorInstanceId) as Array<
          Omit<MyDaySyncRecurringHistoryRecord, 'metadata'> & { metadata: unknown }
        >).map((row) => ({ ...row, metadata: toJson(row.metadata) }));

        return {
          localItems,
          excludedTaskIds: (sqlite.prepare(
            'SELECT task_id AS taskId FROM my_day_exclusions WHERE date = ? ORDER BY task_id',
          ).all(date) as Array<{ taskId: string }>).map((row) => row.taskId),
          recurringHistory,
          archivedDuplicateSourceIds: (sqlite.prepare(`
            SELECT source_id AS sourceId FROM sync_deletion_snapshots
            WHERE connector_id = ? AND reason LIKE ? ESCAPE '\\'
            ORDER BY source_id
          `).all(
            connectorInstanceId,
            `${escapeLike(archivedDuplicateReasonPrefix)}%`,
          ) as Array<{ sourceId: string }>).map((row) => row.sourceId),
        };
      },

      async findTasksBySourceIds({ connectorType, connectorInstanceId, sourceIds }) {
        const results: MyDaySyncLocalTask[] = [];
        for (const batch of chunk(sourceIds)) {
          const rows = sqlite.prepare(`
            SELECT id, source_id AS sourceId, metadata, status
            FROM tasks
            WHERE connector_instance_id = ?
              ${connectorType ? 'AND connector_type = ?' : ''}
              AND source_id IN (${placeholders(batch.length)})
          `).all(
            ...(connectorType
              ? [connectorInstanceId, connectorType, ...batch]
              : [connectorInstanceId, ...batch]),
          ) as Array<Omit<MyDaySyncLocalTask, 'metadata'> & { metadata: unknown }>;
          for (const row of rows) {
            if (row.sourceId) results.push({ ...row, metadata: toJson(row.metadata) });
          }
        }
        return results;
      },

      async listCompletedMyDaySiblings({ connectorInstanceId, date }) {
        return (sqlite.prepare(`
          SELECT t.source_list_id AS sourceListId, t.title AS title,
                 t.completed_at AS completedAt, t.metadata AS metadata
          FROM tasks t
          INNER JOIN my_day_items m ON m.task_id = t.id
          WHERE t.connector_type = 'microsoft-todo' AND t.connector_instance_id = ?
            AND t.status = 'done' AND m.date = ?
          ORDER BY t.id
        `).all(connectorInstanceId, date) as Array<
          Omit<MyDaySyncCompletedSibling, 'metadata'> & { metadata: unknown }
        >).map((row) => ({ ...row, metadata: toJson(row.metadata) }));
      },

      async createTaskFromRemote(command) {
        const created = sqlite.prepare(`
          INSERT OR IGNORE INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, description,
            status, priority, due_date, created_at, updated_at, completed_at, parent_id,
            depth, is_checklist_item, source_list_id, source_list_name, assignee,
            metadata, sync_status, last_synced_at
          ) VALUES (
            ?, ?, 'microsoft-todo', ?, ?, NULL, 'todo', ?, ?, ?, ?, NULL, NULL,
            0, 0, ?, NULL, NULL, '{}', 'synced', ?
          )
        `).run(
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
        ).changes > 0;

        const row = sqlite.prepare(`
          SELECT id, source_id AS sourceId, metadata, status FROM tasks
          WHERE source_id = ? AND connector_instance_id = ?
          LIMIT 1
        `).get(command.sourceId, command.connectorInstanceId) as
          (Omit<MyDaySyncLocalTask, 'metadata'> & { metadata: unknown }) | undefined;

        return {
          created,
          task: row ? { ...row, metadata: toJson(row.metadata) } : null,
        };
      },

      async applyReconciliation(command) {
        return sqlite.transaction(() => {
          const existing: Array<{ id: string; taskId: string; date: string }> = [];
          for (const batch of chunk(command.removeItemIds)) {
            existing.push(...sqlite.prepare(`
              SELECT id, task_id AS taskId, date
              FROM my_day_items
              WHERE id IN (${placeholders(batch.length)})
            `).all(...batch) as Array<{ id: string; taskId: string; date: string }>);
          }
          let removed = 0;
          for (const batch of chunk(command.removeItemIds)) {
            removed += sqlite.prepare(
              `DELETE FROM my_day_items WHERE id IN (${placeholders(batch.length)})`,
            ).run(...batch).changes;
          }
          for (const item of existing) {
            appendSignal(
              item.taskId,
              'my_day_withdrawn',
              item.date,
              command.removedAt,
              command.signal,
            );
          }

          const max = sqlite.prepare(
            'SELECT MAX("order") AS max FROM my_day_items WHERE date = ?',
          ).get(command.date) as { max: number | null };
          let order = (max.max || 0) + 1;
          const committedRows = command.committedRows.map((row) => ({ ...row, order: order++ }));
          const autoIncludedRows =
            command.autoIncludedRows.map((row) => ({ ...row, order: order++ }));
          return {
            added: insertMyDayRows(committedRows, command.signal),
            dueTodayAdded: insertMyDayRows(autoIncludedRows),
            removed,
          };
        }).immediate();
      },

      async listOpenDueTodayTaskIds({ connectorType, date }) {
        return (sqlite.prepare(`
          SELECT id FROM tasks
          WHERE connector_type = ? AND due_date LIKE ? ESCAPE '\\' AND ${openTask('tasks')}
          ORDER BY id
        `).all(connectorType, `${escapeLike(date)}%`) as Array<{ id: string }>)
          .map((row) => row.id);
      },

      async listOpenDueTodayTasks({ connectorType, connectorInstanceId, date }) {
        return sqlite.prepare(`
          SELECT id, source_id AS sourceId, status FROM tasks
          WHERE connector_type = ? AND connector_instance_id = ?
            AND due_date LIKE ? ESCAPE '\\' AND ${openTask('tasks')}
          ORDER BY id
        `).all(connectorType, connectorInstanceId, `${escapeLike(date)}%`) as Array<{
          id: string;
          sourceId: string | null;
          status: string;
        }>;
      },

      async listMyDayTaskIds(date) {
        return (sqlite.prepare(
          'SELECT task_id AS taskId FROM my_day_items WHERE date = ? ORDER BY task_id',
        ).all(date) as Array<{ taskId: string }>).map((row) => row.taskId);
      },

      async resolveTaskIdsBySourceIds({ connectorInstanceId, sourceIds }) {
        const results: Array<{ id: string; sourceId: string }> = [];
        for (const batch of chunk(sourceIds)) {
          results.push(...sqlite.prepare(`
            SELECT id, source_id AS sourceId FROM tasks
            WHERE connector_instance_id = ? AND source_id IN (${placeholders(batch.length)})
            ORDER BY id
          `).all(connectorInstanceId, ...batch) as Array<{ id: string; sourceId: string }>);
        }
        return results;
      },
    },

    oneThing: {
      async getForWeek(weekMonday) {
        return readOneThing(weekMonday);
      },

      async markCompleted({ id, completedAt }) {
        sqlite.prepare(
          'UPDATE weekly_one_thing SET completed_at = ? WHERE id = ? AND completed_at IS NULL',
        ).run(completedAt, id);
      },

      async subtaskProgress(taskId) {
        const row = sqlite.prepare(`
          SELECT COUNT(*) AS total,
                 SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
          FROM tasks WHERE parent_id = ?
        `).get(taskId) as { total: number; done: number | null } | undefined;
        return { total: toCount(row?.total), done: toCount(row?.done) };
      },

      async listCandidates(limit) {
        return sqlite.prepare(`
          SELECT id, title, status, priority, due_date AS dueDate,
                 connector_type AS connectorType, source_list_name AS sourceListName,
                 updated_at AS updatedAt, depth
          FROM tasks
          WHERE status <> 'done' AND status <> 'cancelled' AND depth = 0
          ORDER BY id
          LIMIT ?
        `).all(limit) as WeeklyOneThingCandidate[];
      },

      async listMyDayTaskIds(date) {
        return (sqlite.prepare(
          'SELECT task_id AS taskId FROM my_day_items WHERE date = ? ORDER BY task_id',
        ).all(date) as Array<{ taskId: string }>).map((row) => row.taskId);
      },

      async selectAuto(command) {
        return sqlite.transaction((): { outcome: 'selected' | 'existing' } => {
          const existing = sqlite.prepare(
            'SELECT id FROM weekly_one_thing WHERE week_monday = ? LIMIT 1',
          ).get(command.weekMonday);
          if (existing) return { outcome: 'existing' };
          sqlite.prepare(`
            INSERT INTO weekly_one_thing
              (id, task_id, week_monday, is_manual_override, completed_at, created_at)
            VALUES (?, ?, ?, 0, NULL, ?)
          `).run(command.id, command.taskId, command.weekMonday, command.createdAt);
          return { outcome: 'selected' };
        }).immediate();
      },

      async selectManual(command) {
        return sqlite.transaction((): { outcome: 'selected' | 'task-not-found' } => {
          const task = sqlite.prepare('SELECT id FROM tasks WHERE id = ? LIMIT 1')
            .get(command.taskId);
          if (!task) return { outcome: 'task-not-found' };
          sqlite.prepare('DELETE FROM weekly_one_thing WHERE week_monday = ?')
            .run(command.weekMonday);
          sqlite.prepare(`
            INSERT INTO weekly_one_thing
              (id, task_id, week_monday, is_manual_override, completed_at, created_at)
            VALUES (?, ?, ?, 1, NULL, ?)
          `).run(command.id, command.taskId, command.weekMonday, command.createdAt);
          return { outcome: 'selected' };
        }).immediate();
      },

      async clearForWeek(weekMonday) {
        sqlite.prepare('DELETE FROM weekly_one_thing WHERE week_monday = ?').run(weekMonday);
      },
    },

    schedule: {
      async listForDate(date) {
        return (sqlite.prepare(`
          SELECT s.task_id AS taskId, s.scheduled_date AS scheduledDate,
                 s.scheduled_time AS scheduledTime, s.estimated_duration AS estimatedDuration,
                 s.is_time_blocked AS isTimeBlocked, s.recurrence AS recurrence,
                 t.title AS title, t.status AS status, t.priority AS priority,
                 t.due_date AS dueDate, t.connector_type AS connectorType,
                 t.source_list_name AS sourceListName
          FROM task_schedules s
          INNER JOIN tasks t ON t.id = s.task_id
          WHERE s.scheduled_date = ?
          ORDER BY s.scheduled_time, s.task_id
        `).all(date) as Array<
          Omit<ScheduledTaskRecord, 'isTimeBlocked'> & { isTimeBlocked: number }
        >)
          .map((row) => ({ ...row, isTimeBlocked: toBoolean(row.isTimeBlocked) }));
      },

      async upsert(command) {
        sqlite.prepare(`
          INSERT INTO task_schedules (
            task_id, scheduled_date, scheduled_time, estimated_duration,
            is_time_blocked, recurrence
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            scheduled_date = excluded.scheduled_date,
            scheduled_time = excluded.scheduled_time,
            estimated_duration = excluded.estimated_duration,
            is_time_blocked = excluded.is_time_blocked,
            recurrence = excluded.recurrence
        `).run(
          command.taskId,
          command.scheduledDate,
          command.scheduledTime,
          command.estimatedDuration,
          command.isTimeBlocked ? 1 : 0,
          command.recurrence,
        );
      },

      async remove(taskId) {
        sqlite.prepare('DELETE FROM task_schedules WHERE task_id = ?').run(taskId);
      },
    },

    recentWins: {
      async listRecentCompletions({ completedFrom }) {
        return sqlite.prepare(`
          SELECT t.id AS id, t.title AS title, t.priority AS priority,
                 t.completed_at AS completedAt, t.connector_type AS connectorType,
                 t.source_list_name AS sourceListName, t.due_date AS dueDate,
                 s.recurrence AS recurrence
          FROM tasks t
          LEFT JOIN task_schedules s ON s.task_id = t.id
          WHERE t.status = 'done' AND t.completed_at >= ?
          ORDER BY t.completed_at DESC, t.id
        `).all(completedFrom) as RecentWinRecord[];
      },
    },
  };
}

/** Escapes the LIKE wildcards in a caller-supplied literal prefix. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
