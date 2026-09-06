import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import { instant, withinInstantRange } from './analytics-repositories';
import type {
  AIDigestSnapshot,
  AIWorkflowPersistence,
  TaskBreakdownContext,
} from '@/db/persistence/ai-workflows';
import type {
  DailyPlanningPersistence,
  DayPlanSchedule,
  DayPlanTask,
  EnergyDemandLevel,
  EnergySuggestionPersistence,
  EnergyTagDefinition,
  FocusSuggestionTask,
} from '@/db/persistence/daily-planning';
import type {
  GoalDevelopmentContext,
  PhasePlanningContextTask,
  ProjectAdministrationPersistence,
} from '@/db/persistence/project-organization';
import type {
  AIDayPlanPersistence,
  AIDispatchPersistence,
  AIGoalsBoardPersistence,
  AIIdeationPersistence,
  AIMaintenancePersistence,
  AIResetsPersistence,
  AITaskToolsPersistence,
  DayPlanSuggestionSnapshot,
  GoalLinkedProjectRow,
  GoalTagRow,
  MaintenanceAgentType,
  MaintenanceClaimResult,
  MaintenanceScanCandidate,
  ResetPatch,
  ResetRow,
} from '@/db/persistence/ai-workflows';

interface AIWorkflowBackend extends Omit<AIWorkflowPersistence,
  'dayPlan' | 'taskTools' | 'dispatch' | 'maintenance' | 'goalsBoard' | 'ideation' | 'resets'
> {
  recommendations: AIWorkflowPersistence['recommendations'] & {
    listEnergySuggestionTasksByIds: EnergySuggestionPersistence['listTasksByIds'];
    listOpenTopLevelEnergySuggestionTasks:
      EnergySuggestionPersistence['listOpenTopLevelTasks'];
    listEnergyLevels: EnergySuggestionPersistence['listLevels'];
    applyEnergyTagSuggestions: EnergySuggestionPersistence['apply'];
  };
  planning: {
    listPlanDayItems(date: string): Promise<DayPlanTask[]>;
    listPlanDaySchedules(date: string): Promise<DayPlanSchedule[]>;
    listPlanDayOpenTasks(limit: number): Promise<DayPlanTask[]>;
    listFocusTaskIds(scope: string, date: string): Promise<string[]>;
    listFocusCandidates(limit: number): Promise<FocusSuggestionTask[]>;
    listMyDayTaskIds(date: string): Promise<string[]>;
    listProjectTaskIds(projectId: string): Promise<string[]>;
    listOpenPhaseTaskIds(): Promise<string[]>;
    listPhasePlanningTasks(taskIds: readonly string[]): Promise<PhasePlanningContextTask[]>;
  };
  goals: {
    getTask(taskId: string): Promise<GoalDevelopmentContext['task'] | null>;
    listTaskTags(taskId: string): Promise<GoalDevelopmentContext['tags']>;
    listLinkedProjects(taskId: string): Promise<GoalDevelopmentContext['linkedProjects']>;
    listExistingProjects(limit: number): Promise<GoalDevelopmentContext['existingProjects']>;
  };
}

const ENERGY_SLUGS = ['energy-high', 'energy-medium', 'energy-low'] as const;
const NOTIFICATION_NEEDS_ATTENTION = `
  disposition = 'inbox'
  AND source_state IN ('active', 'unknown')
  AND (snoozed_until IS NULL OR snoozed_until <= $1)
  AND read_state = 'unread'
  AND (level IS NULL OR level IN ('urgent', 'action_needed', 'heads_up', 'fyi'))
`;
/** Bare inbox membership (no read-state/level filter), parameterized on `nowPlaceholder`. */
function notificationIsInboxSqlPg(nowPlaceholder: string): string {
  return `
  disposition = 'inbox'
  AND source_state IN ('active', 'unknown')
  AND (snoozed_until IS NULL OR snoozed_until <= ${nowPlaceholder})
`;
}
const PRIORITY_ORDER = `
  CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END
`;

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

async function withReadOnlySnapshot<T>(
  pool: Pool,
  read: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const result = await read(client);
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

function energyLevelForSlug(slug: string): EnergyDemandLevel | null {
  if (slug === 'energy-high') return 'high';
  if (slug === 'energy-medium') return 'medium';
  if (slug === 'energy-low') return 'low';
  return null;
}

async function readDigestSnapshot(
  client: PoolClient,
  input: { today: string; now: string; rowsPerCategory: number },
): Promise<AIDigestSnapshot> {
  const openCondition = `status NOT IN ('done', 'cancelled')`;
  const [
    taskCountRows,
    overdue,
    dueToday,
    inProgress,
    notificationCountRows,
    notificationRows,
  ] = await Promise.all([
    query<{
      open: number;
      overdue: number;
      dueToday: number;
      inProgress: number;
      critical: number;
    }>(client, `
      SELECT
        COUNT(*)::int AS open,
        COALESCE(SUM(CASE WHEN due_date < $1 THEN 1 ELSE 0 END), 0)::int AS overdue,
        COALESCE(SUM(CASE WHEN due_date = $1 THEN 1 ELSE 0 END), 0)::int AS "dueToday",
        COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0)::int
          AS "inProgress",
        COALESCE(SUM(CASE WHEN priority IN ('critical', 'high') THEN 1 ELSE 0 END), 0)::int
          AS critical
      FROM tasks
      WHERE ${openCondition}
    `, [input.today]),
    query<AIDigestSnapshot['overdue'][number]>(client, `
      SELECT id, title, priority, due_date AS "dueDate", connector_type AS "connectorType"
      FROM tasks
      WHERE ${openCondition} AND due_date < $1
      ORDER BY due_date COLLATE "C" ASC, ${PRIORITY_ORDER}, id COLLATE "C" ASC
      LIMIT $2
    `, [input.today, input.rowsPerCategory]),
    query<AIDigestSnapshot['dueToday'][number]>(client, `
      SELECT id, title, priority, due_date AS "dueDate", connector_type AS "connectorType"
      FROM tasks
      WHERE ${openCondition} AND due_date = $1
      ORDER BY ${PRIORITY_ORDER}, updated_at COLLATE "C" DESC, id COLLATE "C" ASC
      LIMIT $2
    `, [input.today, input.rowsPerCategory]),
    query<AIDigestSnapshot['inProgress'][number]>(client, `
      SELECT id, title, priority, due_date AS "dueDate", connector_type AS "connectorType"
      FROM tasks
      WHERE ${openCondition} AND status = 'in_progress'
      ORDER BY ${PRIORITY_ORDER}, updated_at COLLATE "C" DESC, id COLLATE "C" ASC
      LIMIT $1
    `, [input.rowsPerCategory]),
    query<{ unread: number; urgent: number }>(client, `
      SELECT
        COUNT(*)::int AS unread,
        COALESCE(SUM(CASE WHEN level IN ('critical', 'urgent') THEN 1 ELSE 0 END), 0)::int
          AS urgent
      FROM notifications
      WHERE ${NOTIFICATION_NEEDS_ATTENTION}
    `, [input.now]),
    query<AIDigestSnapshot['notifications'][number]>(client, `
      SELECT id, title, level, connector_type AS "connectorType"
      FROM notifications
      WHERE ${NOTIFICATION_NEEDS_ATTENTION}
      ORDER BY level_rank ASC, received_at COLLATE "C" DESC, id COLLATE "C" ASC
      LIMIT $2
    `, [input.now, input.rowsPerCategory]),
  ]);
  const [taskCounts] = taskCountRows;
  const [notificationCounts] = notificationCountRows;
  const sources = [...new Set([
    ...overdue,
    ...dueToday,
    ...inProgress,
    ...notificationRows,
  ].map((row) => row.connectorType))];

  return {
    counts: {
      open: Number(taskCounts?.open ?? 0),
      overdue: Number(taskCounts?.overdue ?? 0),
      dueToday: Number(taskCounts?.dueToday ?? 0),
      inProgress: Number(taskCounts?.inProgress ?? 0),
      critical: Number(taskCounts?.critical ?? 0),
      unreadNotifications: Number(notificationCounts?.unread ?? 0),
      urgentNotifications: Number(notificationCounts?.urgent ?? 0),
    },
    overdue,
    dueToday,
    inProgress,
    notifications: notificationRows,
    sources,
    rowCount: overdue.length + dueToday.length + inProgress.length + notificationRows.length,
  };
}

async function loadDigestSnapshot(
  pool: Pool,
  input: { today: string; now: string; rowsPerCategory: number },
): Promise<AIDigestSnapshot> {
  return withReadOnlySnapshot(pool, (client) => readDigestSnapshot(client, input));
}

async function getTaskBreakdownContext(
  pool: Pool,
  taskId: string,
): Promise<TaskBreakdownContext | null> {
  return withReadOnlySnapshot(pool, async (client) => {
    const [task] = await query<TaskBreakdownContext['task']>(client, `
      SELECT id, title, description, priority, due_date AS "dueDate", effort,
             source_list_name AS "sourceListName", connector_type AS "connectorType",
             updated_at AS "updatedAt"
      FROM tasks
      WHERE id = $1
      LIMIT 1
    `, [taskId]);
    if (!task) return null;
    const [tagRows, projectRows, subtaskRows] = await Promise.all([
      query<{ name: string }>(client, `
        SELECT tag.name
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tt.task_id = $1
        ORDER BY tag.name COLLATE "C" ASC, tag.id COLLATE "C" ASC
        LIMIT 20
      `, [taskId]),
      query<{ name: string }>(client, `
        SELECT project.name
        FROM task_projects tp
        INNER JOIN hub_projects project ON project.id = tp.project_id
        WHERE tp.task_id = $1
        ORDER BY project.name COLLATE "C" ASC, project.id COLLATE "C" ASC
        LIMIT 10
      `, [taskId]),
      query<{ title: string }>(client, `
        SELECT title
        FROM tasks
        WHERE parent_id = $1
        ORDER BY title COLLATE "C" ASC, id COLLATE "C" ASC
        LIMIT 30
      `, [taskId]),
    ]);
    return {
      task,
      tagNames: tagRows.map((row) => row.name),
      projectNames: projectRows.map((row) => row.name),
      subtaskTitles: subtaskRows.map((row) => row.title),
    };
  });
}

async function applyEnergyTags(
  pool: Pool,
  input: {
    definitions: readonly EnergyTagDefinition[];
    suggestions: ReadonlyArray<{ taskId: string; energyLevel: EnergyDemandLevel }>;
    createdAt: string;
  },
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      await client.query(
        "SELECT pg_advisory_xact_lock_shared(hashtext('tag-consolidation'))",
      );
      const taskLockKeys = [...new Set(input.suggestions.map(
        (suggestion) => `task-ancillary:${suggestion.taskId}`,
      ))].sort();
      const tagLockKeys = [...new Set(input.definitions.map(
        (definition) => `tag-slug:${definition.slug}`,
      ))].sort();
      for (const lockKey of [...taskLockKeys, ...tagLockKeys]) {
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [lockKey],
        );
      }
      await client.query('LOCK TABLE task_tags IN SHARE ROW EXCLUSIVE MODE');
      const canonicalTagIds: Partial<Record<EnergyTagDefinition['slug'], string>> = {};
      for (const definition of input.definitions) {
        let [tag] = await query<{ id: string }>(client, `
          SELECT id FROM tags
          WHERE slug = $1
          ORDER BY id COLLATE "C"
          LIMIT 1
        `, [definition.slug]);
        if (!tag) {
          tag = { id: `tag-${definition.slug}-${randomUUID().slice(0, 8)}` };
          await client.query(`
            INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
            VALUES ($1, $2, $3, 'ai-inferred', 'energy-system', $4, TRUE, $5)
          `, [tag.id, definition.name, definition.slug, definition.color, input.createdAt]);
        }
        canonicalTagIds[definition.slug] = tag.id;
      }

      const requestedTaskIds = [...new Set(input.suggestions.map((entry) => entry.taskId))];
      const existingTaskIds = new Set<string>();
      const tasksWithEnergyTags = new Set<string>();
      if (requestedTaskIds.length > 0) {
        const existingRows = await query<{ id: string }>(client, `
          SELECT id
          FROM tasks
          WHERE id = ANY($1::text[])
          ORDER BY id COLLATE "C" ASC
        `, [requestedTaskIds]);
        for (const row of existingRows) existingTaskIds.add(row.id);

        const rows = await query<{ taskId: string }>(client, `
          SELECT DISTINCT tt.task_id AS "taskId"
          FROM task_tags tt
          INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id = ANY($1::text[])
            AND t.slug = ANY($2::text[])
        `, [requestedTaskIds, ENERGY_SLUGS]);
        for (const row of rows) tasksWithEnergyTags.add(row.taskId);
      }

      const appliedTaskIds: string[] = [];
      for (const suggestion of input.suggestions) {
        if (!existingTaskIds.has(suggestion.taskId)) continue;
        if (tasksWithEnergyTags.has(suggestion.taskId)) continue;
        const tagId = canonicalTagIds[`energy-${suggestion.energyLevel}`];
        if (!tagId) continue;
        const result = await client.query(`
          INSERT INTO task_tags (task_id, tag_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [suggestion.taskId, tagId]);
        tasksWithEnergyTags.add(suggestion.taskId);
        if ((result.rowCount ?? 0) > 0) appliedTaskIds.push(suggestion.taskId);
      }

      await client.query('COMMIT');
      return { canonicalTagIds, appliedTaskIds };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function isUniqueViolationError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === '23505';
}

function createPostgresTaskToolsPersistence(pool: Pool): AITaskToolsPersistence {
  return {
    async getSummary({ today, overdueLimit }) {
      const [counts, bySourceRows, overdueItems] = await Promise.all([
        query<{ total: number; open: number; overdue: number; critical: number; done: number }>(
          pool, `
            SELECT
              COUNT(*)::int AS total,
              COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END), 0)::int AS open,
              COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled')
                AND due_date IS NOT NULL AND due_date < $1 THEN 1 ELSE 0 END), 0)::int AS overdue,
              COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled')
                AND priority IN ('critical', 'high') THEN 1 ELSE 0 END), 0)::int AS critical,
              COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0)::int AS done
            FROM tasks
          `, [today],
        ),
        query<{ connectorType: string; count: number }>(pool, `
          SELECT connector_type AS "connectorType", COUNT(*)::int AS count
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled')
          GROUP BY connector_type
        `),
        query<TaskToolsSummaryOverdueRow>(pool, `
          SELECT id, title, status, micro_status AS "microStatus", due_date AS "dueDate",
                 priority, connector_type AS source
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled') AND due_date IS NOT NULL AND due_date < $1
          ORDER BY due_date COLLATE "C" ASC, id COLLATE "C" ASC
          LIMIT $2
        `, [today, overdueLimit]),
      ]);
      const [row] = counts;
      return {
        total: Number(row?.total ?? 0),
        open: Number(row?.open ?? 0),
        overdue: Number(row?.overdue ?? 0),
        critical: Number(row?.critical ?? 0),
        done: Number(row?.done ?? 0),
        bySource: Object.fromEntries(bySourceRows.map((r) => [r.connectorType, r.count])),
        overdueItems,
      };
    },
    async search(filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filters.status) { params.push(filters.status); conditions.push(`status = $${params.length}`); }
      if (filters.priority) { params.push(filters.priority); conditions.push(`priority = $${params.length}`); }
      if (filters.source) { params.push(filters.source); conditions.push(`connector_type = $${params.length}`); }
      if (filters.query) {
        // Literal substring, matching SQLite's `instr(lower(col), lower(?))`.
        // `ILIKE` would treat `%`, `_`, and `\` in the caller's query as
        // pattern syntax rather than as the characters they are.
        params.push(filters.query);
        const queryParamIndex = params.length;
        conditions.push(`(
          position(lower($${queryParamIndex}::text) in lower(title)) > 0
          OR position(lower($${queryParamIndex}::text) in lower(COALESCE(description, ''))) > 0
        )`);
      }
      params.push(filters.limit);
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await query<{
        id: string; title: string; status: string; microStatus: string | null;
        priority: string; dueDate: string | null; connectorType: string;
        sourceListName: string | null; description: string | null;
      }>(pool, `
        SELECT id, title, status, micro_status AS "microStatus", priority, due_date AS "dueDate",
               connector_type AS "connectorType", source_list_name AS "sourceListName", description
        FROM tasks
        ${where}
        ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C" ASC
        LIMIT $${params.length}
      `, params);
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        microStatus: row.microStatus,
        priority: row.priority,
        dueDate: row.dueDate,
        source: row.connectorType,
        sourceList: row.sourceListName,
        description: row.description ? row.description.slice(0, 100) : null,
      }));
    },
    listAllTags: () => query(pool, `SELECT id, name, type, color FROM tags`),
    listTaskTags: (taskId) => query(pool, `
      SELECT tag.id, tag.name, tag.type, tag.color
      FROM task_tags tt
      INNER JOIN tags tag ON tag.id = tt.tag_id
      WHERE tt.task_id = $1
    `, [taskId]),
  };
}

interface TaskToolsSummaryOverdueRow {
  id: string;
  title: string;
  status: string;
  microStatus: string | null;
  dueDate: string | null;
  priority: string;
  source: string;
}

function createPostgresDispatchPersistence(pool: Pool): AIDispatchPersistence {
  return {
    async getCustomAgentContext({ taskLimit, notificationLimit }) {
      const now = new Date().toISOString();
      const [openTasks, unreadNotifications] = await Promise.all([
        query<{ id: string; title: string; priority: string; dueDate: string | null; connectorType: string }>(
          pool, `
            SELECT id, title, priority, due_date AS "dueDate", connector_type AS "connectorType"
            FROM tasks
            WHERE status = 'todo'
            ORDER BY id COLLATE "C" ASC
            LIMIT $1
          `, [taskLimit],
        ),
        query<{ id: string; title: string; level: string; connectorType: string }>(pool, `
          SELECT id, title, level, connector_type AS "connectorType"
          FROM notifications
          WHERE ${NOTIFICATION_NEEDS_ATTENTION}
          ORDER BY received_at COLLATE "C" DESC, id COLLATE "C" ASC
          LIMIT $2
        `, [now, notificationLimit]),
      ]);
      return { openTasks, unreadNotifications };
    },
  };
}

function createPostgresDayPlanPersistence(pool: Pool): AIDayPlanPersistence {
  return {
    async listSuggestions({ today, limit }) {
      const [suggestions, counts] = await Promise.all([
        query<DayPlanSuggestionSnapshot['suggestions'][number]>(pool, `
          SELECT id, title, priority, due_date AS "dueDate",
                 connector_type AS "connectorType",
                 CASE
                   WHEN due_date IS NOT NULL AND due_date < $1 THEN 'overdue'
                   WHEN due_date = $1 THEN 'due-today'
                   ELSE 'priority'
                 END AS reason
          FROM tasks
          WHERE status = 'todo'
            AND (
              (due_date IS NOT NULL AND due_date <= $1)
              OR priority IN ('critical', 'high')
            )
          ORDER BY
            CASE
              WHEN due_date IS NOT NULL AND due_date < $1 THEN 0
              WHEN due_date = $1 THEN 1
              WHEN priority = 'critical' THEN 2
              ELSE 3
            END ASC,
            due_date ASC NULLS LAST,
            ${PRIORITY_ORDER},
            id COLLATE "C" ASC
          LIMIT $2
        `, [today, limit]),
        query<{ open: number; overdue: number; dueToday: number }>(pool, `
          SELECT
            COUNT(*)::int AS open,
            COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < $1 THEN 1 ELSE 0 END), 0)::int AS overdue,
            COALESCE(SUM(CASE WHEN due_date = $1 THEN 1 ELSE 0 END), 0)::int AS "dueToday"
          FROM tasks
          WHERE status = 'todo'
        `, [today]),
      ]);
      return {
        suggestions,
        counts: counts[0] ?? { open: 0, overdue: 0, dueToday: 0 },
      };
    },
  };
}

/**
 * The single source of truth for "is this row still eligible?", rendered with
 * placeholders starting at `$${offset}`. The scan projects it as a flag and
 * `commitBatch` re-applies it inside the mutating statement, so a row that
 * changed between the two can never be mutated on the strength of a stale scan.
 */
function maintenanceEligibility(
  agentType: MaintenanceAgentType,
  now: string,
  offset: number,
): { text: string; values: unknown[] } {
  const nowDate = new Date(now);
  const placeholder = (index: number) => `$${offset + index}`;
  switch (agentType) {
    case 'dismiss-old-notifications': {
      const cutoff = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
      return {
        text: `${notificationIsInboxSqlPg(placeholder(0))}
          AND read_state = 'unread'
          AND level IN ('fyi', 'digest')
          AND received_at < ${placeholder(1)}`,
        values: [now, cutoff],
      };
    }
    case 'cleanup-done': {
      const cutoff = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
      return {
        text: `status = 'done' AND completed_at IS NOT NULL AND completed_at < ${placeholder(0)}`,
        values: [cutoff],
      };
    }
    case 'snooze-low-priority': {
      const today = formatDateInLocalTimezone(nowDate);
      return {
        text: `status = 'todo' AND due_date IS NOT NULL AND due_date < ${placeholder(0)}
          AND priority IN ('low', 'none')`,
        values: [today],
      };
    }
    case 'bulk-prioritize': {
      const today = formatDateInLocalTimezone(nowDate);
      const tomorrow = formatDateInLocalTimezone(new Date(nowDate.getTime() + 24 * 60 * 60 * 1_000));
      const threeDays = formatDateInLocalTimezone(new Date(nowDate.getTime() + 3 * 24 * 60 * 60 * 1_000));
      return {
        text: `status = 'todo' AND due_date IS NOT NULL AND (
          (due_date <= ${placeholder(0)} AND priority <> 'critical')
          OR (due_date > ${placeholder(0)} AND due_date <= ${placeholder(1)} AND priority = 'none')
          OR (due_date > ${placeholder(1)} AND due_date <= ${placeholder(2)} AND priority = 'none')
        )`,
        values: [today, tomorrow, threeDays],
      };
    }
  }
}

function maintenanceScanSql(
  agentType: MaintenanceAgentType,
  cursor: string | null,
  limit: number,
  now: string,
): { text: string; values: unknown[] } {
  const eligibility = maintenanceEligibility(agentType, now, 1);
  const values = [...eligibility.values];
  // The cursor comparison uses the same collation as the ordering, so a resume
  // can neither skip nor repeat rows under a non-C database collation.
  const cursorClause = cursor ? ` AND id COLLATE "C" > $${values.length + 1}` : '';
  if (cursor) values.push(cursor);
  const limitPlaceholder = `$${values.length + 1}`;
  values.push(limit);

  const nowDate = new Date(now);
  const source = agentType === 'dismiss-old-notifications' ? 'notifications' : 'tasks';
  const extraColumns = agentType === 'bulk-prioritize'
    ? ', priority, due_date AS "dueDate"'
    : agentType === 'snooze-low-priority'
      ? `, 'due date -> ${formatDateInLocalTimezone(
          new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1_000),
        )}' AS result`
      : '';

  return {
    text: `
      SELECT id, title${extraColumns},
        CASE WHEN ${eligibility.text} THEN TRUE ELSE FALSE END AS eligible
      FROM ${source}
      WHERE TRUE ${cursorClause}
      ORDER BY id COLLATE "C"
      LIMIT ${limitPlaceholder}
    `,
    values,
  };
}

async function maintenanceScanBatch(
  pool: Pool,
  agentType: MaintenanceAgentType,
  cursor: string | null,
  limit: number,
  now: string,
): Promise<MaintenanceScanCandidate[]> {
  const { text, values } = maintenanceScanSql(agentType, cursor, limit, now);
  if (agentType === 'bulk-prioritize') {
    const rows = await query<{ id: string; title: string; priority: string; dueDate: string; eligible: boolean }>(
      pool, text, values,
    );
    const today = formatDateInLocalTimezone(new Date(now));
    const tomorrow = formatDateInLocalTimezone(new Date(new Date(now).getTime() + 24 * 60 * 60 * 1_000));
    return rows.map((row) => {
      const newPriority = row.dueDate <= today ? 'critical' : row.dueDate <= tomorrow ? 'high' : 'medium';
      return { id: row.id, title: row.title, result: `${row.priority} -> ${newPriority}`, eligible: row.eligible };
    });
  }
  const rows = await query<{ id: string; title: string; result?: string; eligible: boolean }>(pool, text, values);
  return rows.map((row) => ({ id: row.id, title: row.title, result: row.result, eligible: row.eligible }));
}

async function maintenanceApplyMutations(
  client: Pool | PoolClient,
  agentType: MaintenanceAgentType,
  ids: readonly string[],
  now: string,
  completedAt: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const nowDate = new Date(now);
  // `RETURNING id` names the rows the eligibility re-check actually mutated,
  // so a caller can never attribute work to a row it skipped.
  const mutated = async (text: string, values: unknown[]): Promise<string[]> => (
    (await client.query<{ id: string }>(text, values)).rows.map((row) => row.id)
  );
  switch (agentType) {
    case 'dismiss-old-notifications': {
      const eligibility = maintenanceEligibility(agentType, now, 3);
      return mutated(`
        UPDATE notifications
        SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
            read_at = COALESCE(read_at, $1), dismissed_at = $1
        WHERE id = ANY($2::text[]) AND (${eligibility.text})
        RETURNING id
      `, [completedAt, ids, ...eligibility.values]);
    }
    case 'cleanup-done': {
      const eligibility = maintenanceEligibility(agentType, now, 3);
      return mutated(`
        UPDATE tasks SET status = 'cancelled', updated_at = $1
        WHERE id = ANY($2::text[]) AND (${eligibility.text})
        RETURNING id
      `, [completedAt, ids, ...eligibility.values]);
    }
    case 'snooze-low-priority': {
      const newDate = formatDateInLocalTimezone(new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1_000));
      const eligibility = maintenanceEligibility(agentType, now, 4);
      return mutated(`
        UPDATE tasks SET due_date = $1, updated_at = $2
        WHERE id = ANY($3::text[]) AND (${eligibility.text})
        RETURNING id
      `, [newDate, completedAt, ids, ...eligibility.values]);
    }
    case 'bulk-prioritize': {
      const today = formatDateInLocalTimezone(nowDate);
      const tomorrow = formatDateInLocalTimezone(new Date(nowDate.getTime() + 24 * 60 * 60 * 1_000));
      const eligibility = maintenanceEligibility(agentType, now, 5);
      return mutated(`
        UPDATE tasks
        SET priority = CASE
          WHEN due_date <= $1 THEN 'critical'
          WHEN due_date <= $2 THEN 'high'
          ELSE 'medium'
        END,
        updated_at = $3
        WHERE id = ANY($4::text[]) AND (${eligibility.text})
        RETURNING id
      `, [today, tomorrow, completedAt, ids, ...eligibility.values]);
    }
  }
}

function createPostgresMaintenancePersistence(pool: Pool): AIMaintenancePersistence {
  return {
    async claimRun({ runId, agentType, dryRun, cursor, leaseExpiresAt, startedAt }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`maintenance-agent:${agentType}`],
        );
        await client.query(`
          UPDATE maintenance_agent_runs
          SET status = 'timed_out', has_more = TRUE,
              error_message = 'Lease expired before the run completed', completed_at = $1
          WHERE agent_type = $2 AND status = 'running' AND lease_expires_at <= $3
        `, [startedAt, agentType, startedAt]);

        let effectiveCursor = cursor;
        if (!effectiveCursor && !dryRun) {
          const [previous] = await query<{ status: string; checkpointEnd: string | null }>(client, `
            SELECT status, checkpoint_end AS "checkpointEnd"
            FROM maintenance_agent_runs
            WHERE agent_type = $1 AND dry_run = FALSE
            ORDER BY started_at DESC, id COLLATE "C" DESC
            LIMIT 1
          `, [agentType]);
          if (previous?.status === 'partial') effectiveCursor = previous.checkpointEnd;
        }

        let claimed = true;
        try {
          await client.query(`
            INSERT INTO maintenance_agent_runs (
              id, agent_type, status, dry_run, checkpoint_start, lease_expires_at, started_at
            ) VALUES ($1, $2, 'running', $3, $4, $5, $6)
          `, [runId, agentType, dryRun, effectiveCursor, leaseExpiresAt, startedAt]);
        } catch (error) {
          if (!isUniqueViolationError(error)) throw error;
          claimed = false;
        }
        await client.query(claimed ? 'COMMIT' : 'ROLLBACK');
        return { claimed, cursor: effectiveCursor };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    scanBatch: ({ agentType, cursor, limit, now }) => maintenanceScanBatch(pool, agentType, cursor, limit, now),
    async commitBatch({
      runId, agentType, ids, now, completedAt, status, checkpoint, scanned, hasMore, error, guard,
    }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const appliedIds = await maintenanceApplyMutations(client, agentType, ids, now, completedAt);
        guard?.();
        await client.query(`
          UPDATE maintenance_agent_runs
          SET status = $1, checkpoint_end = $2, scanned_count = $3, mutation_count = $4,
              has_more = $5, error_message = $6, completed_at = $7
          WHERE id = $8
        `, [
          status, checkpoint, scanned, appliedIds.length,
          hasMore, error ?? null, completedAt, runId,
        ]);
        await client.query('COMMIT');
        return { applied: appliedIds.length, appliedIds };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

function createPostgresGoalsBoardPersistence(pool: Pool): AIGoalsBoardPersistence {
  return {
    async listGoalTasks({ tagSlugs, projectId }) {
      if (tagSlugs.length === 0) return [];
      const taggedRows = await query<{ taskId: string }>(pool, `
        SELECT DISTINCT tt.task_id AS "taskId"
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tag.slug = ANY($1::text[])
      `, [tagSlugs]);
      let taskIds = taggedRows.map((row) => row.taskId);
      if (taskIds.length === 0) return [];
      if (projectId) {
        const projectRows = await query<{ taskId: string }>(pool, `
          SELECT task_id AS "taskId" FROM task_projects
          WHERE project_id = $1 AND task_id = ANY($2::text[])
        `, [projectId, taskIds]);
        taskIds = projectRows.map((row) => row.taskId);
      }
      if (taskIds.length === 0) return [];

      const [taskRows, tagRows, projectRows] = await Promise.all([
        query<{
          id: string; title: string; description: string | null; status: string; priority: string;
          dueDate: string | null; createdAt: string; updatedAt: string; connectorType: string;
        }>(pool, `
          SELECT id, title, description, status, priority, due_date AS "dueDate",
                 created_at AS "createdAt", updated_at AS "updatedAt", connector_type AS "connectorType"
          FROM tasks WHERE id = ANY($1::text[])
        `, [taskIds]),
        query<{ taskId: string; id: string; name: string; slug: string; color: string | null; type: string }>(
          pool, `
            SELECT tt.task_id AS "taskId", tag.id, tag.name, tag.slug, tag.color, tag.type
            FROM task_tags tt
            INNER JOIN tags tag ON tag.id = tt.tag_id
            WHERE tt.task_id = ANY($1::text[])
          `, [taskIds],
        ),
        query<{ taskId: string; id: string; name: string; color: string | null; icon: string | null }>(pool, `
          SELECT tp.task_id AS "taskId", p.id, p.name, p.color, p.icon
          FROM task_projects tp
          INNER JOIN hub_projects p ON p.id = tp.project_id
          WHERE tp.task_id = ANY($1::text[])
        `, [taskIds]),
      ]);
      const linkedProjectIds = [...new Set(projectRows.map((row) => row.id))];
      const statsById = new Map<string, { total: number; done: number }>();
      const milestonesById = new Map<string, Array<{
        id: string; name: string; targetDate: string | null; completed: boolean; sortOrder: number;
      }>>();
      if (linkedProjectIds.length > 0) {
        const [statsRows, milestoneRows] = await Promise.all([
          query<{ projectId: string; total: number; done: number }>(pool, `
            SELECT tp.project_id AS "projectId",
                   COUNT(*)::int AS total,
                   SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)::int AS done
            FROM task_projects tp
            INNER JOIN tasks t ON t.id = tp.task_id
            WHERE tp.project_id = ANY($1::text[])
            GROUP BY tp.project_id
          `, [linkedProjectIds]),
          query<{
            id: string; projectId: string; name: string; targetDate: string | null;
            completedAt: string | null; sortOrder: number;
          }>(pool, `
            SELECT id, project_id AS "projectId", name, target_date AS "targetDate",
                   completed_at AS "completedAt", sort_order AS "sortOrder"
            FROM project_milestones
            WHERE project_id = ANY($1::text[])
          `, [linkedProjectIds]),
        ]);
        for (const row of statsRows) statsById.set(row.projectId, { total: row.total, done: row.done ?? 0 });
        for (const row of milestoneRows) {
          const list = milestonesById.get(row.projectId) ?? [];
          list.push({
            id: row.id, name: row.name, targetDate: row.targetDate,
            completed: Boolean(row.completedAt), sortOrder: row.sortOrder,
          });
          milestonesById.set(row.projectId, list);
        }
      }

      const tagsByTask = new Map<string, GoalTagRow[]>();
      for (const row of tagRows) {
        const list = tagsByTask.get(row.taskId) ?? [];
        list.push({ id: row.id, name: row.name, slug: row.slug, color: row.color, type: row.type });
        tagsByTask.set(row.taskId, list);
      }
      const projectsByTask = new Map<string, GoalLinkedProjectRow[]>();
      for (const row of projectRows) {
        const list = projectsByTask.get(row.taskId) ?? [];
        const stats = statsById.get(row.id);
        const milestones = (milestonesById.get(row.id) ?? [])
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map(({ id, name, targetDate, completed }) => ({ id, name, targetDate, completed }));
        list.push({
          id: row.id,
          name: row.name,
          color: row.color,
          icon: row.icon,
          totalTasks: stats?.total ?? 0,
          doneTasks: stats?.done ?? 0,
          milestones,
        });
        projectsByTask.set(row.taskId, list);
      }

      return taskRows.map((row) => ({
        id: row.id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        dueDate: row.dueDate,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        connectorType: row.connectorType,
        tags: tagsByTask.get(row.id) ?? [],
        linkedProjects: projectsByTask.get(row.id) ?? [],
      }));
    },
    async countGoalTags() {
      const rows = await query<{ taskId: string; slug: string }>(pool, `
        SELECT tt.task_id AS "taskId", tag.slug AS slug
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tag.slug IN ('goal', 'idea', 'brainstorm')
      `);
      return {
        goal: new Set(rows.filter((r) => r.slug === 'goal').map((r) => r.taskId)).size,
        idea: new Set(rows.filter((r) => r.slug === 'idea').map((r) => r.taskId)).size,
        brainstorm: new Set(rows.filter((r) => r.slug === 'brainstorm').map((r) => r.taskId)).size,
      };
    },
    async promoteGoal({ taskId, projectId, projectName, projectDescription, category, color, phases, now }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project:${projectId}`]);
        const [task] = await query<{ id: string; description: string | null; metadata: Record<string, unknown> }>(
          client, `SELECT id, description, metadata FROM tasks WHERE id = $1 LIMIT 1 FOR UPDATE`, [taskId],
        );
        if (!task) {
          await client.query('ROLLBACK');
          return { kind: 'not-found' } as const;
        }

        await client.query(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, source_bindings, auto_include_rules,
            kanban_columns, default_view, category, target_date, status, metadata,
            sort_order, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, NULL, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'list', $5, NULL,
            'active', $6::jsonb, 0, $7, $7
          )
        `, [
          projectId, projectName, projectDescription ?? task.description ?? null, color, category,
          JSON.stringify({ promotedFrom: taskId }), now,
        ]);
        await client.query(`
          INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
        `, [task.id, projectId]);

        const tasksCreated: string[] = [];
        for (let phaseIdx = 0; phaseIdx < phases.length; phaseIdx += 1) {
          const phase = phases[phaseIdx];
          const phaseId = `phase-${projectId}-${phaseIdx + 1}`;
          await client.query(`
            INSERT INTO project_phases (
              id, project_id, name, description, status, color, estimated_days,
              target_start, target_end, sort_order, completed_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, NULL, NULL, NULL, NULL, $6, NULL, $7, $7)
          `, [
            phaseId, projectId, phase.name, phase.description,
            phaseIdx === 0 ? 'in_progress' : 'pending', phaseIdx, now,
          ]);

          for (let taskIdx = 0; taskIdx < phase.tasks.length; taskIdx += 1) {
            const phaseTask = phase.tasks[taskIdx];
            const newTaskId = `mc-goal-${projectId}-p${phaseIdx + 1}-t${taskIdx + 1}`;
            await client.query(`
              INSERT INTO tasks (
                id, source_id, connector_type, connector_instance_id, title, description,
                status, priority, due_date, created_at, updated_at, completed_at, parent_id,
                depth, is_checklist_item, source_list_id, source_list_name, assignee, metadata,
                sync_status, last_synced_at, kanban_column, kanban_order
              ) VALUES ($1, $2, 'mission-control', 'mc-local', $3, $4, 'todo', 'medium', NULL, $5, $5,
                NULL, NULL, 0, FALSE, NULL, NULL, NULL, '{}'::jsonb, 'synced', $5, NULL, NULL)
            `, [newTaskId, newTaskId, phaseTask.title, phaseTask.description, now]);

            await client.query(`
              INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
            `, [newTaskId, projectId]);

            await client.query(`
              INSERT INTO project_phase_items (
                id, phase_id, task_id, sort_order, estimated_effort_hours, is_proposed,
                proposal_type, created_at
              ) VALUES ($1, $2, $3, $4, NULL, FALSE, NULL, $5)
            `, [`ppi-${phaseId}-${taskIdx}`, phaseId, newTaskId, taskIdx, now]);

            tasksCreated.push(newTaskId);
          }
        }

        await client.query(`
          UPDATE tasks SET status = 'done', completed_at = $1, updated_at = $1, metadata = $2::jsonb
          WHERE id = $3
        `, [now, JSON.stringify({ ...task.metadata, promotedToProject: projectId }), taskId]);

        await client.query('COMMIT');
        return { kind: 'promoted', projectId, tasksCreated } as const;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function createPostgresIdeationPersistence(pool: Pool): AIIdeationPersistence {
  return {
    async convertDraft({ project, phases, tasks: taskInputs, phaseItems, dependencies, now }) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`project:${project.id}`]);

        await client.query(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, icon_color, source_bindings,
            auto_include_rules, kanban_columns, default_view, metadata, created_at, updated_at
          ) VALUES (
            $1, $2, 'Created from the Graph ideation canvas.', $3, 'Lightbulb', $3,
            '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, 'list', $4::jsonb, $5, $5
          )
        `, [project.id, project.name, project.color, JSON.stringify(project.metadata), now]);

        for (const phase of phases) {
          await client.query(`
            INSERT INTO project_phases (
              id, project_id, name, description, status, color, sort_order, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7, $7)
          `, [phase.id, project.id, phase.name, phase.description, phase.color, phase.sortOrder, now]);
        }

        for (const task of taskInputs) {
          await client.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, description,
              status, priority, assignee, due_date, created_at, updated_at, completed_at,
              parent_id, depth, is_checklist_item, metadata, sync_status, last_synced_at,
              push_retry_count, effort, is_bulk_import
            ) VALUES ($1, $2, 'local', 'local', $3, $4, $5, $6, $7, $8, $9, $9, NULL, $10, $11,
              FALSE, $12::jsonb, 'synced', $9, 0, $13, FALSE)
          `, [
            task.id, task.id, task.title, task.description, task.status, task.priority,
            task.assignee, task.dueDate, now, task.parentId, task.depth,
            JSON.stringify(task.metadata), task.effort,
          ]);
          await client.query(`
            INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
          `, [task.id, project.id]);
        }

        for (const item of phaseItems) {
          await client.query(`
            INSERT INTO project_phase_items (id, phase_id, task_id, sort_order, created_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [randomUUID(), item.phaseId, item.taskId, item.sortOrder, now]);
        }

        const tagIdBySlug = new Map<string, string>();
        const tagSlugs = new Set<string>();
        for (const task of taskInputs) {
          for (const tagName of task.tagNames) {
            const slug = tagName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (slug) tagSlugs.add(slug);
          }
        }
        for (const slug of [...tagSlugs].sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tag-slug:${slug}`]);
        }
        for (const task of taskInputs) {
          for (const tagName of task.tagNames) {
            const slug = tagName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (!slug) continue;
            let tagId = tagIdBySlug.get(slug);
            if (!tagId) {
              // `tags.slug` carries no unique constraint, so it is not a valid
              // ON CONFLICT arbiter. The slug's advisory lock is already held
              // for this transaction, so a read-then-insert is safe, and the
              // lowest id is picked deterministically when duplicates exist.
              const [existing] = await query<{ id: string }>(
                client,
                'SELECT id FROM tags WHERE slug = $1 ORDER BY id COLLATE "C" ASC LIMIT 1',
                [slug],
              );
              tagId = existing?.id;
              if (!tagId) {
                tagId = `tag-${randomUUID()}`;
                await client.query(`
                  INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
                  VALUES ($1, $2, $3, 'hub', 'ideation', '#34d399', TRUE, $4)
                `, [tagId, tagName, slug, now]);
              }
              tagIdBySlug.set(slug, tagId);
            }
            await client.query(`
              INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)
            `, [task.id, tagId]);
          }
        }

        for (const dependency of dependencies) {
          await client.query(`
            INSERT INTO task_dependencies (
              id, task_id, depends_on_task_id, type, connector_instance_id,
              sync_status, sync_action, sync_error, last_synced_at, created_at
            ) VALUES ($1, $2, $3, $4, NULL, 'local', NULL, NULL, NULL, $5)
          `, [randomUUID(), dependency.taskId, dependency.dependsOnTaskId, dependency.type, now]);
        }

        await client.query('COMMIT');
        return { projectId: project.id };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

function resetRow(row: {
  id: string; type: string; periodStart: string; periodEnd: string;
  wentWell: string | null; needsAdjustment: string | null; notes: string | null;
  stats: unknown; aiSummary: string | null; staleActions: unknown;
  carryForwardItems: unknown; monthlyWin: string | null; monthlyChange: string | null;
  intentions: unknown; completedAt: string | null; createdAt: string; updatedAt: string;
}): ResetRow {
  return {
    ...row,
    staleActions: row.staleActions ?? [],
    carryForwardItems: row.carryForwardItems ?? [],
    intentions: row.intentions ?? null,
  };
}

const RESET_COLUMNS_PG = `
  id, type, period_start AS "periodStart", period_end AS "periodEnd",
  went_well AS "wentWell", needs_adjustment AS "needsAdjustment", notes,
  stats, ai_summary AS "aiSummary", stale_actions AS "staleActions",
  carry_forward_items AS "carryForwardItems", monthly_win AS "monthlyWin",
  monthly_change AS "monthlyChange", intentions, completed_at AS "completedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const RESET_PATCH_COLUMNS_PG: Record<keyof ResetPatch, string> = {
  wentWell: 'went_well',
  needsAdjustment: 'needs_adjustment',
  notes: 'notes',
  stats: 'stats',
  aiSummary: 'ai_summary',
  staleActions: 'stale_actions',
  carryForwardItems: 'carry_forward_items',
  monthlyWin: 'monthly_win',
  monthlyChange: 'monthly_change',
  intentions: 'intentions',
  completedAt: 'completed_at',
};

const RESET_JSON_PATCH_KEYS_PG = new Set<keyof ResetPatch>([
  'stats', 'staleActions', 'carryForwardItems', 'intentions',
]);

/** The keys the caller actually supplied — an explicit `null` counts, `undefined` does not. */
function presentResetPatchKeysPg(fields: ResetPatch): Array<keyof ResetPatch> {
  return (Object.keys(RESET_PATCH_COLUMNS_PG) as Array<keyof ResetPatch>)
    .filter((key) => fields[key] !== undefined);
}

function serializeResetPatchValuePg(key: keyof ResetPatch, value: unknown): unknown {
  if (!RESET_JSON_PATCH_KEYS_PG.has(key)) return value;
  if (value === undefined || value === null) {
    return key === 'staleActions' || key === 'carryForwardItems' ? JSON.stringify([]) : null;
  }
  return JSON.stringify(value);
}

function createPostgresResetsPersistence(pool: Pool): AIResetsPersistence {
  return {
    async get(type, periodStart) {
      const [row] = await query<Parameters<typeof resetRow>[0]>(pool, `
        SELECT ${RESET_COLUMNS_PG} FROM resets WHERE type = $1 AND period_start = $2 LIMIT 1
      `, [type, periodStart]);
      return row ? resetRow(row) : null;
    },
    async list(type, limit) {
      const rows = type
        ? await query<Parameters<typeof resetRow>[0]>(pool, `
            SELECT ${RESET_COLUMNS_PG} FROM resets WHERE type = $1
            ORDER BY period_start DESC LIMIT $2
          `, [type, limit])
        : await query<Parameters<typeof resetRow>[0]>(pool, `
            SELECT ${RESET_COLUMNS_PG} FROM resets ORDER BY period_start DESC LIMIT $1
          `, [limit]);
      return rows.map(resetRow);
    },
    async upsert({ type, periodStart, periodEnd, now, fields }) {
      const keys = presentResetPatchKeysPg(fields);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1))',
          [`reset:${type}:${periodStart}`],
        );
        const [existing] = await query<{ id: string }>(client, `
          SELECT id FROM resets WHERE type = $1 AND period_start = $2 LIMIT 1
        `, [type, periodStart]);

        if (existing) {
          // Only the supplied keys are written, so omitted fields keep their
          // stored value while an explicit null still clears the column.
          const setClauses = keys.map((key, index) => `${RESET_PATCH_COLUMNS_PG[key]} = $${index + 1}${
            RESET_JSON_PATCH_KEYS_PG.has(key) ? '::jsonb' : ''
          }`);
          const values = keys.map((key) => serializeResetPatchValuePg(key, fields[key]));
          await client.query(`
            UPDATE resets SET ${[...setClauses, `updated_at = $${keys.length + 1}`].join(', ')}
            WHERE id = $${keys.length + 2}
          `, [...values, now, existing.id]);
        } else {
          const id = `reset-${randomUUID().slice(0, 8)}`;
          await client.query(`
            INSERT INTO resets (
              id, type, period_start, period_end, went_well, needs_adjustment, notes, stats,
              ai_summary, stale_actions, carry_forward_items, monthly_win, monthly_change,
              intentions, completed_at, created_at, updated_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11::jsonb, $12, $13, $14::jsonb, $15, $16, $16)
          `, [
            id, type, periodStart, periodEnd,
            fields.wentWell ?? null,
            fields.needsAdjustment ?? null,
            fields.notes ?? null,
            fields.stats !== undefined && fields.stats !== null
              ? JSON.stringify(fields.stats)
              : null,
            fields.aiSummary ?? null,
            JSON.stringify(fields.staleActions ?? []),
            JSON.stringify(fields.carryForwardItems ?? []),
            fields.monthlyWin ?? null,
            fields.monthlyChange ?? null,
            fields.intentions !== undefined && fields.intentions !== null
              ? JSON.stringify(fields.intentions)
              : null,
            fields.completedAt ?? null,
            now,
          ]);
        }
        const [row] = await query<Parameters<typeof resetRow>[0]>(client, `
          SELECT ${RESET_COLUMNS_PG} FROM resets WHERE type = $1 AND period_start = $2 LIMIT 1
        `, [type, periodStart]);
        await client.query('COMMIT');
        return resetRow(row);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async patch(id, updates, now) {
      const keys = presentResetPatchKeysPg(updates);
      if (keys.length > 0) {
        const setClauses = keys.map((key, index) => `${RESET_PATCH_COLUMNS_PG[key]} = $${index + 1}${
          RESET_JSON_PATCH_KEYS_PG.has(key) ? '::jsonb' : ''
        }`);
        const values = keys.map((key) => serializeResetPatchValuePg(key, updates[key]));
        await pool.query(`
          UPDATE resets SET ${setClauses.join(', ')}, updated_at = $${keys.length + 1}
          WHERE id = $${keys.length + 2}
        `, [...values, now, id]);
      }
      const [row] = await query<Parameters<typeof resetRow>[0]>(pool, `
        SELECT ${RESET_COLUMNS_PG} FROM resets WHERE id = $1 LIMIT 1
      `, [id]);
      return row ? resetRow(row) : null;
    },
    async aggregateStats({
      periodStart, periodEnd, periodStartIso, periodEndExclusiveIso,
      staleThresholdExclusiveIso, staleLimit,
    }) {
      const [
        completedTasks, createdTaskCountRows, carriedForwardCountRows, activeRoutines,
        periodCompletions, focusItems, staleTasks, energyData,
      ] = await Promise.all([
        query<{ id: string; title: string; completedAt: string | null }>(pool, `
          SELECT id, title, completed_at AS "completedAt"
          FROM tasks
          WHERE status = 'done' AND ${withinInstantRange('completed_at', 1, 2)}
        `, [periodStartIso, periodEndExclusiveIso]),
        query<{ count: number }>(pool, `
          SELECT COUNT(*)::int AS count FROM tasks
          WHERE ${withinInstantRange('created_at', 1, 2)}
        `, [periodStartIso, periodEndExclusiveIso]),
        query<{ count: number }>(pool, `
          SELECT COUNT(*)::int AS count FROM tasks
          WHERE status NOT IN ('done', 'cancelled')
            AND ${instant('created_at')} < $1::timestamptz
        `, [periodEndExclusiveIso]),
        query<{ id: string; cadenceType: string }>(pool, `
          SELECT id, cadence_type AS "cadenceType" FROM routines
          WHERE is_active = TRUE AND is_archived = FALSE
        `),
        query<{ routineId: string; date: string }>(pool, `
          SELECT routine_id AS "routineId", date FROM routine_completions
          WHERE date >= $1 AND date <= $2
        `, [periodStart, periodEnd]),
        query<{ taskId: string; date: string; slot: number }>(pool, `
          SELECT task_id AS "taskId", date, slot FROM focus_items
          WHERE scope = 'today' AND date >= $1 AND date <= $2
        `, [periodStart, periodEnd]),
        query<ResetStatsStaleTaskRow>(pool, `
          SELECT id, title, updated_at AS "updatedAt", status, priority, source_id AS "sourceId",
                 connector_type AS "connectorType", connector_instance_id AS "connectorInstanceId"
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled')
            AND ${instant('updated_at')} < $1::timestamptz
          LIMIT $2
        `, [staleThresholdExclusiveIso, staleLimit]),
        query<{ date: string; level: string }>(pool, `
          SELECT date, level FROM energy_checkins WHERE date >= $1 AND date <= $2
        `, [periodStart, periodEnd]),
      ]);
      const focusTaskIds = [...new Set(focusItems.map((item) => item.taskId))];
      const focusTaskStatuses = focusTaskIds.length > 0
        ? await query<{ id: string; title: string; status: string }>(pool, `
            SELECT id, title, status FROM tasks WHERE id = ANY($1::text[])
          `, [focusTaskIds])
        : [];
      return {
        completedTasks,
        createdTaskCount: createdTaskCountRows[0]?.count ?? 0,
        carriedForwardCount: carriedForwardCountRows[0]?.count ?? 0,
        activeRoutines,
        periodCompletions,
        focusItems,
        staleTasks,
        energyData,
        focusTaskStatuses,
      };
    },
  };
}

interface ResetStatsStaleTaskRow {
  id: string;
  title: string;
  updatedAt: string;
  status: string;
  priority: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
}

function createPostgresAIWorkflowBackend(
  pool: Pool,
  reader: Pool | PoolClient = pool,
): AIWorkflowBackend {
  return {
    context: {
      listTaskContext: () => query(reader, `
        SELECT id, title, status, priority, due_date AS "dueDate" FROM tasks
      `),
      async getTriageContext(now) {
        const rows = await query<{ level: string; category: string | null }>(reader, `
          SELECT level, category FROM notifications
          WHERE ${NOTIFICATION_NEEDS_ATTENTION}
        `, [now]);
        return {
          unreadCount: rows.length,
          criticalCount: rows.filter((row) => (
            row.level === 'critical' || row.level === 'urgent'
          )).length,
          categories: [...new Set(rows.map((row) => row.category).filter(
            (category): category is string => Boolean(category),
          ))].slice(0, 5),
        };
      },
      loadDigestSnapshot: (input) => loadDigestSnapshot(pool, input),
    },
    getTaskBreakdownContext: (taskId) => getTaskBreakdownContext(pool, taskId),

    notifications: {
      listForClassification: (now, limit) => query(reader, `
        SELECT id, title, level, category, is_actionable AS "isActionable",
               connector_type AS "connectorType", received_at AS "receivedAt"
        FROM notifications
        WHERE ${NOTIFICATION_NEEDS_ATTENTION}
        ORDER BY received_at COLLATE "C" DESC, id COLLATE "C" ASC
        LIMIT $2
      `, [now, limit]),
    },

    recommendations: {
      listAssignmentProjects: () => query(reader, `
        SELECT id, name, description FROM hub_projects
      `),
      listAssignmentTasks: (limit) => query(reader, `
        SELECT id, title, connector_type AS "connectorType",
               source_list_name AS "sourceListName"
        FROM tasks WHERE status = 'todo'
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      listTagInferenceTasks: (limit) => query(reader, `
        SELECT id, title, connector_type AS "connectorType",
               source_list_name AS "sourceListName"
        FROM tasks WHERE status = 'todo'
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      async listTaggedTaskIds() {
        const rows = await query<{ taskId: string }>(
          reader,
          'SELECT task_id AS "taskId" FROM task_tags',
        );
        return rows.map((row) => row.taskId);
      },
      async listAvailableTagNames() {
        const rows = await query<{ name: string }>(reader, 'SELECT name FROM tags');
        return rows.map((row) => row.name);
      },
      listSmartPriorityTasks: (limit) => query(reader, `
        SELECT id, title, priority, due_date AS "dueDate",
               connector_type AS "connectorType", source_list_name AS "sourceListName",
               updated_at AS "updatedAt"
        FROM tasks
        WHERE status = 'todo'
        ORDER BY updated_at COLLATE "C" DESC, id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      listMicroStatusTasks: (limit) => query(reader, `
        SELECT id, title, status, micro_status AS "microStatus", priority,
               created_at AS "createdAt", updated_at AS "updatedAt", due_date AS "dueDate",
               connector_type AS "connectorType", assignee
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled')
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      async listEnergySuggestionTasksByIds(taskIds, limit) {
        if (taskIds.length === 0) return [];
        const uniqueIds = [...new Set(taskIds)].slice(0, Math.max(0, limit));
        if (uniqueIds.length === 0) return [];
        const rows = await query<{
          id: string;
          title: string;
          description: string | null;
          priority: string;
          connectorType: string;
        }>(reader, `
          SELECT id, title, description, priority, connector_type AS "connectorType"
          FROM tasks
          WHERE id = ANY($1::text[])
          ORDER BY id COLLATE "C" ASC
        `, [uniqueIds]);
        const byId = new Map(rows.map((row) => [row.id, row]));
        return uniqueIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        });
      },
      listOpenTopLevelEnergySuggestionTasks: (limit) => query(reader, `
        SELECT id, title, description, priority, connector_type AS "connectorType"
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled') AND depth = 0
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      async listEnergyLevels(taskIds) {
        if (taskIds.length === 0) return [];
        const rows = await query<{ taskId: string; slug: string }>(reader, `
          SELECT tt.task_id AS "taskId", t.slug
          FROM task_tags tt
          INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id = ANY($1::text[])
            AND t.slug = ANY($2::text[])
          ORDER BY tt.task_id COLLATE "C",
            CASE t.slug
              WHEN 'energy-high' THEN 0
              WHEN 'energy-medium' THEN 1
              ELSE 2
            END,
            t.id COLLATE "C"
        `, [taskIds, ENERGY_SLUGS]);
        const result: Array<{ taskId: string; energyLevel: EnergyDemandLevel }> = [];
        const seen = new Set<string>();
        for (const row of rows) {
          const energyLevel = energyLevelForSlug(row.slug);
          if (!energyLevel || seen.has(row.taskId)) continue;
          seen.add(row.taskId);
          result.push({ taskId: row.taskId, energyLevel });
        }
        return result;
      },
      listWhatsNextTasks: (limit) => query(reader, `
        SELECT id, title, priority, due_date AS "dueDate",
               connector_type AS "connectorType", source_list_name AS "sourceListName"
        FROM tasks WHERE status = 'todo'
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      listWhatsNextNotifications: (now, limit) => query(reader, `
        SELECT connector_type AS "connectorType"
        FROM notifications
        WHERE ${NOTIFICATION_NEEDS_ATTENTION}
        ORDER BY received_at COLLATE "C" DESC, id COLLATE "C" ASC
        LIMIT $2
      `, [now, limit]),
      applyEnergyTagSuggestions: (input) => applyEnergyTags(pool, input),
    },

    planning: {
      listPlanDayItems: (date) => query(reader, `
        SELECT t.id, t.title, t.priority, t.due_date AS "dueDate",
               t.connector_type AS "connectorType"
        FROM my_day_items m
        INNER JOIN tasks t ON m.task_id = t.id
        WHERE m.date = $1
      `, [date]),
      listPlanDaySchedules: (date) => query(reader, `
        SELECT task_id AS "taskId", scheduled_time AS "scheduledTime",
               estimated_duration AS "estimatedDuration"
        FROM task_schedules
        WHERE scheduled_date = $1
      `, [date]),
      listPlanDayOpenTasks: (limit) => query(reader, `
        SELECT id, title, priority, due_date AS "dueDate",
               connector_type AS "connectorType"
        FROM tasks WHERE status = 'todo'
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      async listFocusTaskIds(scope, date) {
        const rows = await query<{ taskId: string }>(reader, `
          SELECT task_id AS "taskId" FROM focus_items WHERE scope = $1 AND date = $2
        `, [scope, date]);
        return rows.map((row) => row.taskId);
      },
      listFocusCandidates: (limit) => query(reader, `
        SELECT id, title, status, priority, due_date AS "dueDate",
               connector_type AS "connectorType", source_list_name AS "sourceListName",
               created_at AS "createdAt", updated_at AS "updatedAt", depth
        FROM tasks
        WHERE status <> 'done' AND status <> 'cancelled' AND depth = 0
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
      async listMyDayTaskIds(date) {
        const rows = await query<{ taskId: string }>(
          reader,
          'SELECT task_id AS "taskId" FROM my_day_items WHERE date = $1',
          [date],
        );
        return rows.map((row) => row.taskId);
      },
      async listProjectTaskIds(projectId) {
        const rows = await query<{ taskId: string }>(
          reader,
          'SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1',
          [projectId],
        );
        return rows.map((row) => row.taskId);
      },
      async listOpenPhaseTaskIds() {
        const rows = await query<{ id: string }>(
          reader,
          `SELECT id FROM tasks WHERE status NOT IN ('done', 'cancelled')`,
        );
        return rows.map((row) => row.id);
      },
      async listPhasePlanningTasks(taskIds) {
        if (taskIds.length === 0) return [];
        const ids = [...taskIds];
        const taskRows = await query<
          Omit<PhasePlanningContextTask, 'tags' | 'projectNames'>
        >(reader, `
          SELECT id, title, description, status, priority, due_date AS "dueDate",
                 connector_type AS "connectorType", source_list_name AS "sourceListName",
                 updated_at AS "updatedAt"
          FROM tasks WHERE id = ANY($1::text[])
        `, [ids]);
        const tagRows = await query<{ taskId: string; tagName: string }>(reader, `
          SELECT tt.task_id AS "taskId", t.name AS "tagName"
          FROM task_tags tt
          INNER JOIN tags t ON tt.tag_id = t.id
          WHERE tt.task_id = ANY($1::text[])
          ORDER BY tt.task_id COLLATE "C" ASC, t.name COLLATE "C" ASC, t.id COLLATE "C" ASC
        `, [ids]);
        const projectRows = await query<{ taskId: string; projectName: string }>(reader, `
          SELECT tp.task_id AS "taskId", p.name AS "projectName"
          FROM task_projects tp
          INNER JOIN hub_projects p ON tp.project_id = p.id
          WHERE tp.task_id = ANY($1::text[])
          ORDER BY tp.task_id COLLATE "C" ASC, p.name COLLATE "C" ASC, p.id COLLATE "C" ASC
        `, [ids]);
        const tags = new Map<string, string[]>();
        for (const row of tagRows) {
          const values = tags.get(row.taskId) ?? [];
          values.push(row.tagName);
          tags.set(row.taskId, values);
        }
        const projects = new Map<string, string[]>();
        for (const row of projectRows) {
          const values = projects.get(row.taskId) ?? [];
          values.push(row.projectName);
          projects.set(row.taskId, values);
        }
        const rowsById = new Map(taskRows.map((row) => [row.id, row]));
        return ids.flatMap((id) => {
          const row = rowsById.get(id);
          return row
            ? [{ ...row, tags: tags.get(id) ?? [], projectNames: projects.get(id) ?? [] }]
            : [];
        });
      },
    },

    goals: {
      async getTask(taskId) {
        const [row] = await query<{
          id: string;
          title: string;
          description: string | null;
          connectorType: string;
        }>(reader, `
          SELECT id, title, description, connector_type AS "connectorType"
          FROM tasks WHERE id = $1 LIMIT 1
        `, [taskId]);
        return row ?? null;
      },
      listTaskTags: (taskId) => query(reader, `
        SELECT t.name, t.slug
        FROM task_tags tt
        INNER JOIN tags t ON tt.tag_id = t.id
        WHERE tt.task_id = $1
      `, [taskId]),
      listLinkedProjects: (taskId) => query(reader, `
        SELECT p.name, p.description, p.category
        FROM task_projects tp
        INNER JOIN hub_projects p ON tp.project_id = p.id
        WHERE tp.task_id = $1
      `, [taskId]),
      listExistingProjects: (limit) => query(reader, `
        SELECT name, category FROM hub_projects
        ORDER BY id COLLATE "C" ASC
        LIMIT $1
      `, [limit]),
    },

    async listTaskConnectorTypes(taskIds) {
      if (taskIds.length === 0) return [];
      const rows = await query<{ connectorType: string }>(reader, `
        SELECT connector_type AS "connectorType"
        FROM tasks
        WHERE id = ANY($1::text[])
      `, [taskIds]);
      return rows.map((row) => row.connectorType);
    },
  };
}

export function createPostgresAIWorkflowPersistence(pool: Pool): AIWorkflowPersistence {
  const backend = createPostgresAIWorkflowBackend(pool);
  return {
    context: backend.context,
    getTaskBreakdownContext: backend.getTaskBreakdownContext,
    notifications: backend.notifications,
    recommendations: {
      listAssignmentProjects: backend.recommendations.listAssignmentProjects,
      listAssignmentTasks: backend.recommendations.listAssignmentTasks,
      listTagInferenceTasks: backend.recommendations.listTagInferenceTasks,
      listTaggedTaskIds: backend.recommendations.listTaggedTaskIds,
      listAvailableTagNames: backend.recommendations.listAvailableTagNames,
      listSmartPriorityTasks: backend.recommendations.listSmartPriorityTasks,
      listMicroStatusTasks: backend.recommendations.listMicroStatusTasks,
      listWhatsNextTasks: backend.recommendations.listWhatsNextTasks,
      listWhatsNextNotifications: backend.recommendations.listWhatsNextNotifications,
    },
    listTaskConnectorTypes: backend.listTaskConnectorTypes,
    dayPlan: createPostgresDayPlanPersistence(pool),
    taskTools: createPostgresTaskToolsPersistence(pool),
    dispatch: createPostgresDispatchPersistence(pool),
    maintenance: createPostgresMaintenancePersistence(pool),
    goalsBoard: createPostgresGoalsBoardPersistence(pool),
    ideation: createPostgresIdeationPersistence(pool),
    resets: createPostgresResetsPersistence(pool),
  };
}

export function createPostgresAIDailyPlanningExtensions(
  pool: Pool,
): Pick<DailyPlanningPersistence, 'dayPlan' | 'energySuggestions'> & {
  getFocusSuggestionContext: NonNullable<
    DailyPlanningPersistence['focus']['getSuggestionContext']
  >;
} {
  const backend = createPostgresAIWorkflowBackend(pool);
  return {
    dayPlan: {
      async getContext({ date, openTaskLimit }) {
        return withReadOnlySnapshot(pool, async (client) => {
          const snapshot = createPostgresAIWorkflowBackend(pool, client);
          const myDayItems = await snapshot.planning.listPlanDayItems(date);
          const schedules = await snapshot.planning.listPlanDaySchedules(date);
          const openTasks = await snapshot.planning.listPlanDayOpenTasks(openTaskLimit);
          return { myDayItems, schedules, openTasks };
        });
      },
    },
    energySuggestions: {
      listTasksByIds: backend.recommendations.listEnergySuggestionTasksByIds,
      listOpenTopLevelTasks:
        backend.recommendations.listOpenTopLevelEnergySuggestionTasks,
      listLevels: backend.recommendations.listEnergyLevels,
      apply: backend.recommendations.applyEnergyTagSuggestions,
    },
    async getFocusSuggestionContext({ scope, date, effectiveDate, taskLimit }) {
      return withReadOnlySnapshot(pool, async (client) => {
        const snapshot = createPostgresAIWorkflowBackend(pool, client);
        const focusTaskIds = await snapshot.planning.listFocusTaskIds(scope, effectiveDate);
        const tasks = await snapshot.planning.listFocusCandidates(taskLimit);
        const myDayTaskIds = await snapshot.planning.listMyDayTaskIds(date);
        return { focusTaskIds, tasks, myDayTaskIds };
      });
    },
  };
}

export function createPostgresAIProjectOrganizationExtensions(
  pool: Pool,
): Pick<
  ProjectAdministrationPersistence,
  'listPhasePlanningTaskIds' | 'listPhasePlanningTasks' | 'getGoalDevelopmentContext'
> {
  const backend = createPostgresAIWorkflowBackend(pool);
  return {
    listPhasePlanningTaskIds: (projectId) => (
      projectId
        ? backend.planning.listProjectTaskIds(projectId)
        : backend.planning.listOpenPhaseTaskIds()
    ),
    listPhasePlanningTasks: (taskIds) => withReadOnlySnapshot(pool, (client) => (
      createPostgresAIWorkflowBackend(pool, client).planning.listPhasePlanningTasks(taskIds)
    )),
    async getGoalDevelopmentContext(taskId, existingProjectLimit): Promise<
      GoalDevelopmentContext | null
    > {
      return withReadOnlySnapshot(pool, async (client) => {
        const snapshot = createPostgresAIWorkflowBackend(pool, client);
        const task = await snapshot.goals.getTask(taskId);
        if (!task) return null;
        const tags = await snapshot.goals.listTaskTags(taskId);
        const linkedProjects = await snapshot.goals.listLinkedProjects(taskId);
        const existingProjects = await snapshot.goals.listExistingProjects(existingProjectLimit);
        return { task, tags, linkedProjects, existingProjects };
      });
    },
  };
}
