import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { SourceBinding } from '@/types';
import {
  matchProjectAutomationTasks,
  type AutoIncludeRule,
  type ProjectAutomationProject,
  type ProjectAutomationRepository,
  type ProjectAutomationTask,
  type ProjectRuleEvaluation,
  type ProjectRuleMatch,
} from '@/db/persistence/project-automation';
import { createPostgresProjectHierarchyRepository } from './project-hierarchy-repository';

const QUERY_BATCH_SIZE = 500;
const MAX_TRANSACTION_ATTEMPTS = 3;

interface ProjectRow {
  id: string;
  autoIncludeRules: AutoIncludeRule[];
  sourceBindings: SourceBinding[];
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  connectorInstanceId: string;
  sourceListId: string | null;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_BATCH_SIZE) {
    result.push(values.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
}

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

function retryable(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
  return code === '40001' || code === '40P01';
}

async function transaction<T>(
  pool: Pool,
  projectId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    let lockAcquired = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [projectId]);
      lockAcquired = true;
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    } finally {
      if (lockAcquired) {
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [projectId]);
      }
      client.release();
    }
  }
  throw new Error('Project automation transaction exhausted retries');
}

function projectFromRow(row: ProjectRow): ProjectAutomationProject {
  return {
    id: row.id,
    rules: Array.isArray(row.autoIncludeRules) ? row.autoIncludeRules : [],
    bindings: Array.isArray(row.sourceBindings) ? row.sourceBindings : [],
  };
}

async function getProject(
  client: PoolClient,
  projectId: string,
): Promise<ProjectAutomationProject | null> {
  const [row] = await query<ProjectRow>(client, `
    SELECT id, auto_include_rules AS "autoIncludeRules",
           source_bindings AS "sourceBindings"
    FROM hub_projects
    WHERE id = $1
  `, [projectId]);
  return row ? projectFromRow(row) : null;
}

async function listProjects(client: Pool | PoolClient): Promise<ProjectAutomationProject[]> {
  return (await query<ProjectRow>(client, `
    SELECT id, auto_include_rules AS "autoIncludeRules",
           source_bindings AS "sourceBindings"
    FROM hub_projects
  `)).map(projectFromRow);
}

async function loadTasks(
  client: PoolClient,
  projectId: string,
  candidateTaskIds?: readonly string[],
): Promise<ProjectAutomationTask[]> {
  if (candidateTaskIds?.length === 0) return [];
  const taskRows: TaskRow[] = [];
  if (candidateTaskIds) {
    for (const taskIdBatch of batches([...new Set(candidateTaskIds)])) {
      taskRows.push(...await query<TaskRow>(client, `
        SELECT id, title, status, connector_instance_id AS "connectorInstanceId",
               source_list_id AS "sourceListId"
        FROM tasks
        WHERE id = ANY($1::text[])
      `, [taskIdBatch]));
    }
  } else {
    taskRows.push(...await query<TaskRow>(client, `
      SELECT id, title, status, connector_instance_id AS "connectorInstanceId",
             source_list_id AS "sourceListId"
      FROM tasks
    `));
  }
  if (taskRows.length === 0) return [];

  const tagsByTask = new Map<string, { names: string[]; slugs: string[] }>();
  for (const taskIdBatch of batches(taskRows.map((task) => task.id))) {
    const rows = await query<{ taskId: string; name: string; slug: string }>(client, `
      SELECT task_tag.task_id AS "taskId", tag.name, tag.slug
      FROM task_tags task_tag
      INNER JOIN tags tag ON tag.id = task_tag.tag_id
      WHERE task_tag.task_id = ANY($1::text[])
    `, [taskIdBatch]);
    for (const row of rows) {
      const values = tagsByTask.get(row.taskId) ?? { names: [], slugs: [] };
      values.names.push(row.name);
      values.slugs.push(row.slug);
      tagsByTask.set(row.taskId, values);
    }
  }
  const assigned = new Set(
    (await query<{ taskId: string }>(client, `
      SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1
    `, [projectId])).map((row) => row.taskId),
  );
  const excluded = new Map(
    (await query<{ taskId: string; excludedAt: string }>(client, `
      SELECT task_id AS "taskId", excluded_at AS "excludedAt"
      FROM project_auto_include_exclusions
      WHERE project_id = $1
    `, [projectId])).map((row) => [row.taskId, row.excludedAt]),
  );

  return taskRows.map((task) => ({
    ...task,
    tagNames: tagsByTask.get(task.id)?.names ?? [],
    tagSlugs: tagsByTask.get(task.id)?.slugs ?? [],
    alreadyAssigned: assigned.has(task.id),
    excludedAt: excluded.get(task.id) ?? null,
  }));
}

async function preview(
  client: PoolClient,
  project: ProjectAutomationProject,
  candidateTaskIds?: readonly string[],
): Promise<ProjectRuleMatch[]> {
  if (project.rules.length === 0 && project.bindings.length === 0) return [];
  return matchProjectAutomationTasks(
    project,
    await loadTasks(client, project.id, candidateTaskIds),
  );
}

async function evaluate(
  client: PoolClient,
  project: ProjectAutomationProject,
  candidateTaskIds?: readonly string[],
): Promise<ProjectRuleEvaluation> {
  const matches = await preview(client, project, candidateTaskIds);
  const candidateIds = matches
    .filter((match) => !match.alreadyAssigned && !match.excluded)
    .map((match) => match.taskId);
  const assigned = new Set<string>();
  let added = 0;

  for (const taskIdBatch of batches(candidateIds)) {
    const currentExclusions = await query<{ taskId: string; excludedAt: string }>(client, `
      SELECT task_id AS "taskId", excluded_at AS "excludedAt"
      FROM project_auto_include_exclusions
      WHERE project_id = $1 AND task_id = ANY($2::text[])
    `, [project.id, taskIdBatch]);
    const exclusionByTask = new Map(
      currentExclusions.map((row) => [row.taskId, row.excludedAt]),
    );
    for (const match of matches) {
      const excludedAt = exclusionByTask.get(match.taskId);
      if (excludedAt) {
        match.excluded = true;
        match.excludedAt = excludedAt;
      }
    }
    const eligible = taskIdBatch.filter((taskId) => !exclusionByTask.has(taskId));
    if (eligible.length === 0) continue;
    const inserted = await query<{ taskId: string }>(client, `
      INSERT INTO task_projects (task_id, project_id)
      SELECT task_id, $1
      FROM unnest($2::text[]) AS candidate(task_id)
      ON CONFLICT DO NOTHING
      RETURNING task_id AS "taskId"
    `, [project.id, eligible]);
    added += inserted.length;
    for (const taskId of eligible) assigned.add(taskId);
  }

  return {
    added,
    matched: matches.length,
    matches: matches.map((match) => ({
      ...match,
      alreadyAssigned: match.alreadyAssigned || assigned.has(match.taskId),
    })),
  };
}

export function createPostgresProjectAutomationRepository(
  pool: Pool,
): ProjectAutomationRepository {
  return {
    async evaluateAll() {
      const results: Array<{ projectId: string; added: number }> = [];
      for (const project of await listProjects(pool)) {
        if (project.rules.length === 0 && project.bindings.length === 0) continue;
        const evaluation = await transaction(
          pool,
          project.id,
          async (client) => {
            const current = await getProject(client, project.id);
            return current
              ? evaluate(client, current)
              : { added: 0, matched: 0, matches: [] };
          },
        );
        results.push({ projectId: project.id, added: evaluation.added });
      }
      return results;
    },
    evaluateProject(projectId) {
      return transaction(pool, projectId, async (client) => {
        const project = await getProject(client, projectId);
        return project
          ? evaluate(client, project)
          : { added: 0, matched: 0, matches: [] };
      });
    },
    previewProject(projectId) {
      return transaction(pool, projectId, async (client) => {
        const project = await getProject(client, projectId);
        return project ? preview(client, project) : [];
      });
    },
    async evaluateTasks(taskIds) {
      if (taskIds.length === 0) return;
      for (const project of await listProjects(pool)) {
        if (project.rules.length === 0 && project.bindings.length === 0) continue;
        await transaction(pool, project.id, async (client) => {
          const current = await getProject(client, project.id);
          if (current) await evaluate(client, current, taskIds);
        });
      }
    },
    hierarchy: createPostgresProjectHierarchyRepository(pool),
  };
}
