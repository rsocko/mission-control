import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
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

interface AIWorkflowBackend extends AIWorkflowPersistence {
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
