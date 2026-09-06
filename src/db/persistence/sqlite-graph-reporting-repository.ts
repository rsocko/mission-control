import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  and,
  asc,
  count,
  desc,
  eq,
  inArray,
  notInArray,
  or,
  sql,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  hubProjects,
  projectPhaseItems,
  projectPhases,
  projectTags,
  tags,
  taskDependencies,
  taskHistoryEvents,
  taskProjects,
  tasks,
  taskTags,
} from '@/db/schema';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import {
  hasDuplicateDependency,
  wouldCreateBlockingCycle,
} from '@/lib/graph/project-subgraph';
import { compileCanonicalTaskFilter } from './sqlite-task-filter';
import type {
  BurnHistoryEvent,
  GraphDependencyRow,
  GraphDependencyTaskRow,
  GraphReportingPersistence,
  GraphTaskRow,
  NeighborAggregateRef,
} from './graph-reporting';

type SqliteDb = BetterSQLite3Database<typeof schema>;

const graphTaskColumns = {
  id: tasks.id,
  title: tasks.title,
  description: tasks.description,
  status: tasks.status,
  microStatus: tasks.microStatus,
  priority: tasks.priority,
  connectorType: tasks.connectorType,
  connectorInstanceId: tasks.connectorInstanceId,
  sourceListId: tasks.sourceListId,
  sourceListName: tasks.sourceListName,
  effort: tasks.effort,
};

const graphProjectColumns = {
  id: hubProjects.id,
  name: hubProjects.name,
  description: hubProjects.description,
  status: hubProjects.status,
  color: hubProjects.color,
};

const graphPhaseColumns = {
  id: projectPhases.id,
  name: projectPhases.name,
  description: projectPhases.description,
  status: projectPhases.status,
  color: projectPhases.color,
  startAfterPhaseId: projectPhases.startAfterPhaseId,
};

function visibleTaskCondition() {
  return and(
    sql`${tasks.connectorInstanceId} NOT IN (
      SELECT ${connectorConfigs.id} FROM ${connectorConfigs}
      WHERE ${connectorConfigs.deletedAt} IS NOT NULL
    )`,
    notInArray(tasks.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
  );
}

function aggregateTaskCondition(ref: NeighborAggregateRef) {
  if (ref.kind !== 'property') return undefined;
  if (ref.dimension === 'priority') return eq(tasks.priority, ref.value);
  if (ref.dimension === 'status') return eq(tasks.status, ref.value);
  if (ref.dimension === 'source') return eq(tasks.connectorType, ref.value);
  if (ref.dimension === 'effort') return eq(tasks.effort, Number(ref.value));
  const separator = ref.value.indexOf(':');
  return separator < 1
    ? sql`0 = 1`
    : and(
        eq(tasks.connectorInstanceId, ref.value.slice(0, separator)),
        eq(tasks.sourceListId, ref.value.slice(separator + 1)),
      );
}

function parseJsonRecord(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function baselineHasScope(
  value: string | null,
  scope: 'project' | 'phase',
  scopeId: string,
): boolean {
  const parsed = parseJsonRecord(value);
  const memberships = parsed?.[scope === 'project' ? 'projectIds' : 'phaseIds'];
  return Array.isArray(memberships) && memberships.includes(scopeId);
}

function normalizeHistoryEvent(row: typeof taskHistoryEvents.$inferSelect): BurnHistoryEvent {
  return {
    ...row,
    provenanceRef: parseJsonRecord(row.provenanceRef),
    metadata: parseJsonRecord(row.metadata),
  };
}

export function createSqliteGraphReportingRepository(
  sqlite: Database.Database,
  db: SqliteDb,
): GraphReportingPersistence {
  return {
    universe: {
      async read(input) {
        const compiled = compileCanonicalTaskFilter(input.spec, input.filterInputs);
        const where = and(
          compiled.taskWhere,
          input.seedTaskIds
            ? input.seedTaskIds.length
              ? inArray(tasks.id, [...input.seedTaskIds])
              : sql`0 = 1`
            : undefined,
        );
        const [selectedTasks, totalRows] = await Promise.all([
          db.select({
            id: tasks.id,
            title: tasks.title,
            priority: tasks.priority,
            status: tasks.status,
            connectorType: tasks.connectorType,
            connectorInstanceId: tasks.connectorInstanceId,
            sourceListId: tasks.sourceListId,
            sourceListName: tasks.sourceListName,
            effort: tasks.effort,
          }).from(tasks)
            .where(where)
            .orderBy(desc(tasks.updatedAt), asc(tasks.id))
            .limit(input.maxNodes + 1),
          db.select({ value: count() }).from(tasks).where(where),
        ]);
        const boundedTasks = selectedTasks.slice(0, input.maxNodes);
        const taskIds = boundedTasks.map((task) => task.id);
        const [tagRows, projectRows] = await Promise.all([
          input.includeTags && taskIds.length
            ? db.select({
                taskId: taskTags.taskId,
                id: tags.id,
                name: tags.name,
                color: tags.color,
              }).from(taskTags)
                .innerJoin(tags, eq(taskTags.tagId, tags.id))
                .where(inArray(taskTags.taskId, taskIds))
                .orderBy(asc(taskTags.taskId), asc(tags.id))
            : [],
          input.includeProjects && taskIds.length
            ? db.select({
                taskId: taskProjects.taskId,
                id: hubProjects.id,
                name: hubProjects.name,
                color: hubProjects.color,
                status: hubProjects.status,
              }).from(taskProjects)
                .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
                .where(inArray(taskProjects.taskId, taskIds))
                .orderBy(asc(taskProjects.taskId), asc(hubProjects.id))
            : [],
        ]);
        return {
          tasks: boundedTasks,
          tags: tagRows,
          projects: projectRows,
          filteredTaskCount: Number(totalRows[0]?.value ?? 0),
          hasMoreTasks: selectedTasks.length > input.maxNodes,
        };
      },
      async listEligibleTaskIds(input) {
        if (!input.taskIds.length) return [];
        const compiled = compileCanonicalTaskFilter(input.spec, input.filterInputs);
        const rows = await db.select({ id: tasks.id }).from(tasks)
          .where(and(compiled.taskWhere, inArray(tasks.id, [...input.taskIds])))
          .orderBy(asc(tasks.id));
        return rows.map(({ id }) => id);
      },
    },
    neighbors: {
      async readAggregate(input) {
        let center = null;
        let query;
        if (input.ref.kind === 'tag') {
          const [row] = await db.select({
            id: tags.id,
            name: tags.name,
            color: tags.color,
          }).from(tags).where(eq(tags.id, input.ref.id)).limit(1);
          center = row ? { kind: 'tag' as const, row } : null;
          query = db.select(graphTaskColumns).from(taskTags)
            .innerJoin(tasks, eq(taskTags.taskId, tasks.id))
            .where(and(
              eq(taskTags.tagId, input.ref.id),
              visibleTaskCondition(),
              input.eligibleTaskIds
                ? input.eligibleTaskIds.length
                  ? inArray(tasks.id, [...input.eligibleTaskIds])
                  : sql`0 = 1`
                : undefined,
            ));
        } else if (input.ref.kind === 'project') {
          const [row] = await db.select(graphProjectColumns).from(hubProjects)
            .where(eq(hubProjects.id, input.ref.id)).limit(1);
          center = row ? { kind: 'project' as const, row } : null;
          query = db.select(graphTaskColumns).from(taskProjects)
            .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
            .where(and(
              eq(taskProjects.projectId, input.ref.id),
              visibleTaskCondition(),
              input.eligibleTaskIds
                ? input.eligibleTaskIds.length
                  ? inArray(tasks.id, [...input.eligibleTaskIds])
                  : sql`0 = 1`
                : undefined,
            ));
        } else {
          center = { kind: 'property' as const };
          query = db.select(graphTaskColumns).from(tasks).where(and(
            aggregateTaskCondition(input.ref),
            visibleTaskCondition(),
            input.eligibleTaskIds
              ? input.eligibleTaskIds.length
                ? inArray(tasks.id, [...input.eligibleTaskIds])
                : sql`0 = 1`
              : undefined,
          ));
        }
        const rows = await query.orderBy(asc(tasks.id)).limit(input.limit);
        return { center, tasks: rows };
      },
      async readTask(input) {
        const [center] = await db.select(graphTaskColumns).from(tasks).where(and(
          eq(tasks.id, input.taskId),
          visibleTaskCondition(),
        )).limit(1);
        if (!center) {
          return {
            center: null,
            dependencies: [],
            dependencyTasks: [],
            projects: [],
            phases: [],
            tags: [],
          };
        }
        let dependencies: GraphDependencyRow[] = [];
        let dependencyTasks: GraphTaskRow[] = [];
        if (input.includeExplicit) {
          const neighbor = alias(tasks, 'neighbor_tasks');
          const rows = await db.select({
            dependency: taskDependencies,
            neighbor: {
              id: neighbor.id,
              title: neighbor.title,
              description: neighbor.description,
              status: neighbor.status,
              microStatus: neighbor.microStatus,
              priority: neighbor.priority,
              connectorType: neighbor.connectorType,
              connectorInstanceId: neighbor.connectorInstanceId,
              sourceListId: neighbor.sourceListId,
              sourceListName: neighbor.sourceListName,
              effort: neighbor.effort,
            },
          }).from(taskDependencies).innerJoin(neighbor, or(
            and(
              eq(taskDependencies.taskId, input.taskId),
              eq(neighbor.id, taskDependencies.dependsOnTaskId),
            ),
            and(
              eq(taskDependencies.dependsOnTaskId, input.taskId),
              eq(neighbor.id, taskDependencies.taskId),
            ),
          )).where(and(
            sql`${neighbor.connectorInstanceId} NOT IN (
              SELECT ${connectorConfigs.id} FROM ${connectorConfigs}
              WHERE ${connectorConfigs.deletedAt} IS NOT NULL
            )`,
            notInArray(neighbor.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
            input.eligibleTaskIds
              ? input.eligibleTaskIds.length
                ? inArray(neighbor.id, [...input.eligibleTaskIds])
                : sql`0 = 1`
              : undefined,
          )).orderBy(
            asc(taskDependencies.createdAt),
            asc(taskDependencies.id),
          ).limit(input.dependencyLimit);
          dependencies = rows.map(({ dependency }) => dependency);
          dependencyTasks = [...new Map(rows.map(({ neighbor: row }) => [row.id, row])).values()]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        }
        const [projects, phases, taskTagRows] = input.includeDerived
          ? await Promise.all([
              db.select(graphProjectColumns).from(taskProjects)
                .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
                .where(eq(taskProjects.taskId, input.taskId))
                .orderBy(asc(hubProjects.id)),
              db.select(graphPhaseColumns).from(projectPhaseItems)
                .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
                .where(and(
                  eq(projectPhaseItems.taskId, input.taskId),
                  eq(projectPhaseItems.isProposed, false),
                )).orderBy(asc(projectPhases.id)),
              db.select({
                id: tags.id,
                name: tags.name,
                color: tags.color,
              }).from(taskTags)
                .innerJoin(tags, eq(taskTags.tagId, tags.id))
                .where(eq(taskTags.taskId, input.taskId))
                .orderBy(asc(tags.id)),
            ])
          : [[], [], []];
        return { center, dependencies, dependencyTasks, projects, phases, tags: taskTagRows };
      },
      async listTasks(taskIds) {
        return taskIds.length
          ? db.select(graphTaskColumns).from(tasks)
              .where(and(inArray(tasks.id, [...taskIds]), visibleTaskCondition()))
              .orderBy(asc(tasks.id))
          : [];
      },
      async listDeletedConnectorIds() {
        const rows = await db.select({ id: connectorConfigs.id }).from(connectorConfigs)
          .where(sql`${connectorConfigs.deletedAt} IS NOT NULL`)
          .orderBy(asc(connectorConfigs.id));
        return rows.map(({ id }) => id);
      },
      async listRelationshipTasks(taskIds) {
        if (!taskIds.length) return [];
        const ids = [...taskIds];
        const [taskRows, membershipRows] = await Promise.all([
          db.select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            connectorType: tasks.connectorType,
            sourceId: tasks.sourceId,
            metadata: tasks.metadata,
          }).from(tasks).where(inArray(tasks.id, ids)).orderBy(asc(tasks.id)),
          db.select({
            taskId: taskProjects.taskId,
            projectId: taskProjects.projectId,
            projectName: hubProjects.name,
          }).from(taskProjects)
            .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
            .where(inArray(taskProjects.taskId, ids))
            .orderBy(asc(taskProjects.taskId), asc(taskProjects.projectId)),
        ]);
        const membershipsByTask = new Map<string, Array<{ id: string; name: string }>>();
        for (const membership of membershipRows) {
          const entries = membershipsByTask.get(membership.taskId) ?? [];
          entries.push({ id: membership.projectId, name: membership.projectName });
          membershipsByTask.set(membership.taskId, entries);
        }
        return taskRows.map((task) => {
          const memberships = membershipsByTask.get(task.id) ?? [];
          return {
            id: task.id,
            title: task.title,
            status: task.status,
            connectorType: task.connectorType,
            sourceId: task.sourceId,
            metadata: parseJsonRecord(task.metadata) ?? {},
            projectIds: memberships.map((project) => project.id),
            projectNames: memberships.map((project) => project.name),
          };
        });
      },
    },
    projects: {
      async read(projectId) {
        const [project] = await db.select(graphProjectColumns).from(hubProjects)
          .where(eq(hubProjects.id, projectId)).limit(1);
        if (!project) {
          return { project: null, phases: [], tasks: [], phaseItems: [], dependencies: [] };
        }
        const phases = await db.select(graphPhaseColumns).from(projectPhases)
          .where(eq(projectPhases.projectId, projectId))
          .orderBy(asc(projectPhases.sortOrder), asc(projectPhases.id));
        const projectTasks = await db.select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          microStatus: tasks.microStatus,
        }).from(taskProjects)
          .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
          .where(eq(taskProjects.projectId, projectId))
          .orderBy(asc(tasks.id));
        const phaseIds = phases.map(({ id }) => id);
        const phaseItems = phaseIds.length
          ? await db.select({
              phaseId: projectPhaseItems.phaseId,
              taskId: projectPhaseItems.taskId,
            }).from(projectPhaseItems)
              .where(inArray(projectPhaseItems.phaseId, phaseIds))
              .orderBy(
                asc(projectPhaseItems.phaseId),
                asc(projectPhaseItems.sortOrder),
                asc(projectPhaseItems.createdAt),
                asc(projectPhaseItems.id),
              )
          : [];
        const taskIds = projectTasks.map(({ id }) => id);
        const dependencies = taskIds.length
          ? await db.select().from(taskDependencies).where(and(
              inArray(taskDependencies.taskId, taskIds),
              inArray(taskDependencies.dependsOnTaskId, taskIds),
            )).orderBy(asc(taskDependencies.createdAt), asc(taskDependencies.id))
          : [];
        return { project, phases, tasks: projectTasks, phaseItems, dependencies };
      },
      async createDependency(input) {
        const execute = sqlite.transaction(() => {
          if (input.projectId) {
            const memberships = sqlite.prepare(
              `SELECT task_id AS taskId FROM task_projects
               WHERE project_id = ? AND task_id IN (?, ?)`,
            ).all(input.projectId, input.sourceTaskId, input.targetTaskId) as Array<{ taskId: string }>;
            if (new Set(memberships.map(({ taskId }) => taskId)).size !== 2) {
              return { kind: 'missing-project-membership' as const };
            }
          }
          const dependencyTasks = sqlite.prepare(
            `SELECT id, source_id AS sourceId,
                    connector_instance_id AS connectorInstanceId,
                    is_checklist_item AS isChecklistItem, metadata
             FROM tasks WHERE id IN (?, ?)`,
          ).all(input.sourceTaskId, input.targetTaskId) as GraphDependencyTaskRow[];
          const taskById = new Map(dependencyTasks.map((task) => [
            task.id,
            { ...task, isChecklistItem: Boolean(task.isChecklistItem), metadata: parseJsonRecord(task.metadata) ?? {} },
          ]));
          const blocker = taskById.get(input.sourceTaskId);
          const blocked = taskById.get(input.targetTaskId);
          if (!blocker || !blocked) return { kind: 'missing-task' as const };
          const allTaskIds = new Set(
            (sqlite.prepare('SELECT id FROM tasks').all() as Array<{ id: string }>).map(({ id }) => id),
          );
          const existing = (sqlite.prepare(
            'SELECT task_id AS taskId, depends_on_task_id AS dependsOnTaskId, type FROM task_dependencies',
          ).all() as Array<{ taskId: string; dependsOnTaskId: string; type: 'blocks' | 'related' }>)
            .filter((dependency) =>
              allTaskIds.has(dependency.taskId) && allTaskIds.has(dependency.dependsOnTaskId));
          if (hasDuplicateDependency(
            existing,
            input.sourceTaskId,
            input.targetTaskId,
            input.type,
          )) return { kind: 'duplicate' as const };
          if (
            input.type === 'blocks'
            && wouldCreateBlockingCycle(existing, input.sourceTaskId, input.targetTaskId)
          ) return { kind: 'cycle' as const };
          const dependency: GraphDependencyRow = {
            id: input.id,
            taskId: input.targetTaskId,
            dependsOnTaskId: input.sourceTaskId,
            type: input.type,
            connectorInstanceId: null,
            syncStatus: 'local',
            syncAction: null,
            syncError: null,
            lastSyncedAt: null,
            createdAt: input.createdAt,
          };
          sqlite.prepare(
            `INSERT INTO task_dependencies (
              id, task_id, depends_on_task_id, type, connector_instance_id,
              sync_status, sync_action, sync_error, last_synced_at, created_at
            ) VALUES (
              @id, @taskId, @dependsOnTaskId, @type, @connectorInstanceId,
              @syncStatus, @syncAction, @syncError, @lastSyncedAt, @createdAt
            )`,
          ).run(dependency);
          return { kind: 'created' as const, dependency, blocker, blocked };
        });
        try {
          return execute.immediate();
        } catch (error) {
          if (
            typeof error === 'object'
            && error !== null
            && 'code' in error
            && error.code === 'SQLITE_CONSTRAINT_UNIQUE'
          ) return { kind: 'duplicate' as const };
          throw error;
        }
      },
      async getDependencyDeleteContext(input) {
        const dependencyId = input.dependencyId.startsWith('dependency:')
          ? input.dependencyId.slice('dependency:'.length)
          : input.dependencyId;
        const dependency = sqlite.prepare(
          `SELECT id, task_id AS taskId, depends_on_task_id AS dependsOnTaskId,
                  type, connector_instance_id AS connectorInstanceId,
                  sync_status AS syncStatus, sync_action AS syncAction,
                  sync_error AS syncError, last_synced_at AS lastSyncedAt,
                  created_at AS createdAt
           FROM task_dependencies WHERE id = ?`,
        ).get(dependencyId) as GraphDependencyRow | undefined;
        if (!dependency) return { kind: 'missing' };
        if (
          input.taskId
          && dependency.taskId !== input.taskId
          && dependency.dependsOnTaskId !== input.taskId
        ) return { kind: 'wrong-task' };
        if (input.projectId) {
          const memberships = sqlite.prepare(
            `SELECT task_id AS taskId FROM task_projects
             WHERE project_id = ? AND task_id IN (?, ?)`,
          ).all(input.projectId, dependency.taskId, dependency.dependsOnTaskId) as Array<{ taskId: string }>;
          if (new Set(memberships.map(({ taskId }) => taskId)).size !== 2) {
            return { kind: 'missing-project-membership' };
          }
        }
        const rows = sqlite.prepare(
          `SELECT id, source_id AS sourceId,
                  connector_instance_id AS connectorInstanceId,
                  is_checklist_item AS isChecklistItem, metadata
           FROM tasks WHERE id IN (?, ?)`,
        ).all(dependency.taskId, dependency.dependsOnTaskId) as GraphDependencyTaskRow[];
        const taskById = new Map(rows.map((task) => [
          task.id,
          { ...task, isChecklistItem: Boolean(task.isChecklistItem), metadata: parseJsonRecord(task.metadata) ?? {} },
        ]));
        const blocker = taskById.get(dependency.dependsOnTaskId);
        const blocked = taskById.get(dependency.taskId);
        return blocker && blocked
          ? { kind: 'found', dependency, blocker, blocked }
          : { kind: 'missing-task' };
      },
    },
    overview: {
      async read() {
        const projects = await db.select().from(hubProjects)
          .where(eq(hubProjects.hidden, false))
          .orderBy(asc(hubProjects.name), asc(hubProjects.id));
        if (!projects.length) return { projects: [], memberships: [], tasks: [], tags: [] };
        const projectIds = projects.map(({ id }) => id);
        const memberships = await db.select({
          projectId: taskProjects.projectId,
          taskId: taskProjects.taskId,
        }).from(taskProjects).where(inArray(taskProjects.projectId, projectIds))
          .orderBy(asc(taskProjects.projectId), asc(taskProjects.taskId));
        const taskIds = [...new Set(memberships.map(({ taskId }) => taskId))];
        const taskRows = taskIds.length
          ? await db.select({
              id: tasks.id,
              title: tasks.title,
              status: tasks.status,
              parentId: tasks.parentId,
              dueDate: tasks.dueDate,
              updatedAt: tasks.updatedAt,
              completedAt: tasks.completedAt,
            }).from(tasks).where(inArray(tasks.id, taskIds)).orderBy(asc(tasks.id))
          : [];
        const tagRows = await db.select({
          projectId: projectTags.projectId,
          id: tags.id,
          name: tags.name,
          slug: tags.slug,
          type: tags.type,
          source: tags.source,
          color: tags.color,
          confirmed: tags.confirmed,
          createdAt: tags.createdAt,
        }).from(projectTags).innerJoin(tags, eq(projectTags.tagId, tags.id))
          .where(inArray(projectTags.projectId, projectIds))
          .orderBy(asc(projectTags.projectId), asc(tags.id));
        return {
          projects: projects.map((project) => ({
            ...project,
            sourceBindings: Array.isArray(project.sourceBindings) ? project.sourceBindings : [],
            autoIncludeRules: Array.isArray(project.autoIncludeRules) ? project.autoIncludeRules : [],
            kanbanColumns: Array.isArray(project.kanbanColumns) ? project.kanbanColumns : [],
            defaultFilters: parseJsonRecord(project.defaultFilters),
            metadata: parseJsonRecord(project.metadata) ?? {},
          })),
          memberships,
          tasks: taskRows,
          tags: tagRows,
        };
      },
      async listProjectTaskStatuses(projectId) {
        return db.select({
          status: tasks.status,
          updatedAt: tasks.updatedAt,
          parentId: tasks.parentId,
        }).from(taskProjects)
          .innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
          .where(eq(taskProjects.projectId, projectId))
          .orderBy(asc(tasks.id));
      },
    },
    burn: {
      async read(input) {
        const [project] = await db.select({
          id: hubProjects.id,
          name: hubProjects.name,
          startedAt: hubProjects.startedAt,
          targetDate: hubProjects.targetDate,
        }).from(hubProjects).where(eq(hubProjects.id, input.projectId)).limit(1);
        if (!project) return { scope: null, candidateEvents: [], tasks: [] };
        let scope: 'project' | 'phase' = 'project';
        let scopeId = project.id;
        let scopeName = project.name;
        let scheduleStart = project.startedAt;
        let scheduleEnd = project.targetDate;
        if (input.phaseId) {
          const [phase] = await db.select({
            id: projectPhases.id,
            name: projectPhases.name,
            targetStart: projectPhases.targetStart,
            targetEnd: projectPhases.targetEnd,
          }).from(projectPhases).where(and(
            eq(projectPhases.id, input.phaseId),
            eq(projectPhases.projectId, input.projectId),
          )).limit(1);
          if (!phase) return { scope: null, candidateEvents: [], tasks: [] };
          scope = 'phase';
          scopeId = phase.id;
          scopeName = phase.name;
          scheduleStart = phase.targetStart;
          scheduleEnd = phase.targetEnd;
        }
        const membershipColumn = scope === 'project'
          ? taskHistoryEvents.projectId
          : taskHistoryEvents.phaseId;
        const path = scope === 'project' ? '$.projectIds' : '$.phaseIds';
        const candidateRows = await db.select().from(taskHistoryEvents).where(or(
          eq(membershipColumn, scopeId),
          and(
            eq(taskHistoryEvents.eventType, 'baseline'),
            sql`EXISTS (
              SELECT 1 FROM json_each(
                CASE WHEN json_valid(${taskHistoryEvents.newValue})
                  THEN json_extract(${taskHistoryEvents.newValue}, ${path})
                  ELSE '[]' END
              ) membership WHERE membership.value = ${scopeId}
            )`,
          ),
        ));
        const taskIds = [...new Set(candidateRows
          .filter((row) => row.eventType !== 'baseline' || baselineHasScope(row.newValue, scope, scopeId))
          .map(({ taskId }) => taskId))];
        if (!taskIds.length) {
          return {
            scope: { projectId: project.id, scope, scopeId, scopeName, scheduleStart, scheduleEnd },
            candidateEvents: [],
            tasks: [],
          };
        }
        const latestReconstruction = candidateRows.filter((row) => (
          (
            row.eventType === 'baseline'
            && row.provenance === 'migration_baseline'
            && baselineHasScope(row.newValue, scope, scopeId)
          )
          || (scope === 'project' && row.eventType === 'project_added')
        )).map(({ occurredAt }) => occurredAt).sort().at(-1);
        const eventEnd = latestReconstruction && latestReconstruction >= input.endExclusive
          ? new Date(new Date(latestReconstruction).getTime() + 1).toISOString()
          : input.endExclusive;
        const [eventRows, taskRows] = await Promise.all([
          db.select().from(taskHistoryEvents).where(and(
            inArray(taskHistoryEvents.taskId, taskIds),
            sql`${taskHistoryEvents.occurredAt} >= ${'0000-01-01T00:00:00.000Z'}`,
            sql`${taskHistoryEvents.occurredAt} < ${eventEnd}`,
          )).orderBy(asc(taskHistoryEvents.occurredAt), asc(taskHistoryEvents.id)),
          db.select({
            id: tasks.id,
            title: tasks.title,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
          }).from(tasks).where(inArray(tasks.id, taskIds)).orderBy(asc(tasks.id)),
        ]);
        return {
          scope: { projectId: project.id, scope, scopeId, scopeName, scheduleStart, scheduleEnd },
          candidateEvents: eventRows.map(normalizeHistoryEvent),
          tasks: taskRows,
        };
      },
    },
    clusterSave: {
      async findProject(projectId) {
        return Boolean(sqlite.prepare('SELECT 1 FROM hub_projects WHERE id = ?').get(projectId));
      },
      async deleteProjectIfCreationToken(input) {
        return sqlite.transaction(() => {
          const row = sqlite.prepare('SELECT metadata FROM hub_projects WHERE id = ?')
            .get(input.projectId) as { metadata: string | null } | undefined;
          if (
            parseJsonRecord(row?.metadata ?? null)?.universeClusterCreationToken
            !== input.creationToken
          ) {
            return { deleted: false, affectedTaskIds: [] };
          }
          const affectedTaskIds = (sqlite.prepare(`
            SELECT task_id AS taskId
            FROM task_projects
            WHERE project_id = ?
            ORDER BY task_id COLLATE BINARY ASC
          `).all(input.projectId) as Array<{ taskId: string }>).map(({ taskId }) => taskId);
          sqlite.prepare('DELETE FROM project_auto_include_exclusions WHERE project_id = ?')
            .run(input.projectId);
          sqlite.prepare('DELETE FROM task_projects WHERE project_id = ?').run(input.projectId);
          sqlite.prepare('DELETE FROM hub_projects WHERE id = ?').run(input.projectId);
          return { deleted: true, affectedTaskIds };
        }).immediate();
      },
      async findTagBySlug(slug) {
        return (sqlite.prepare('SELECT id FROM tags WHERE slug = ? ORDER BY id LIMIT 1')
          .get(slug) as { id: string } | undefined) ?? null;
      },
      async createTag(input) {
        const execute = sqlite.transaction(() => {
          const existing = sqlite.prepare('SELECT id FROM tags WHERE slug = ? ORDER BY id LIMIT 1')
            .get(input.slug) as { id: string } | undefined;
          if (existing) return { id: existing.id, created: false };
          sqlite.prepare(
            `INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
             VALUES (?, ?, ?, 'hub', NULL, ?, 1, ?)`,
          ).run(input.id, input.name, input.slug, input.color, input.createdAt);
          return { id: input.id, created: true };
        });
        return execute.immediate();
      },
      async deleteTagIfUnused(tagId) {
        const execute = sqlite.transaction(() => {
          const used = sqlite.prepare('SELECT 1 FROM task_tags WHERE tag_id = ? LIMIT 1').get(tagId);
          if (used) return false;
          return sqlite.prepare('DELETE FROM tags WHERE id = ?').run(tagId).changes > 0;
        });
        return execute.immediate();
      },
      async recordTagAudit(input) {
        const insert = sqlite.prepare(
          `INSERT INTO task_history_events (
            task_id, event_type, field_name, previous_value, new_value,
            occurred_at, recorded_at, provenance, provenance_ref, metadata
          ) VALUES (?, 'universe_cluster_saved', 'tags', NULL, ?, ?, ?, 'user', ?, ?)`,
        );
        sqlite.transaction(() => {
          for (const taskId of input.taskIds) {
            insert.run(
              taskId,
              input.tagId,
              input.now,
              input.now,
              JSON.stringify({
                clusterId: input.clusterId,
                projectionFingerprint: input.projectionFingerprint,
              }),
              JSON.stringify({ reviewed: true }),
            );
          }
        }).immediate();
      },
    },
  };
}
