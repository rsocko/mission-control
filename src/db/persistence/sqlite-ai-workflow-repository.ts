import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { NOTIFICATION_IS_INBOX_SQL } from '@/lib/notifications/lifecycle-sql';
import { formatDateInLocalTimezone } from '@/lib/utils/date';
import type {
  AIDigestSnapshot,
  AIWorkflowPersistence,
  TaskBreakdownContext,
} from './ai-workflows';
import type {
  DailyPlanningPersistence,
  DayPlanSchedule,
  DayPlanTask,
  EnergyDemandLevel,
  EnergySuggestionPersistence,
  EnergyTagDefinition,
  FocusSuggestionTask,
} from './daily-planning';
import type {
  GoalDevelopmentContext,
  PhasePlanningContextTask,
  ProjectAdministrationPersistence,
} from './project-organization';
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
} from './ai-workflows';

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
  AND (snoozed_until IS NULL OR snoozed_until <= ?)
  AND read_state = 'unread'
  AND (level IS NULL OR level IN ('urgent', 'action_needed', 'heads_up', 'fyi'))
`;
const PRIORITY_ORDER = `
  CASE priority
    WHEN 'critical' THEN 0
    WHEN 'high' THEN 1
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 3
    ELSE 4
  END
`;

function placeholders(values: readonly unknown[]): string {
  return values.map(() => '?').join(', ');
}

function energyLevelForSlug(slug: string): EnergyDemandLevel | null {
  if (slug === 'energy-high') return 'high';
  if (slug === 'energy-medium') return 'medium';
  if (slug === 'energy-low') return 'low';
  return null;
}

function loadDigestSnapshot(
  sqlite: Database.Database,
  input: { today: string; now: string; rowsPerCategory: number },
): AIDigestSnapshot {
  const openCondition = `status NOT IN ('done', 'cancelled')`;
  const taskCounts = sqlite.prepare(`
    SELECT
      COUNT(*) AS open,
      COALESCE(SUM(CASE WHEN due_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
      COALESCE(SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END), 0) AS dueToday,
      COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) AS inProgress,
      COALESCE(SUM(CASE WHEN priority IN ('critical', 'high') THEN 1 ELSE 0 END), 0) AS critical
    FROM tasks
    WHERE ${openCondition}
  `).get(input.today, input.today) as {
    open: number;
    overdue: number;
    dueToday: number;
    inProgress: number;
    critical: number;
  } | undefined;
  const overdue = sqlite.prepare(`
    SELECT id, title, priority, due_date AS dueDate, connector_type AS connectorType
    FROM tasks
    WHERE ${openCondition} AND due_date < ?
    ORDER BY due_date ASC, ${PRIORITY_ORDER}, id ASC
    LIMIT ?
  `).all(input.today, input.rowsPerCategory) as AIDigestSnapshot['overdue'];
  const dueToday = sqlite.prepare(`
    SELECT id, title, priority, due_date AS dueDate, connector_type AS connectorType
    FROM tasks
    WHERE ${openCondition} AND due_date = ?
    ORDER BY ${PRIORITY_ORDER}, updated_at DESC, id ASC
    LIMIT ?
  `).all(input.today, input.rowsPerCategory) as AIDigestSnapshot['dueToday'];
  const inProgress = sqlite.prepare(`
    SELECT id, title, priority, due_date AS dueDate, connector_type AS connectorType
    FROM tasks
    WHERE ${openCondition} AND status = 'in_progress'
    ORDER BY ${PRIORITY_ORDER}, updated_at DESC, id ASC
    LIMIT ?
  `).all(input.rowsPerCategory) as AIDigestSnapshot['inProgress'];
  const notificationCounts = sqlite.prepare(`
    SELECT
      COUNT(*) AS unread,
      COALESCE(SUM(CASE WHEN level IN ('critical', 'urgent') THEN 1 ELSE 0 END), 0) AS urgent
    FROM notifications
    WHERE ${NOTIFICATION_NEEDS_ATTENTION}
  `).get(input.now) as { unread: number; urgent: number } | undefined;
  const notificationRows = sqlite.prepare(`
    SELECT id, title, level, connector_type AS connectorType
    FROM notifications
    WHERE ${NOTIFICATION_NEEDS_ATTENTION}
    ORDER BY level_rank ASC, received_at DESC, id ASC
    LIMIT ?
  `).all(input.now, input.rowsPerCategory) as AIDigestSnapshot['notifications'];
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

function getTaskBreakdownContext(
  sqlite: Database.Database,
  taskId: string,
): TaskBreakdownContext | null {
  return sqlite.transaction(() => {
    const task = sqlite.prepare(`
      SELECT id, title, description, priority, due_date AS dueDate, effort,
             source_list_name AS sourceListName, connector_type AS connectorType,
             updated_at AS updatedAt
      FROM tasks
      WHERE id = ?
      LIMIT 1
    `).get(taskId) as TaskBreakdownContext['task'] | undefined;
    if (!task) return null;
    const tagNames = (sqlite.prepare(`
      SELECT tag.name
      FROM task_tags tt
      INNER JOIN tags tag ON tag.id = tt.tag_id
      WHERE tt.task_id = ?
      ORDER BY tag.name COLLATE BINARY ASC, tag.id COLLATE BINARY ASC
      LIMIT 20
    `).all(taskId) as Array<{ name: string }>).map((row) => row.name);
    const projectNames = (sqlite.prepare(`
      SELECT project.name
      FROM task_projects tp
      INNER JOIN hub_projects project ON project.id = tp.project_id
      WHERE tp.task_id = ?
      ORDER BY project.name COLLATE BINARY ASC, project.id COLLATE BINARY ASC
      LIMIT 10
    `).all(taskId) as Array<{ name: string }>).map((row) => row.name);
    const subtaskTitles = (sqlite.prepare(`
      SELECT title
      FROM tasks
      WHERE parent_id = ?
      ORDER BY title COLLATE BINARY ASC, id COLLATE BINARY ASC
      LIMIT 30
    `).all(taskId) as Array<{ title: string }>).map((row) => row.title);
    return { task, tagNames, projectNames, subtaskTitles };
  }).deferred();
}

function applyEnergyTags(
  sqlite: Database.Database,
  input: {
    definitions: readonly EnergyTagDefinition[];
    suggestions: ReadonlyArray<{ taskId: string; energyLevel: EnergyDemandLevel }>;
    createdAt: string;
  },
) {
  const transaction = sqlite.transaction(() => {
    const canonicalTagIds: Partial<Record<EnergyTagDefinition['slug'], string>> = {};
    for (const definition of input.definitions) {
      let tag = sqlite.prepare(`
        SELECT id FROM tags WHERE slug = ? ORDER BY id COLLATE BINARY LIMIT 1
      `).get(definition.slug) as { id: string } | undefined;
      if (!tag) {
        const id = `tag-${definition.slug}-${randomUUID().slice(0, 8)}`;
        sqlite.prepare(`
          INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
          VALUES (?, ?, ?, 'ai-inferred', 'energy-system', ?, 1, ?)
        `).run(id, definition.name, definition.slug, definition.color, input.createdAt);
        tag = { id };
      }
      canonicalTagIds[definition.slug] = tag.id;
    }

    const requestedTaskIds = [...new Set(input.suggestions.map((entry) => entry.taskId))];
    const existingTaskIds = new Set<string>();
    const tasksWithEnergyTags = new Set<string>();
    if (requestedTaskIds.length > 0) {
      const existingRows = sqlite.prepare(`
        SELECT id FROM tasks
        WHERE id IN (${placeholders(requestedTaskIds)})
      `).all(...requestedTaskIds) as Array<{ id: string }>;
      for (const row of existingRows) existingTaskIds.add(row.id);

      const rows = sqlite.prepare(`
        SELECT DISTINCT tt.task_id AS taskId
        FROM task_tags tt
        INNER JOIN tags t ON t.id = tt.tag_id
        WHERE tt.task_id IN (${placeholders(requestedTaskIds)})
          AND t.slug IN (${placeholders(ENERGY_SLUGS)})
      `).all(...requestedTaskIds, ...ENERGY_SLUGS) as Array<{ taskId: string }>;
      for (const row of rows) tasksWithEnergyTags.add(row.taskId);
    }

    const appliedTaskIds: string[] = [];
    for (const suggestion of input.suggestions) {
      if (!existingTaskIds.has(suggestion.taskId)) continue;
      if (tasksWithEnergyTags.has(suggestion.taskId)) continue;
      const tagId = canonicalTagIds[`energy-${suggestion.energyLevel}`];
      if (!tagId) continue;
      sqlite.prepare(`
        INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)
      `).run(suggestion.taskId, tagId);
      tasksWithEnergyTags.add(suggestion.taskId);
      appliedTaskIds.push(suggestion.taskId);
    }
    return { canonicalTagIds, appliedTaskIds };
  });

  return transaction.immediate();
}

function loadDayPlanContext(
  sqlite: Database.Database,
  input: { date: string; openTaskLimit: number },
) {
  return sqlite.transaction(() => {
    const myDayItems = sqlite.prepare(`
      SELECT t.id, t.title, t.priority, t.due_date AS dueDate,
             t.connector_type AS connectorType
      FROM my_day_items m
      INNER JOIN tasks t ON m.task_id = t.id
      WHERE m.date = ?
    `).all(input.date) as DayPlanTask[];
    const schedules = sqlite.prepare(`
      SELECT task_id AS taskId, scheduled_time AS scheduledTime,
             estimated_duration AS estimatedDuration
      FROM task_schedules
      WHERE scheduled_date = ?
    `).all(input.date) as DayPlanSchedule[];
    const openTasks = sqlite.prepare(`
      SELECT id, title, priority, due_date AS dueDate,
             connector_type AS connectorType
      FROM tasks WHERE status = 'todo'
      ORDER BY id ASC
      LIMIT ?
    `).all(input.openTaskLimit) as DayPlanTask[];
    return { myDayItems, schedules, openTasks };
  }).deferred();
}

function loadFocusSuggestionContext(
  sqlite: Database.Database,
  input: { scope: string; date: string; effectiveDate: string; taskLimit: number },
) {
  return sqlite.transaction(() => {
    const focusTaskIds = (sqlite.prepare(`
      SELECT task_id AS taskId FROM focus_items WHERE scope = ? AND date = ?
    `).all(input.scope, input.effectiveDate) as Array<{ taskId: string }>)
      .map((row) => row.taskId);
    const tasks = sqlite.prepare(`
      SELECT id, title, status, priority, due_date AS dueDate,
             connector_type AS connectorType, source_list_name AS sourceListName,
             created_at AS createdAt, updated_at AS updatedAt, depth
      FROM tasks
      WHERE status <> 'done' AND status <> 'cancelled' AND depth = 0
      ORDER BY id ASC
      LIMIT ?
    `).all(input.taskLimit) as FocusSuggestionTask[];
    const myDayTaskIds = (sqlite.prepare(`
      SELECT task_id AS taskId FROM my_day_items WHERE date = ?
    `).all(input.date) as Array<{ taskId: string }>).map((row) => row.taskId);
    return { focusTaskIds, tasks, myDayTaskIds };
  }).deferred();
}

function loadGoalDevelopmentContext(
  sqlite: Database.Database,
  taskId: string,
  existingProjectLimit: number,
): GoalDevelopmentContext | null {
  return sqlite.transaction(() => {
    const task = (sqlite.prepare(`
      SELECT id, title, description, connector_type AS connectorType
      FROM tasks WHERE id = ? LIMIT 1
    `).get(taskId) as GoalDevelopmentContext['task'] | undefined) ?? null;
    if (!task) return null;
    const tags = sqlite.prepare(`
      SELECT t.name, t.slug
      FROM task_tags tt
      INNER JOIN tags t ON tt.tag_id = t.id
      WHERE tt.task_id = ?
    `).all(taskId) as GoalDevelopmentContext['tags'];
    const linkedProjects = sqlite.prepare(`
      SELECT p.name, p.description, p.category
      FROM task_projects tp
      INNER JOIN hub_projects p ON tp.project_id = p.id
      WHERE tp.task_id = ?
    `).all(taskId) as GoalDevelopmentContext['linkedProjects'];
    const existingProjects = sqlite.prepare(`
      SELECT name, category FROM hub_projects
      ORDER BY id ASC
      LIMIT ?
    `).all(existingProjectLimit) as GoalDevelopmentContext['existingProjects'];
    return { task, tags, linkedProjects, existingProjects };
  }).deferred();
}

function createSqliteTaskToolsPersistence(
  sqlite: Database.Database,
): AITaskToolsPersistence {
  return {
    async getSummary({ today, overdueLimit }) {
      const counts = sqlite.prepare(`
        SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled') THEN 1 ELSE 0 END), 0) AS open,
          COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled')
            AND due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
          COALESCE(SUM(CASE WHEN status NOT IN ('done', 'cancelled')
            AND priority IN ('critical', 'high') THEN 1 ELSE 0 END), 0) AS critical,
          COALESCE(SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
        FROM tasks
      `).get(today) as {
        total: number; open: number; overdue: number; critical: number; done: number;
      } | undefined;
      const bySourceRows = sqlite.prepare(`
        SELECT connector_type AS connectorType, COUNT(*) AS count
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled')
        GROUP BY connector_type
      `).all() as Array<{ connectorType: string; count: number }>;
      const overdueItems = sqlite.prepare(`
        SELECT id, title, status, micro_status AS microStatus, due_date AS dueDate,
               priority, connector_type AS source
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled') AND due_date IS NOT NULL AND due_date < ?
        ORDER BY due_date ASC, id ASC
        LIMIT ?
      `).all(today, overdueLimit) as Awaited<ReturnType<
        AITaskToolsPersistence['getSummary']
      >>['overdueItems'];
      return {
        total: Number(counts?.total ?? 0),
        open: Number(counts?.open ?? 0),
        overdue: Number(counts?.overdue ?? 0),
        critical: Number(counts?.critical ?? 0),
        done: Number(counts?.done ?? 0),
        bySource: Object.fromEntries(bySourceRows.map((row) => [row.connectorType, row.count])),
        overdueItems,
      };
    },
    async search(filters) {
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (filters.status) { conditions.push('status = ?'); params.push(filters.status); }
      if (filters.priority) { conditions.push('priority = ?'); params.push(filters.priority); }
      if (filters.source) { conditions.push('connector_type = ?'); params.push(filters.source); }
      if (filters.query) {
        conditions.push(`(
          instr(lower(title), lower(?)) > 0
          OR instr(lower(COALESCE(description, '')), lower(?)) > 0
        )`);
        params.push(filters.query, filters.query);
      }
      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = sqlite.prepare(`
        SELECT id, title, status, micro_status AS microStatus, priority, due_date AS dueDate,
               connector_type AS connectorType, source_list_name AS sourceListName, description
        FROM tasks
        ${where}
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(...params, filters.limit) as Array<{
        id: string; title: string; status: string; microStatus: string | null;
        priority: string; dueDate: string | null; connectorType: string;
        sourceListName: string | null; description: string | null;
      }>;
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
    async listAllTags() {
      return sqlite.prepare(`
        SELECT id, name, type, color FROM tags
      `).all() as Awaited<ReturnType<AITaskToolsPersistence['listAllTags']>>;
    },
    async listTaskTags(taskId) {
      return sqlite.prepare(`
        SELECT tag.id, tag.name, tag.type, tag.color
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tt.task_id = ?
      `).all(taskId) as Awaited<ReturnType<AITaskToolsPersistence['listTaskTags']>>;
    },
  };
}

function createSqliteDispatchPersistence(
  sqlite: Database.Database,
): AIDispatchPersistence {
  return {
    async getCustomAgentContext({ taskLimit, notificationLimit }) {
      const openTasks = sqlite.prepare(`
        SELECT id, title, priority, due_date AS dueDate, connector_type AS connectorType
        FROM tasks
        WHERE status = 'todo'
        ORDER BY id ASC
        LIMIT ?
      `).all(taskLimit) as Awaited<ReturnType<
        AIDispatchPersistence['getCustomAgentContext']
      >>['openTasks'];
      const now = new Date().toISOString();
      const unreadNotifications = sqlite.prepare(`
        SELECT id, title, level, connector_type AS connectorType
        FROM notifications
        WHERE ${NOTIFICATION_NEEDS_ATTENTION}
        ORDER BY received_at DESC, id ASC
        LIMIT ?
      `).all(now, notificationLimit) as Awaited<ReturnType<
        AIDispatchPersistence['getCustomAgentContext']
      >>['unreadNotifications'];
      return { openTasks, unreadNotifications };
    },
  };
}

function createSqliteDayPlanPersistence(
  sqlite: Database.Database,
): AIDayPlanPersistence {
  return {
    async listSuggestions({ today, limit }) {
      const suggestions = sqlite.prepare(`
        SELECT id, title, priority, due_date AS dueDate,
               connector_type AS connectorType,
               CASE
                 WHEN due_date IS NOT NULL AND due_date < ? THEN 'overdue'
                 WHEN due_date = ? THEN 'due-today'
                 ELSE 'priority'
               END AS reason
        FROM tasks
        WHERE status = 'todo'
          AND (
            (due_date IS NOT NULL AND due_date <= ?)
            OR priority IN ('critical', 'high')
          )
        ORDER BY
          CASE
            WHEN due_date IS NOT NULL AND due_date < ? THEN 0
            WHEN due_date = ? THEN 1
            WHEN priority = 'critical' THEN 2
            ELSE 3
          END ASC,
          (due_date IS NULL) ASC,
          due_date ASC,
          ${PRIORITY_ORDER},
          id ASC
        LIMIT ?
      `).all(today, today, today, today, today, limit) as DayPlanSuggestionSnapshot['suggestions'];
      const counts = sqlite.prepare(`
        SELECT
          COUNT(*) AS open,
          COALESCE(SUM(CASE WHEN due_date IS NOT NULL AND due_date < ? THEN 1 ELSE 0 END), 0) AS overdue,
          COALESCE(SUM(CASE WHEN due_date = ? THEN 1 ELSE 0 END), 0) AS dueToday
        FROM tasks
        WHERE status = 'todo'
      `).get(today, today) as DayPlanSuggestionSnapshot['counts'] | undefined;
      return {
        suggestions,
        counts: counts ?? { open: 0, overdue: 0, dueToday: 0 },
      };
    },
  };
}

/**
 * The single source of truth for "is this row still eligible?" — used both by
 * the scan (as a projected flag) and, re-applied, by the mutating statement in
 * `commitBatch`, so a row that changed between the two can never be mutated on
 * the strength of a stale scan.
 */
function maintenanceEligibility(
  agentType: MaintenanceAgentType,
  now: string,
): { text: string; values: unknown[] } {
  const nowDate = new Date(now);
  switch (agentType) {
    case 'dismiss-old-notifications': {
      const cutoff = new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
      return {
        text: `${NOTIFICATION_IS_INBOX_SQL}
          AND read_state = 'unread'
          AND level IN ('fyi', 'digest')
          AND received_at < ?`,
        values: [now, cutoff],
      };
    }
    case 'cleanup-done': {
      const cutoff = new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
      return {
        text: `status = 'done' AND completed_at IS NOT NULL AND completed_at < ?`,
        values: [cutoff],
      };
    }
    case 'snooze-low-priority': {
      const today = formatDateInLocalTimezone(nowDate);
      return {
        text: `status = 'todo' AND due_date IS NOT NULL AND due_date < ? AND priority IN ('low', 'none')`,
        values: [today],
      };
    }
    case 'bulk-prioritize': {
      const today = formatDateInLocalTimezone(nowDate);
      const tomorrow = formatDateInLocalTimezone(new Date(nowDate.getTime() + 24 * 60 * 60 * 1_000));
      const threeDays = formatDateInLocalTimezone(new Date(nowDate.getTime() + 3 * 24 * 60 * 60 * 1_000));
      return {
        text: `status = 'todo' AND due_date IS NOT NULL AND (
          (due_date <= ? AND priority <> 'critical')
          OR (due_date > ? AND due_date <= ? AND priority = 'none')
          OR (due_date > ? AND due_date <= ? AND priority = 'none')
        )`,
        values: [today, today, tomorrow, tomorrow, threeDays],
      };
    }
  }
}

function maintenanceScanBatch(
  sqlite: Database.Database,
  agentType: MaintenanceAgentType,
  cursor: string | null,
  limit: number,
  now: string,
): MaintenanceScanCandidate[] {
  const cursorClause = cursor ? ' AND id > ?' : '';
  const cursorArgs = cursor ? [cursor] : [];
  const nowDate = new Date(now);
  const eligibility = maintenanceEligibility(agentType, now);

  switch (agentType) {
    case 'dismiss-old-notifications': {
      const rows = sqlite.prepare(`
        SELECT id, title,
          CASE WHEN ${eligibility.text} THEN 1 ELSE 0 END AS eligible
        FROM notifications
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(...eligibility.values, ...cursorArgs, limit) as Array<{
        id: string; title: string; eligible: number;
      }>;
      return rows.map((row) => ({ id: row.id, title: row.title, eligible: row.eligible === 1 }));
    }
    case 'cleanup-done': {
      const rows = sqlite.prepare(`
        SELECT id, title,
          CASE WHEN ${eligibility.text} THEN 1 ELSE 0 END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(...eligibility.values, ...cursorArgs, limit) as Array<{
        id: string; title: string; eligible: number;
      }>;
      return rows.map((row) => ({ id: row.id, title: row.title, eligible: row.eligible === 1 }));
    }
    case 'snooze-low-priority': {
      const newDate = formatDateInLocalTimezone(new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1_000));
      const rows = sqlite.prepare(`
        SELECT id, title, 'due date -> ${newDate}' AS result,
          CASE WHEN ${eligibility.text} THEN 1 ELSE 0 END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(...eligibility.values, ...cursorArgs, limit) as Array<{
        id: string; title: string; result: string; eligible: number;
      }>;
      return rows.map((row) => ({
        id: row.id, title: row.title, result: row.result, eligible: row.eligible === 1,
      }));
    }
    case 'bulk-prioritize': {
      const today = formatDateInLocalTimezone(nowDate);
      const tomorrow = formatDateInLocalTimezone(new Date(nowDate.getTime() + 24 * 60 * 60 * 1_000));
      const rows = sqlite.prepare(`
        SELECT id, title, priority, due_date AS dueDate,
          CASE WHEN ${eligibility.text} THEN 1 ELSE 0 END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(...eligibility.values, ...cursorArgs, limit) as Array<{
        id: string; title: string; priority: string; dueDate: string; eligible: number;
      }>;
      return rows.map((row) => {
        const newPriority = row.dueDate <= today ? 'critical' : row.dueDate <= tomorrow ? 'high' : 'medium';
        return {
          id: row.id,
          title: row.title,
          result: `${row.priority} -> ${newPriority}`,
          eligible: row.eligible === 1,
        };
      });
    }
  }
}

function maintenanceApplyMutations(
  sqlite: Database.Database,
  agentType: MaintenanceAgentType,
  ids: readonly string[],
  now: string,
  completedAt: string,
): string[] {
  if (ids.length === 0) return [];
  const nowDate = new Date(now);
  const eligibility = maintenanceEligibility(agentType, now);
  // `RETURNING id` names the rows the eligibility re-check actually mutated,
  // so a caller can never attribute work to a row it skipped.
  const mutated = (text: string, ...values: unknown[]): string[] =>
    (sqlite.prepare(text).all(...values) as Array<{ id: string }>).map((row) => row.id);
  switch (agentType) {
    case 'dismiss-old-notifications':
      return mutated(`
        UPDATE notifications
        SET state = 'dismissed', read_state = 'read', disposition = 'dismissed',
            read_at = COALESCE(read_at, ?), dismissed_at = ?
        WHERE id IN (${placeholders(ids)}) AND (${eligibility.text})
        RETURNING id
      `, completedAt, completedAt, ...ids, ...eligibility.values);
    case 'cleanup-done':
      return mutated(`
        UPDATE tasks SET status = 'cancelled', updated_at = ?
        WHERE id IN (${placeholders(ids)}) AND (${eligibility.text})
        RETURNING id
      `, completedAt, ...ids, ...eligibility.values);
    case 'snooze-low-priority': {
      const newDate = formatDateInLocalTimezone(new Date(nowDate.getTime() + 7 * 24 * 60 * 60 * 1_000));
      return mutated(`
        UPDATE tasks SET due_date = ?, updated_at = ?
        WHERE id IN (${placeholders(ids)}) AND (${eligibility.text})
        RETURNING id
      `, newDate, completedAt, ...ids, ...eligibility.values);
    }
    case 'bulk-prioritize': {
      const today = formatDateInLocalTimezone(nowDate);
      const tomorrow = formatDateInLocalTimezone(new Date(nowDate.getTime() + 24 * 60 * 60 * 1_000));
      return mutated(`
        UPDATE tasks
        SET priority = CASE
          WHEN due_date <= ? THEN 'critical'
          WHEN due_date <= ? THEN 'high'
          ELSE 'medium'
        END,
        updated_at = ?
        WHERE id IN (${placeholders(ids)}) AND (${eligibility.text})
        RETURNING id
      `, today, tomorrow, completedAt, ...ids, ...eligibility.values);
    }
  }
}

function createSqliteMaintenancePersistence(
  sqlite: Database.Database,
): AIMaintenancePersistence {
  return {
    async claimRun({ runId, agentType, dryRun, cursor, leaseExpiresAt, startedAt }) {
      const transaction = sqlite.transaction((): MaintenanceClaimResult => {
        sqlite.prepare(`
          UPDATE maintenance_agent_runs
          SET status = 'timed_out', has_more = 1,
              error_message = 'Lease expired before the run completed', completed_at = ?
          WHERE agent_type = ? AND status = 'running' AND lease_expires_at <= ?
        `).run(startedAt, agentType, startedAt);

        let effectiveCursor = cursor;
        if (!effectiveCursor && !dryRun) {
          const previous = sqlite.prepare(`
            SELECT status, checkpoint_end AS checkpointEnd
            FROM maintenance_agent_runs
            WHERE agent_type = ? AND dry_run = 0
            ORDER BY started_at DESC, rowid DESC
            LIMIT 1
          `).get(agentType) as { status: string; checkpointEnd: string | null } | undefined;
          if (previous?.status === 'partial') effectiveCursor = previous.checkpointEnd;
        }

        try {
          sqlite.prepare(`
            INSERT INTO maintenance_agent_runs (
              id, agent_type, status, dry_run, checkpoint_start, lease_expires_at, started_at
            ) VALUES (?, ?, 'running', ?, ?, ?, ?)
          `).run(runId, agentType, dryRun ? 1 : 0, effectiveCursor, leaseExpiresAt, startedAt);
        } catch (error) {
          if (
            typeof error === 'object' && error !== null && 'code' in error
            && String(error.code).startsWith('SQLITE_CONSTRAINT')
          ) {
            return { claimed: false, cursor: effectiveCursor };
          }
          throw error;
        }
        return { claimed: true, cursor: effectiveCursor };
      });
      return transaction.immediate();
    },
    async scanBatch({ agentType, cursor, limit, now }) {
      return maintenanceScanBatch(sqlite, agentType, cursor, limit, now);
    },
    async commitBatch({
      runId, agentType, ids, now, completedAt, status, checkpoint, scanned, hasMore, error, guard,
    }) {
      const transaction = sqlite.transaction(() => {
        const appliedIds = maintenanceApplyMutations(sqlite, agentType, ids, now, completedAt);
        guard?.();
        sqlite.prepare(`
          UPDATE maintenance_agent_runs
          SET status = ?, checkpoint_end = ?, scanned_count = ?, mutation_count = ?,
              has_more = ?, error_message = ?, completed_at = ?
          WHERE id = ?
        `).run(
          status, checkpoint, scanned, appliedIds.length,
          hasMore ? 1 : 0, error ?? null, completedAt, runId,
        );
        return { applied: appliedIds.length, appliedIds };
      });
      return transaction.immediate();
    },
  };
}

function createSqliteGoalsBoardPersistence(
  sqlite: Database.Database,
): AIGoalsBoardPersistence {
  return {
    async listGoalTasks({ tagSlugs, projectId }) {
      if (tagSlugs.length === 0) return [];
      const taggedRows = sqlite.prepare(`
        SELECT DISTINCT tt.task_id AS taskId
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tag.slug IN (${placeholders(tagSlugs)})
      `).all(...tagSlugs) as Array<{ taskId: string }>;
      let taskIds = taggedRows.map((row) => row.taskId);
      if (taskIds.length === 0) return [];
      if (projectId) {
        const projectRows = sqlite.prepare(`
          SELECT task_id AS taskId FROM task_projects
          WHERE project_id = ? AND task_id IN (${placeholders(taskIds)})
        `).all(projectId, ...taskIds) as Array<{ taskId: string }>;
        taskIds = projectRows.map((row) => row.taskId);
      }
      if (taskIds.length === 0) return [];

      const taskRows = sqlite.prepare(`
        SELECT id, title, description, status, priority, due_date AS dueDate,
               created_at AS createdAt, updated_at AS updatedAt, connector_type AS connectorType
        FROM tasks WHERE id IN (${placeholders(taskIds)})
      `).all(...taskIds) as Array<{
        id: string; title: string; description: string | null; status: string; priority: string;
        dueDate: string | null; createdAt: string; updatedAt: string; connectorType: string;
      }>;
      const tagRows = sqlite.prepare(`
        SELECT tt.task_id AS taskId, tag.id, tag.name, tag.slug, tag.color, tag.type
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tt.task_id IN (${placeholders(taskIds)})
      `).all(...taskIds) as Array<{
        taskId: string; id: string; name: string; slug: string; color: string | null; type: string;
      }>;
      const projectRows = sqlite.prepare(`
        SELECT tp.task_id AS taskId, p.id, p.name, p.color, p.icon
        FROM task_projects tp
        INNER JOIN hub_projects p ON p.id = tp.project_id
        WHERE tp.task_id IN (${placeholders(taskIds)})
      `).all(...taskIds) as Array<{
        taskId: string; id: string; name: string; color: string | null; icon: string | null;
      }>;
      const linkedProjectIds = [...new Set(projectRows.map((row) => row.id))];
      const statsById = new Map<string, { total: number; done: number }>();
      const milestonesById = new Map<string, Array<{
        id: string; name: string; targetDate: string | null; completed: boolean; sortOrder: number;
      }>>();
      if (linkedProjectIds.length > 0) {
        const statsRows = sqlite.prepare(`
          SELECT tp.project_id AS projectId,
                 COUNT(*) AS total,
                 SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done
          FROM task_projects tp
          INNER JOIN tasks t ON t.id = tp.task_id
          WHERE tp.project_id IN (${placeholders(linkedProjectIds)})
          GROUP BY tp.project_id
        `).all(...linkedProjectIds) as Array<{ projectId: string; total: number; done: number }>;
        for (const row of statsRows) statsById.set(row.projectId, { total: row.total, done: row.done ?? 0 });

        const milestoneRows = sqlite.prepare(`
          SELECT id, project_id AS projectId, name, target_date AS targetDate,
                 completed_at AS completedAt, sort_order AS sortOrder
          FROM project_milestones
          WHERE project_id IN (${placeholders(linkedProjectIds)})
        `).all(...linkedProjectIds) as Array<{
          id: string; projectId: string; name: string; targetDate: string | null;
          completedAt: string | null; sortOrder: number;
        }>;
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
      const rows = sqlite.prepare(`
        SELECT tt.task_id AS taskId, tag.slug AS slug
        FROM task_tags tt
        INNER JOIN tags tag ON tag.id = tt.tag_id
        WHERE tag.slug IN ('goal', 'idea', 'brainstorm')
      `).all() as Array<{ taskId: string; slug: string }>;
      return {
        goal: new Set(rows.filter((r) => r.slug === 'goal').map((r) => r.taskId)).size,
        idea: new Set(rows.filter((r) => r.slug === 'idea').map((r) => r.taskId)).size,
        brainstorm: new Set(rows.filter((r) => r.slug === 'brainstorm').map((r) => r.taskId)).size,
      };
    },
    async promoteGoal({ taskId, projectId, projectName, projectDescription, category, color, phases, now }) {
      const transaction = sqlite.transaction(() => {
        const task = sqlite.prepare(`
          SELECT id, description, metadata FROM tasks WHERE id = ? LIMIT 1
        `).get(taskId) as { id: string; description: string | null; metadata: string | null } | undefined;
        if (!task) return { kind: 'not-found' } as const;

        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, source_bindings, auto_include_rules,
            kanban_columns, default_view, category, target_date, status, metadata,
            sort_order, created_at, updated_at
          ) VALUES (?, ?, ?, ?, NULL, '[]', '[]', '[]', 'list', ?, NULL, 'active', ?, 0, ?, ?)
        `).run(
          projectId, projectName, projectDescription ?? task.description ?? null, color, category,
          JSON.stringify({ promotedFrom: taskId }), now, now,
        );
        sqlite.prepare(`
          INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
        `).run(task.id, projectId);

        const tasksCreated: string[] = [];
        phases.forEach((phase, phaseIdx) => {
          const phaseId = `phase-${projectId}-${phaseIdx + 1}`;
          sqlite.prepare(`
            INSERT INTO project_phases (
              id, project_id, name, description, status, color, estimated_days,
              target_start, target_end, sort_order, completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, NULL, ?, ?)
          `).run(
            phaseId, projectId, phase.name, phase.description,
            phaseIdx === 0 ? 'in_progress' : 'pending', phaseIdx, now, now,
          );

          phase.tasks.forEach((phaseTask, taskIdx) => {
            const newTaskId = `mc-goal-${projectId}-p${phaseIdx + 1}-t${taskIdx + 1}`;
            sqlite.prepare(`
              INSERT INTO tasks (
                id, source_id, connector_type, connector_instance_id, title, description,
                status, priority, due_date, created_at, updated_at, completed_at, parent_id,
                depth, is_checklist_item, source_list_id, source_list_name, assignee, metadata,
                sync_status, last_synced_at, kanban_column, kanban_order
              ) VALUES (?, ?, 'mission-control', 'mc-local', ?, ?, 'todo', 'medium', NULL, ?, ?,
                NULL, NULL, 0, 0, NULL, NULL, NULL, '{}', 'synced', ?, NULL, NULL)
            `).run(newTaskId, newTaskId, phaseTask.title, phaseTask.description, now, now, now);

            sqlite.prepare(`
              INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
            `).run(newTaskId, projectId);

            sqlite.prepare(`
              INSERT INTO project_phase_items (
                id, phase_id, task_id, sort_order, estimated_effort_hours, is_proposed,
                proposal_type, created_at
              ) VALUES (?, ?, ?, ?, NULL, 0, NULL, ?)
            `).run(`ppi-${phaseId}-${taskIdx}`, phaseId, newTaskId, taskIdx, now);

            tasksCreated.push(newTaskId);
          });
        });

        const existingMetadata = task.metadata ? JSON.parse(task.metadata) as object : {};
        sqlite.prepare(`
          UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ?, metadata = ?
          WHERE id = ?
        `).run(now, now, JSON.stringify({ ...existingMetadata, promotedToProject: projectId }), taskId);

        return { kind: 'promoted', projectId, tasksCreated } as const;
      });
      return transaction.immediate();
    },
  };
}

function createSqliteIdeationPersistence(
  sqlite: Database.Database,
): AIIdeationPersistence {
  return {
    async convertDraft({ project, phases, tasks: taskInputs, phaseItems, dependencies, now }) {
      const transaction = sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, icon_color, source_bindings,
            auto_include_rules, kanban_columns, default_view, metadata, created_at, updated_at
          ) VALUES (?, ?, 'Created from the Graph ideation canvas.', ?, 'Lightbulb', ?, '[]', '[]', '[]', 'list', ?, ?, ?)
        `).run(
          project.id, project.name, project.color, project.color,
          JSON.stringify(project.metadata), now, now,
        );

        for (const phase of phases) {
          sqlite.prepare(`
            INSERT INTO project_phases (
              id, project_id, name, description, status, color, sort_order, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
          `).run(phase.id, project.id, phase.name, phase.description, phase.color, phase.sortOrder, now, now);
        }

        for (const task of taskInputs) {
          sqlite.prepare(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, description,
              status, priority, assignee, due_date, created_at, updated_at, completed_at,
              parent_id, depth, is_checklist_item, metadata, sync_status, last_synced_at,
              push_retry_count, effort, is_bulk_import
            ) VALUES (?, ?, 'local', 'local', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, 'synced', ?, 0, ?, 0)
          `).run(
            task.id, task.id, task.title, task.description, task.status, task.priority,
            task.assignee, task.dueDate, now, now, task.parentId, task.depth,
            JSON.stringify(task.metadata), now, task.effort,
          );
          sqlite.prepare(`
            INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)
          `).run(task.id, project.id);
        }

        for (const item of phaseItems) {
          sqlite.prepare(`
            INSERT INTO project_phase_items (id, phase_id, task_id, sort_order, created_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(randomUUID(), item.phaseId, item.taskId, item.sortOrder, now);
        }

        const tagIdBySlug = new Map<string, string>();
        for (const task of taskInputs) {
          for (const tagName of task.tagNames) {
            const slug = tagName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
            if (!slug) continue;
            let tagId = tagIdBySlug.get(slug);
            if (!tagId) {
              // `tags.slug` is not unique, so the existing row is resolved
              // deterministically (lowest id) rather than by upsert arbiter.
              const existing = sqlite.prepare(`
                SELECT id FROM tags WHERE slug = ? ORDER BY id COLLATE BINARY ASC LIMIT 1
              `).get(slug) as { id: string } | undefined;
              tagId = existing?.id;
              if (!tagId) {
                tagId = `tag-${randomUUID()}`;
                sqlite.prepare(`
                  INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
                  VALUES (?, ?, ?, 'hub', 'ideation', '#34d399', 1, ?)
                `).run(tagId, tagName, slug, now);
              }
              tagIdBySlug.set(slug, tagId);
            }
            sqlite.prepare(`
              INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)
            `).run(task.id, tagId);
          }
        }

        for (const dependency of dependencies) {
          sqlite.prepare(`
            INSERT INTO task_dependencies (
              id, task_id, depends_on_task_id, type, connector_instance_id,
              sync_status, sync_action, sync_error, last_synced_at, created_at
            ) VALUES (?, ?, ?, ?, NULL, 'local', NULL, NULL, NULL, ?)
          `).run(randomUUID(), dependency.taskId, dependency.dependsOnTaskId, dependency.type, now);
        }

        return { projectId: project.id };
      });
      return transaction.immediate();
    },
  };
}

function resetRow(row: {
  id: string; type: string; periodStart: string; periodEnd: string;
  wentWell: string | null; needsAdjustment: string | null; notes: string | null;
  stats: string | null; aiSummary: string | null; staleActions: string | null;
  carryForwardItems: string | null; monthlyWin: string | null; monthlyChange: string | null;
  intentions: string | null; completedAt: string | null; createdAt: string; updatedAt: string;
}): ResetRow {
  return {
    ...row,
    stats: row.stats ? JSON.parse(row.stats) : null,
    staleActions: row.staleActions ? JSON.parse(row.staleActions) : [],
    carryForwardItems: row.carryForwardItems ? JSON.parse(row.carryForwardItems) : [],
    intentions: row.intentions ? JSON.parse(row.intentions) : null,
  };
}

const RESET_COLUMNS = `
  id, type, period_start AS periodStart, period_end AS periodEnd,
  went_well AS wentWell, needs_adjustment AS needsAdjustment, notes,
  stats, ai_summary AS aiSummary, stale_actions AS staleActions,
  carry_forward_items AS carryForwardItems, monthly_win AS monthlyWin,
  monthly_change AS monthlyChange, intentions, completed_at AS completedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;

const RESET_PATCH_COLUMNS: Record<keyof ResetPatch, string> = {
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

const RESET_JSON_PATCH_KEYS = new Set<keyof ResetPatch>([
  'stats', 'staleActions', 'carryForwardItems', 'intentions',
]);

function serializeResetPatchValue(key: keyof ResetPatch, value: unknown): unknown {
  if (!RESET_JSON_PATCH_KEYS.has(key)) return value;
  if (value === undefined || value === null) {
    return key === 'staleActions' || key === 'carryForwardItems' ? JSON.stringify([]) : null;
  }
  return JSON.stringify(value);
}

/** The keys the caller actually supplied — an explicit `null` counts, `undefined` does not. */
function presentResetPatchKeys(fields: ResetPatch): Array<keyof ResetPatch> {
  return (Object.keys(RESET_PATCH_COLUMNS) as Array<keyof ResetPatch>)
    .filter((key) => fields[key] !== undefined);
}

function createSqliteResetsPersistence(
  sqlite: Database.Database,
): AIResetsPersistence {
  return {
    async get(type, periodStart) {
      const row = sqlite.prepare(`
        SELECT ${RESET_COLUMNS} FROM resets WHERE type = ? AND period_start = ? LIMIT 1
      `).get(type, periodStart) as Parameters<typeof resetRow>[0] | undefined;
      return row ? resetRow(row) : null;
    },
    async list(type, limit) {
      const rows = type
        ? sqlite.prepare(`
            SELECT ${RESET_COLUMNS} FROM resets WHERE type = ?
            ORDER BY period_start DESC LIMIT ?
          `).all(type, limit)
        : sqlite.prepare(`
            SELECT ${RESET_COLUMNS} FROM resets ORDER BY period_start DESC LIMIT ?
          `).all(limit);
      return (rows as Array<Parameters<typeof resetRow>[0]>).map(resetRow);
    },
    async upsert({ type, periodStart, periodEnd, now, fields }) {
      const keys = presentResetPatchKeys(fields);
      const transaction = sqlite.transaction((): ResetRow => {
        const existing = sqlite.prepare(`
          SELECT id FROM resets WHERE type = ? AND period_start = ? LIMIT 1
        `).get(type, periodStart) as { id: string } | undefined;

        if (existing) {
          // Only the supplied keys are written, so omitted fields keep their
          // stored value while an explicit null still clears the column.
          const setClauses = keys.map((key) => `${RESET_PATCH_COLUMNS[key]} = ?`);
          const values = keys.map((key) => serializeResetPatchValue(key, fields[key]));
          sqlite.prepare(`
            UPDATE resets SET ${[...setClauses, 'updated_at = ?'].join(', ')}
            WHERE id = ?
          `).run(...values, now, existing.id);
        } else {
          const id = `reset-${randomUUID().slice(0, 8)}`;
          sqlite.prepare(`
            INSERT INTO resets (
              id, type, period_start, period_end, went_well, needs_adjustment, notes, stats,
              ai_summary, stale_actions, carry_forward_items, monthly_win, monthly_change,
              intentions, completed_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
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
            now, now,
          );
        }

        const row = sqlite.prepare(`
          SELECT ${RESET_COLUMNS} FROM resets WHERE type = ? AND period_start = ? LIMIT 1
        `).get(type, periodStart) as Parameters<typeof resetRow>[0];
        return resetRow(row);
      });
      return transaction.immediate();
    },
    async patch(id, updates, now) {
      const keys = presentResetPatchKeys(updates);
      if (keys.length > 0) {
        const setClauses = keys.map((key) => `${RESET_PATCH_COLUMNS[key]} = ?`);
        const values = keys.map((key) => serializeResetPatchValue(key, updates[key]));
        sqlite.prepare(`
          UPDATE resets SET ${setClauses.join(', ')}, updated_at = ? WHERE id = ?
        `).run(...values, now, id);
      }
      const row = sqlite.prepare(`
        SELECT ${RESET_COLUMNS} FROM resets WHERE id = ? LIMIT 1
      `).get(id) as Parameters<typeof resetRow>[0] | undefined;
      return row ? resetRow(row) : null;
    },
    async aggregateStats({
      periodStart, periodEnd, periodStartIso, periodEndExclusiveIso,
      staleThresholdExclusiveIso, staleLimit,
    }) {
      const completedTasks = sqlite.prepare(`
        SELECT id, title, completed_at AS completedAt
        FROM tasks
        WHERE status = 'done'
          AND julianday(completed_at) >= julianday(?)
          AND julianday(completed_at) < julianday(?)
      `).all(periodStartIso, periodEndExclusiveIso) as Array<{
        id: string; title: string; completedAt: string | null;
      }>;
      const createdTaskCount = (sqlite.prepare(`
        SELECT COUNT(*) AS count FROM tasks
        WHERE julianday(created_at) >= julianday(?) AND julianday(created_at) < julianday(?)
      `).get(periodStartIso, periodEndExclusiveIso) as { count: number }).count;
      const carriedForwardCount = (sqlite.prepare(`
        SELECT COUNT(*) AS count FROM tasks
        WHERE status NOT IN ('done', 'cancelled') AND julianday(created_at) < julianday(?)
      `).get(periodEndExclusiveIso) as { count: number }).count;
      const activeRoutines = sqlite.prepare(`
        SELECT id, cadence_type AS cadenceType FROM routines
        WHERE is_active = 1 AND is_archived = 0
      `).all() as Array<{ id: string; cadenceType: string }>;
      const periodCompletions = sqlite.prepare(`
        SELECT routine_id AS routineId, date FROM routine_completions
        WHERE date >= ? AND date <= ?
      `).all(periodStart, periodEnd) as Array<{ routineId: string; date: string }>;
      const focusItems = sqlite.prepare(`
        SELECT task_id AS taskId, date, slot FROM focus_items
        WHERE scope = 'today' AND date >= ? AND date <= ?
      `).all(periodStart, periodEnd) as Array<{ taskId: string; date: string; slot: number }>;
      const staleTasks = sqlite.prepare(`
        SELECT id, title, updated_at AS updatedAt, status, priority, source_id AS sourceId,
               connector_type AS connectorType, connector_instance_id AS connectorInstanceId
        FROM tasks
        WHERE status NOT IN ('done', 'cancelled') AND julianday(updated_at) < julianday(?)
        LIMIT ?
      `).all(staleThresholdExclusiveIso, staleLimit) as Awaited<ReturnType<
        AIResetsPersistence['aggregateStats']
      >>['staleTasks'];
      const energyData = sqlite.prepare(`
        SELECT date, level FROM energy_checkins WHERE date >= ? AND date <= ?
      `).all(periodStart, periodEnd) as Array<{ date: string; level: string }>;
      const focusTaskIds = [...new Set(focusItems.map((item) => item.taskId))];
      const focusTaskStatuses = focusTaskIds.length > 0
        ? sqlite.prepare(`
            SELECT id, title, status FROM tasks WHERE id IN (${placeholders(focusTaskIds)})
          `).all(...focusTaskIds) as Array<{ id: string; title: string; status: string }>
        : [];
      return {
        completedTasks,
        createdTaskCount,
        carriedForwardCount,
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

function createSqliteAIWorkflowBackend(
  sqlite: Database.Database,
): AIWorkflowBackend {
  return {
    context: {
      async listTaskContext() {
        return sqlite.prepare(`
          SELECT id, title, status, priority, due_date AS dueDate FROM tasks
        `).all() as Awaited<ReturnType<AIWorkflowPersistence['context']['listTaskContext']>>;
      },
      async getTriageContext(now) {
        const rows = sqlite.prepare(`
          SELECT level, category FROM notifications
          WHERE ${NOTIFICATION_NEEDS_ATTENTION}
        `).all(now) as Array<{ level: string; category: string | null }>;
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
      async loadDigestSnapshot(input) {
        return loadDigestSnapshot(sqlite, input);
      },
    },
    async getTaskBreakdownContext(taskId) {
      return getTaskBreakdownContext(sqlite, taskId);
    },

    notifications: {
      async listForClassification(now, limit) {
        const rows = sqlite.prepare(`
          SELECT id, title, level, category, is_actionable AS isActionable,
                 connector_type AS connectorType, received_at AS receivedAt
          FROM notifications
          WHERE ${NOTIFICATION_NEEDS_ATTENTION}
          ORDER BY received_at DESC, id ASC
          LIMIT ?
        `).all(now, limit) as Array<Omit<
          Awaited<ReturnType<
            AIWorkflowPersistence['notifications']['listForClassification']
          >>[number],
          'isActionable'
        > & { isActionable: number }>;
        return rows.map((row) => ({ ...row, isActionable: Boolean(row.isActionable) }));
      },
    },

    recommendations: {
      async listAssignmentProjects() {
        return sqlite.prepare(`
          SELECT id, name, description FROM hub_projects
        `).all() as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listAssignmentProjects']
        >>;
      },
      async listAssignmentTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, connector_type AS connectorType, source_list_name AS sourceListName
          FROM tasks WHERE status = 'todo'
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listAssignmentTasks']
        >>;
      },
      async listTagInferenceTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, connector_type AS connectorType, source_list_name AS sourceListName
          FROM tasks WHERE status = 'todo'
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listTagInferenceTasks']
        >>;
      },
      async listTaggedTaskIds() {
        const rows = sqlite.prepare('SELECT task_id AS taskId FROM task_tags').all() as Array<{
          taskId: string;
        }>;
        return rows.map((row) => row.taskId);
      },
      async listAvailableTagNames() {
        const rows = sqlite.prepare('SELECT name FROM tags').all() as Array<{ name: string }>;
        return rows.map((row) => row.name);
      },
      async listSmartPriorityTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, priority, due_date AS dueDate,
                 connector_type AS connectorType, source_list_name AS sourceListName,
                 updated_at AS updatedAt
          FROM tasks
          WHERE status = 'todo'
          ORDER BY updated_at DESC, id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listSmartPriorityTasks']
        >>;
      },
      async listMicroStatusTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, status, micro_status AS microStatus, priority,
                 created_at AS createdAt, updated_at AS updatedAt, due_date AS dueDate,
                 connector_type AS connectorType, assignee
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled')
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listMicroStatusTasks']
        >>;
      },
      async listEnergySuggestionTasksByIds(taskIds, limit) {
        if (taskIds.length === 0) return [];
        const uniqueIds = [...new Set(taskIds)].slice(0, Math.max(0, limit));
        if (uniqueIds.length === 0) return [];
        const rows = sqlite.prepare(`
          SELECT id, title, description, priority, connector_type AS connectorType
          FROM tasks
          WHERE id IN (${placeholders(uniqueIds)})
          ORDER BY id ASC
        `).all(...uniqueIds) as Awaited<ReturnType<
          AIWorkflowBackend['recommendations']['listEnergySuggestionTasksByIds']
        >>;
        const byId = new Map(rows.map((row) => [row.id, row]));
        return uniqueIds.flatMap((id) => {
          const row = byId.get(id);
          return row ? [row] : [];
        });
      },
      async listOpenTopLevelEnergySuggestionTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, description, priority, connector_type AS connectorType
          FROM tasks
          WHERE status NOT IN ('done', 'cancelled') AND depth = 0
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowBackend['recommendations']['listOpenTopLevelEnergySuggestionTasks']
        >>;
      },
      async listEnergyLevels(taskIds) {
        if (taskIds.length === 0) return [];
        const rows = sqlite.prepare(`
          SELECT tt.task_id AS taskId, t.slug AS slug
          FROM task_tags tt
          INNER JOIN tags t ON t.id = tt.tag_id
          WHERE tt.task_id IN (${placeholders(taskIds)})
            AND t.slug IN (${placeholders(ENERGY_SLUGS)})
          ORDER BY tt.task_id COLLATE BINARY,
            CASE t.slug
              WHEN 'energy-high' THEN 0
              WHEN 'energy-medium' THEN 1
              ELSE 2
            END,
            t.id COLLATE BINARY
        `).all(...taskIds, ...ENERGY_SLUGS) as Array<{ taskId: string; slug: string }>;
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
      async listWhatsNextTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, priority, due_date AS dueDate,
                 connector_type AS connectorType, source_list_name AS sourceListName
          FROM tasks WHERE status = 'todo'
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listWhatsNextTasks']
        >>;
      },
      async listWhatsNextNotifications(now, limit) {
        return sqlite.prepare(`
          SELECT connector_type AS connectorType
          FROM notifications
          WHERE ${NOTIFICATION_NEEDS_ATTENTION}
          ORDER BY received_at DESC, id ASC
          LIMIT ?
        `).all(now, limit) as Awaited<ReturnType<
          AIWorkflowPersistence['recommendations']['listWhatsNextNotifications']
        >>;
      },
      async applyEnergyTagSuggestions(input) {
        return applyEnergyTags(sqlite, input);
      },
    },

    planning: {
      async listPlanDayItems(date) {
        return sqlite.prepare(`
          SELECT t.id, t.title, t.priority, t.due_date AS dueDate,
                 t.connector_type AS connectorType
          FROM my_day_items m
          INNER JOIN tasks t ON m.task_id = t.id
          WHERE m.date = ?
        `).all(date) as Awaited<ReturnType<
          AIWorkflowBackend['planning']['listPlanDayItems']
        >>;
      },
      async listPlanDaySchedules(date) {
        return sqlite.prepare(`
          SELECT task_id AS taskId, scheduled_time AS scheduledTime,
                 estimated_duration AS estimatedDuration
          FROM task_schedules
          WHERE scheduled_date = ?
        `).all(date) as Awaited<ReturnType<
          AIWorkflowBackend['planning']['listPlanDaySchedules']
        >>;
      },
      async listPlanDayOpenTasks(limit) {
        return sqlite.prepare(`
          SELECT id, title, priority, due_date AS dueDate,
                 connector_type AS connectorType
          FROM tasks WHERE status = 'todo'
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowBackend['planning']['listPlanDayOpenTasks']
        >>;
      },
      async listFocusTaskIds(scope, date) {
        const rows = sqlite.prepare(`
          SELECT task_id AS taskId FROM focus_items WHERE scope = ? AND date = ?
        `).all(scope, date) as Array<{ taskId: string }>;
        return rows.map((row) => row.taskId);
      },
      async listFocusCandidates(limit) {
        return sqlite.prepare(`
          SELECT id, title, status, priority, due_date AS dueDate,
                 connector_type AS connectorType, source_list_name AS sourceListName,
                 created_at AS createdAt, updated_at AS updatedAt, depth
          FROM tasks
          WHERE status <> 'done' AND status <> 'cancelled' AND depth = 0
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowBackend['planning']['listFocusCandidates']
        >>;
      },
      async listMyDayTaskIds(date) {
        const rows = sqlite.prepare(`
          SELECT task_id AS taskId FROM my_day_items WHERE date = ?
        `).all(date) as Array<{ taskId: string }>;
        return rows.map((row) => row.taskId);
      },
      async listProjectTaskIds(projectId) {
        const rows = sqlite.prepare(`
          SELECT task_id AS taskId FROM task_projects WHERE project_id = ?
        `).all(projectId) as Array<{ taskId: string }>;
        return rows.map((row) => row.taskId);
      },
      async listOpenPhaseTaskIds() {
        const rows = sqlite.prepare(`
          SELECT id FROM tasks WHERE status NOT IN ('done', 'cancelled')
        `).all() as Array<{ id: string }>;
        return rows.map((row) => row.id);
      },
      async listPhasePlanningTasks(taskIds) {
        if (taskIds.length === 0) return [];
        const ids = [...taskIds];
        const taskRows = sqlite.prepare(`
          SELECT id, title, description, status, priority, due_date AS dueDate,
                 connector_type AS connectorType, source_list_name AS sourceListName,
                 updated_at AS updatedAt
          FROM tasks WHERE id IN (${placeholders(ids)})
        `).all(...ids) as Array<Omit<PhasePlanningContextTask, 'tags' | 'projectNames'>>;
        const tagRows = sqlite.prepare(`
          SELECT tt.task_id AS taskId, t.name AS tagName
          FROM task_tags tt
          INNER JOIN tags t ON tt.tag_id = t.id
          WHERE tt.task_id IN (${placeholders(ids)})
        `).all(...ids) as Array<{ taskId: string; tagName: string }>;
        const projectRows = sqlite.prepare(`
          SELECT tp.task_id AS taskId, p.name AS projectName
          FROM task_projects tp
          INNER JOIN hub_projects p ON tp.project_id = p.id
          WHERE tp.task_id IN (${placeholders(ids)})
        `).all(...ids) as Array<{ taskId: string; projectName: string }>;
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
        return (sqlite.prepare(`
          SELECT id, title, description, connector_type AS connectorType
          FROM tasks WHERE id = ? LIMIT 1
        `).get(taskId) as Awaited<ReturnType<
          AIWorkflowBackend['goals']['getTask']
        >> | undefined) ?? null;
      },
      async listTaskTags(taskId) {
        return sqlite.prepare(`
          SELECT t.name, t.slug
          FROM task_tags tt
          INNER JOIN tags t ON tt.tag_id = t.id
          WHERE tt.task_id = ?
        `).all(taskId) as Awaited<ReturnType<
          AIWorkflowBackend['goals']['listTaskTags']
        >>;
      },
      async listLinkedProjects(taskId) {
        return sqlite.prepare(`
          SELECT p.name, p.description, p.category
          FROM task_projects tp
          INNER JOIN hub_projects p ON tp.project_id = p.id
          WHERE tp.task_id = ?
        `).all(taskId) as Awaited<ReturnType<
          AIWorkflowBackend['goals']['listLinkedProjects']
        >>;
      },
      async listExistingProjects(limit) {
        return sqlite.prepare(`
          SELECT name, category FROM hub_projects
          ORDER BY id ASC
          LIMIT ?
        `).all(limit) as Awaited<ReturnType<
          AIWorkflowBackend['goals']['listExistingProjects']
        >>;
      },
    },

    async listTaskConnectorTypes(taskIds) {
      if (taskIds.length === 0) return [];
      const rows = sqlite.prepare(`
        SELECT connector_type AS connectorType
        FROM tasks
        WHERE id IN (${placeholders(taskIds)})
      `).all(...taskIds) as Array<{ connectorType: string }>;
      return rows.map((row) => row.connectorType);
    },
  };
}

export function createSqliteAIWorkflowPersistence(
  sqlite: Database.Database,
): AIWorkflowPersistence {
  const backend = createSqliteAIWorkflowBackend(sqlite);
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
    dayPlan: createSqliteDayPlanPersistence(sqlite),
    taskTools: createSqliteTaskToolsPersistence(sqlite),
    dispatch: createSqliteDispatchPersistence(sqlite),
    maintenance: createSqliteMaintenancePersistence(sqlite),
    goalsBoard: createSqliteGoalsBoardPersistence(sqlite),
    ideation: createSqliteIdeationPersistence(sqlite),
    resets: createSqliteResetsPersistence(sqlite),
  };
}

export function createSqliteAIDailyPlanningExtensions(
  sqlite: Database.Database,
): Pick<DailyPlanningPersistence, 'dayPlan' | 'energySuggestions'> & {
  getFocusSuggestionContext: NonNullable<
    DailyPlanningPersistence['focus']['getSuggestionContext']
  >;
} {
  const backend = createSqliteAIWorkflowBackend(sqlite);
  return {
    dayPlan: {
      async getContext({ date, openTaskLimit }) {
        return loadDayPlanContext(sqlite, { date, openTaskLimit });
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
      return loadFocusSuggestionContext(
        sqlite,
        { scope, date, effectiveDate, taskLimit },
      );
    },
  };
}

export function createSqliteAIProjectOrganizationExtensions(
  sqlite: Database.Database,
): Pick<
  ProjectAdministrationPersistence,
  'listPhasePlanningTaskIds' | 'listPhasePlanningTasks' | 'getGoalDevelopmentContext'
> {
  const backend = createSqliteAIWorkflowBackend(sqlite);
  return {
    listPhasePlanningTaskIds: (projectId) => (
      projectId
        ? backend.planning.listProjectTaskIds(projectId)
        : backend.planning.listOpenPhaseTaskIds()
    ),
    listPhasePlanningTasks: backend.planning.listPhasePlanningTasks,
    async getGoalDevelopmentContext(taskId, existingProjectLimit): Promise<
      GoalDevelopmentContext | null
    > {
      return loadGoalDevelopmentContext(sqlite, taskId, existingProjectLimit);
    },
  };
}
