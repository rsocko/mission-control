import type { Pool, PoolClient } from 'pg';
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
  type SQLWrapper,
} from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
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
} from '../schema';
import type { PostgresDatabase } from '../runtime';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import {
  hasDuplicateDependency,
  wouldCreateBlockingCycle,
} from '@/lib/graph/project-subgraph';
import { compileCanonicalTaskFilter } from './task-core-filter';
import type {
  BurnHistoryEvent,
  GraphDependencyRow,
  GraphReportingPersistence,
  GraphTaskRow,
  NeighborAggregateRef,
} from '@/db/persistence/graph-reporting';

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

function byteOrder(column: SQLWrapper) {
  return sql`${column} COLLATE "C"`;
}

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
    ? sql`false`
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
  const memberships = parseJsonRecord(value)?.[
    scope === 'project' ? 'projectIds' : 'phaseIds'
  ];
  return Array.isArray(memberships) && memberships.includes(scopeId);
}

function normalizeHistoryEvent(row: typeof taskHistoryEvents.$inferSelect): BurnHistoryEvent {
  return {
    ...row,
    provenanceRef: parseJsonRecord(row.provenanceRef),
    metadata: parseJsonRecord(row.metadata),
  };
}

function dependencyFromSql(row: Record<string, unknown>): GraphDependencyRow {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    dependsOnTaskId: String(row.depends_on_task_id),
    type: row.type as 'blocks' | 'related',
    connectorInstanceId: row.connector_instance_id as string | null,
    syncStatus: row.sync_status as GraphDependencyRow['syncStatus'],
    syncAction: row.sync_action as GraphDependencyRow['syncAction'],
    syncError: row.sync_error as string | null,
    lastSyncedAt: row.last_synced_at as string | null,
    createdAt: String(row.created_at),
  };
}

async function dependencyTasks(
  client: Pool | PoolClient,
  taskIds: readonly string[],
) {
  const result = await client.query(
    `SELECT id, source_id, connector_instance_id, is_checklist_item, metadata
     FROM tasks WHERE id = ANY($1::text[]) ORDER BY id COLLATE "C"`,
    [taskIds],
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    sourceId: String(row.source_id),
    connectorInstanceId: String(row.connector_instance_id),
    isChecklistItem: Boolean(row.is_checklist_item),
    metadata: parseJsonRecord(row.metadata) ?? {},
  }));
}

export function createPostgresGraphReportingRepository(
  db: PostgresDatabase,
  pool: Pool,
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
              : sql`false`
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
            .orderBy(desc(byteOrder(tasks.updatedAt)), asc(byteOrder(tasks.id)))
            .limit(input.maxNodes + 1),
          db.select({ value: count() }).from(tasks).where(where),
        ]);
        const boundedTasks = selectedTasks.slice(0, input.maxNodes);
        const taskIds = boundedTasks.map(({ id }) => id);
        const [tagRows, projectRows] = await Promise.all([
          input.includeTags && taskIds.length
            ? db.select({
                taskId: taskTags.taskId,
                id: tags.id,
                name: tags.name,
                color: tags.color,
              }).from(taskTags).innerJoin(tags, eq(taskTags.tagId, tags.id))
                .where(inArray(taskTags.taskId, taskIds))
                .orderBy(asc(byteOrder(taskTags.taskId)), asc(byteOrder(tags.id)))
            : [],
          input.includeProjects && taskIds.length
            ? db.select({
                taskId: taskProjects.taskId,
                id: hubProjects.id,
                name: hubProjects.name,
                color: hubProjects.color,
                status: hubProjects.status,
              }).from(taskProjects).innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
                .where(inArray(taskProjects.taskId, taskIds))
                .orderBy(asc(byteOrder(taskProjects.taskId)), asc(byteOrder(hubProjects.id)))
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
          .orderBy(asc(byteOrder(tasks.id)));
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
                  : sql`false`
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
                  : sql`false`
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
                : sql`false`
              : undefined,
          ));
        }
        return {
          center,
          tasks: await query.orderBy(asc(byteOrder(tasks.id))).limit(input.limit),
        };
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
        let relatedTasks: GraphTaskRow[] = [];
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
                : sql`false`
              : undefined,
          )).orderBy(
            asc(byteOrder(taskDependencies.createdAt)),
            asc(byteOrder(taskDependencies.id)),
          ).limit(input.dependencyLimit);
          dependencies = rows.map(({ dependency }) => dependency);
          relatedTasks = [...new Map(rows.map(({ neighbor: row }) => [row.id, row])).values()]
            .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        }
        const [projects, phases, taskTagRows] = input.includeDerived
          ? await Promise.all([
              db.select(graphProjectColumns).from(taskProjects)
                .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
                .where(eq(taskProjects.taskId, input.taskId))
                .orderBy(asc(byteOrder(hubProjects.id))),
              db.select(graphPhaseColumns).from(projectPhaseItems)
                .innerJoin(projectPhases, eq(projectPhaseItems.phaseId, projectPhases.id))
                .where(and(
                  eq(projectPhaseItems.taskId, input.taskId),
                  eq(projectPhaseItems.isProposed, false),
                )).orderBy(asc(byteOrder(projectPhases.id))),
              db.select({ id: tags.id, name: tags.name, color: tags.color })
                .from(taskTags).innerJoin(tags, eq(taskTags.tagId, tags.id))
                .where(eq(taskTags.taskId, input.taskId))
                .orderBy(asc(byteOrder(tags.id))),
            ])
          : [[], [], []];
        return {
          center,
          dependencies,
          dependencyTasks: relatedTasks,
          projects,
          phases,
          tags: taskTagRows,
        };
      },
      async listTasks(taskIds) {
        return taskIds.length
          ? db.select(graphTaskColumns).from(tasks)
              .where(and(inArray(tasks.id, [...taskIds]), visibleTaskCondition()))
              .orderBy(asc(byteOrder(tasks.id)))
          : [];
      },
      async listDeletedConnectorIds() {
        const rows = await db.select({ id: connectorConfigs.id }).from(connectorConfigs)
          .where(sql`${connectorConfigs.deletedAt} IS NOT NULL`)
          .orderBy(asc(connectorConfigs.id));
        return rows.map(({ id }) => id);
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
          .orderBy(asc(projectPhases.sortOrder), asc(byteOrder(projectPhases.id)));
        const projectTasks = await db.select({
          id: tasks.id,
          title: tasks.title,
          description: tasks.description,
          status: tasks.status,
          microStatus: tasks.microStatus,
        }).from(taskProjects).innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
          .where(eq(taskProjects.projectId, projectId))
          .orderBy(asc(byteOrder(tasks.id)));
        const phaseIds = phases.map(({ id }) => id);
        const phaseItems = phaseIds.length
          ? await db.select({
              phaseId: projectPhaseItems.phaseId,
              taskId: projectPhaseItems.taskId,
            }).from(projectPhaseItems).where(inArray(projectPhaseItems.phaseId, phaseIds))
              .orderBy(
                asc(byteOrder(projectPhaseItems.phaseId)),
                asc(projectPhaseItems.sortOrder),
                asc(byteOrder(projectPhaseItems.createdAt)),
                asc(byteOrder(projectPhaseItems.id)),
              )
          : [];
        const taskIds = projectTasks.map(({ id }) => id);
        const dependencies = taskIds.length
          ? await db.select().from(taskDependencies).where(and(
              inArray(taskDependencies.taskId, taskIds),
              inArray(taskDependencies.dependsOnTaskId, taskIds),
            )).orderBy(
              asc(byteOrder(taskDependencies.createdAt)),
              asc(byteOrder(taskDependencies.id)),
            )
          : [];
        return { project, phases, tasks: projectTasks, phaseItems, dependencies };
      },
      async createDependency(input) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext('graph-reporting:task-dependencies'))`,
          );
          if (input.projectId) {
            const memberships = await client.query(
              `SELECT task_id FROM task_projects
               WHERE project_id = $1 AND task_id = ANY($2::text[])`,
              [input.projectId, [input.sourceTaskId, input.targetTaskId]],
            );
            if (new Set(memberships.rows.map(({ task_id }) => task_id)).size !== 2) {
              await client.query('ROLLBACK');
              return { kind: 'missing-project-membership' };
            }
          }
          const rows = await dependencyTasks(client, [input.sourceTaskId, input.targetTaskId]);
          const taskById = new Map(rows.map((task) => [task.id, task]));
          const blocker = taskById.get(input.sourceTaskId);
          const blocked = taskById.get(input.targetTaskId);
          if (!blocker || !blocked) {
            await client.query('ROLLBACK');
            return { kind: 'missing-task' };
          }
          const existingRows = await client.query(
            `SELECT d.task_id, d.depends_on_task_id, d.type
             FROM task_dependencies d
             JOIN tasks blocked ON blocked.id = d.task_id
             JOIN tasks blocker ON blocker.id = d.depends_on_task_id`,
          );
          const existing = existingRows.rows.map((row) => ({
            taskId: String(row.task_id),
            dependsOnTaskId: String(row.depends_on_task_id),
            type: row.type as 'blocks' | 'related',
          }));
          if (hasDuplicateDependency(
            existing,
            input.sourceTaskId,
            input.targetTaskId,
            input.type,
          )) {
            await client.query('ROLLBACK');
            return { kind: 'duplicate' };
          }
          if (
            input.type === 'blocks'
            && wouldCreateBlockingCycle(existing, input.sourceTaskId, input.targetTaskId)
          ) {
            await client.query('ROLLBACK');
            return { kind: 'cycle' };
          }
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
          await client.query(
            `INSERT INTO task_dependencies (
              id, task_id, depends_on_task_id, type, connector_instance_id,
              sync_status, sync_action, sync_error, last_synced_at, created_at
            ) VALUES ($1, $2, $3, $4, NULL, 'local', NULL, NULL, NULL, $5)`,
            [dependency.id, dependency.taskId, dependency.dependsOnTaskId, dependency.type, dependency.createdAt],
          );
          await client.query('COMMIT');
          return { kind: 'created', dependency, blocker, blocked };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (
            typeof error === 'object'
            && error !== null
            && 'code' in error
            && error.code === '23505'
          ) return { kind: 'duplicate' };
          throw error;
        } finally {
          client.release();
        }
      },
      async getDependencyDeleteContext(input) {
        const dependencyId = input.dependencyId.startsWith('dependency:')
          ? input.dependencyId.slice('dependency:'.length)
          : input.dependencyId;
        const result = await pool.query(
          'SELECT * FROM task_dependencies WHERE id = $1',
          [dependencyId],
        );
        if (!result.rows[0]) return { kind: 'missing' };
        const dependency = dependencyFromSql(result.rows[0]);
        if (
          input.taskId
          && dependency.taskId !== input.taskId
          && dependency.dependsOnTaskId !== input.taskId
        ) return { kind: 'wrong-task' };
        if (input.projectId) {
          const memberships = await pool.query(
            `SELECT task_id FROM task_projects
             WHERE project_id = $1 AND task_id = ANY($2::text[])`,
            [input.projectId, [dependency.taskId, dependency.dependsOnTaskId]],
          );
          if (new Set(memberships.rows.map(({ task_id }) => task_id)).size !== 2) {
            return { kind: 'missing-project-membership' };
          }
        }
        const rows = await dependencyTasks(pool, [
          dependency.taskId,
          dependency.dependsOnTaskId,
        ]);
        const taskById = new Map(rows.map((task) => [task.id, task]));
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
          .orderBy(asc(byteOrder(hubProjects.name)), asc(byteOrder(hubProjects.id)));
        if (!projects.length) return { projects: [], memberships: [], tasks: [], tags: [] };
        const projectIds = projects.map(({ id }) => id);
        const memberships = await db.select({
          projectId: taskProjects.projectId,
          taskId: taskProjects.taskId,
        }).from(taskProjects).where(inArray(taskProjects.projectId, projectIds))
          .orderBy(
            asc(byteOrder(taskProjects.projectId)),
            asc(byteOrder(taskProjects.taskId)),
          );
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
            }).from(tasks).where(inArray(tasks.id, taskIds))
              .orderBy(asc(byteOrder(tasks.id)))
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
          .orderBy(
            asc(byteOrder(projectTags.projectId)),
            asc(byteOrder(tags.id)),
          );
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
        }).from(taskProjects).innerJoin(tasks, eq(taskProjects.taskId, tasks.id))
          .where(eq(taskProjects.projectId, projectId))
          .orderBy(asc(byteOrder(tasks.id)));
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
        const baselineKey = scope === 'project' ? 'projectIds' : 'phaseIds';
        const candidateRows = await db.select().from(taskHistoryEvents).where(or(
          eq(membershipColumn, scopeId),
          and(
            eq(taskHistoryEvents.eventType, 'baseline'),
            sql`${taskHistoryEvents.newValue} LIKE ${`%"${baselineKey}"%`}`,
            sql`${taskHistoryEvents.newValue} LIKE ${`%${JSON.stringify(scopeId)}%`}`,
          ),
        ));
        const scopedCandidates = candidateRows.filter((row) => (
          row.eventType !== 'baseline' || baselineHasScope(row.newValue, scope, scopeId)
        ));
        const taskIds = [...new Set(scopedCandidates.map(({ taskId }) => taskId))];
        if (!taskIds.length) {
          return {
            scope: { projectId: project.id, scope, scopeId, scopeName, scheduleStart, scheduleEnd },
            candidateEvents: [],
            tasks: [],
          };
        }
        const latestReconstruction = scopedCandidates.filter((row) => (
          (
            row.eventType === 'baseline'
            && row.provenance === 'migration_baseline'
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
          )).orderBy(
            asc(byteOrder(taskHistoryEvents.occurredAt)),
            asc(taskHistoryEvents.id),
          ),
          db.select({
            id: tasks.id,
            title: tasks.title,
            createdAt: tasks.createdAt,
            completedAt: tasks.completedAt,
          }).from(tasks).where(inArray(tasks.id, taskIds))
            .orderBy(asc(byteOrder(tasks.id))),
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
        const result = await pool.query('SELECT 1 FROM hub_projects WHERE id = $1', [projectId]);
        return result.rowCount === 1;
      },
      async deleteProjectIfCreationToken(input) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const owner = await client.query<{ creation_token: unknown }>(
            `SELECT metadata ->> 'universeClusterCreationToken' AS creation_token
               FROM hub_projects
              WHERE id = $1
              FOR UPDATE`,
            [input.projectId],
          );
          if (owner.rows[0]?.creation_token !== input.creationToken) {
            await client.query('COMMIT');
            return { deleted: false, affectedTaskIds: [] };
          }
          const affected = await client.query<{ taskId: string }>(
            `SELECT task_id AS "taskId"
               FROM task_projects
              WHERE project_id = $1
              ORDER BY task_id COLLATE "C" ASC
              FOR UPDATE`,
            [input.projectId],
          );
          await client.query(
            'DELETE FROM project_auto_include_exclusions WHERE project_id = $1',
            [input.projectId],
          );
          await client.query('DELETE FROM task_projects WHERE project_id = $1', [input.projectId]);
          await client.query('DELETE FROM hub_projects WHERE id = $1', [input.projectId]);
          await client.query('COMMIT');
          return {
            deleted: true,
            affectedTaskIds: affected.rows.map(({ taskId }) => taskId),
          };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      async findTagBySlug(slug) {
        const result = await pool.query(
          'SELECT id FROM tags WHERE slug = $1 ORDER BY id COLLATE "C" LIMIT 1',
          [slug],
        );
        return result.rows[0] ? { id: String(result.rows[0].id) } : null;
      },
      async createTag(input) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(
            `SELECT pg_advisory_xact_lock(hashtext($1))`,
            [`graph-reporting:cluster-tag:${input.slug}`],
          );
          const existing = await client.query(
            'SELECT id FROM tags WHERE slug = $1 ORDER BY id COLLATE "C" LIMIT 1',
            [input.slug],
          );
          if (existing.rows[0]) {
            await client.query('COMMIT');
            return { id: String(existing.rows[0].id), created: false };
          }
          await client.query(
            `INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
             VALUES ($1, $2, $3, 'hub', NULL, $4, true, $5)`,
            [input.id, input.name, input.slug, input.color, input.createdAt],
          );
          await client.query('COMMIT');
          return { id: input.id, created: true };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
      async deleteTagIfUnused(tagId) {
        const result = await pool.query(
          `DELETE FROM tags
           WHERE id = $1
             AND NOT EXISTS (SELECT 1 FROM task_tags WHERE tag_id = $1)`,
          [tagId],
        );
        return result.rowCount === 1;
      },
      async recordTagAudit(input) {
        if (!input.taskIds.length) return;
        await pool.query(
          `INSERT INTO task_history_events (
            task_id, event_type, field_name, previous_value, new_value,
            occurred_at, recorded_at, provenance, provenance_ref, metadata
          )
          SELECT task_id, 'universe_cluster_saved', 'tags', NULL, $2,
                 $3, $3, 'user', $4::jsonb, $5::jsonb
          FROM unnest($1::text[]) AS task_id`,
          [
            input.taskIds,
            input.tagId,
            input.now,
            JSON.stringify({
              clusterId: input.clusterId,
              projectionFingerprint: input.projectionFingerprint,
            }),
            JSON.stringify({ reviewed: true }),
          ],
        );
      },
    },
  };
}
