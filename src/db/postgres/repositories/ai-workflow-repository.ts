import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
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
  AND (snoozed_until IS NULL OR snoozed_until <= $1)
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
