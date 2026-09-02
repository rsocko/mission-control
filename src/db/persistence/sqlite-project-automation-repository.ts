import type Database from 'better-sqlite3';
import type { SourceBinding } from '@/types';
import {
  matchProjectAutomationTasks,
  type AutoIncludeRule,
  type ProjectAutomationProject,
  type ProjectAutomationRepository,
  type ProjectAutomationTask,
  type ProjectRuleEvaluation,
  type ProjectRuleMatch,
} from './project-automation';

const QUERY_BATCH_SIZE = 500;

interface ProjectRow {
  id: string;
  autoIncludeRules: string | AutoIncludeRule[];
  sourceBindings: string | SourceBinding[];
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  connectorInstanceId: string;
  sourceListId: string | null;
}

function parseArray<T>(value: string | T[]): T[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_BATCH_SIZE) {
    result.push(values.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
}

function projectFromRow(row: ProjectRow): ProjectAutomationProject {
  return {
    id: row.id,
    rules: parseArray(row.autoIncludeRules),
    bindings: parseArray(row.sourceBindings),
  };
}

function getProject(
  sqlite: Database.Database,
  projectId: string,
): ProjectAutomationProject | null {
  const row = sqlite.prepare(`
    SELECT id, auto_include_rules AS autoIncludeRules, source_bindings AS sourceBindings
    FROM hub_projects
    WHERE id = ?
  `).get(projectId) as ProjectRow | undefined;
  return row ? projectFromRow(row) : null;
}

function listProjects(sqlite: Database.Database): ProjectAutomationProject[] {
  return (sqlite.prepare(`
    SELECT id, auto_include_rules AS autoIncludeRules, source_bindings AS sourceBindings
    FROM hub_projects
  `).all() as ProjectRow[]).map(projectFromRow);
}

function loadTasks(
  sqlite: Database.Database,
  projectId: string,
  candidateTaskIds?: readonly string[],
): ProjectAutomationTask[] {
  if (candidateTaskIds?.length === 0) return [];
  const taskRows: TaskRow[] = [];
  if (candidateTaskIds) {
    for (const taskIdBatch of batches([...new Set(candidateTaskIds)])) {
      const placeholders = taskIdBatch.map(() => '?').join(', ');
      taskRows.push(...sqlite.prepare(`
        SELECT id, title, status, connector_instance_id AS connectorInstanceId,
               source_list_id AS sourceListId
        FROM tasks
        WHERE id IN (${placeholders})
      `).all(...taskIdBatch) as TaskRow[]);
    }
  } else {
    taskRows.push(...sqlite.prepare(`
      SELECT id, title, status, connector_instance_id AS connectorInstanceId,
             source_list_id AS sourceListId
      FROM tasks
    `).all() as TaskRow[]);
  }
  if (taskRows.length === 0) return [];

  const tagsByTask = new Map<string, { names: string[]; slugs: string[] }>();
  for (const taskIdBatch of batches(taskRows.map((task) => task.id))) {
    const placeholders = taskIdBatch.map(() => '?').join(', ');
    const rows = sqlite.prepare(`
      SELECT task_tag.task_id AS taskId, tag.name, tag.slug
      FROM task_tags task_tag
      INNER JOIN tags tag ON tag.id = task_tag.tag_id
      WHERE task_tag.task_id IN (${placeholders})
    `).all(...taskIdBatch) as Array<{ taskId: string; name: string; slug: string }>;
    for (const row of rows) {
      const values = tagsByTask.get(row.taskId) ?? { names: [], slugs: [] };
      values.names.push(row.name);
      values.slugs.push(row.slug);
      tagsByTask.set(row.taskId, values);
    }
  }
  const assigned = new Set(
    (sqlite.prepare(`
      SELECT task_id AS taskId FROM task_projects WHERE project_id = ?
    `).all(projectId) as Array<{ taskId: string }>).map((row) => row.taskId),
  );
  const excluded = new Map(
    (sqlite.prepare(`
      SELECT task_id AS taskId, excluded_at AS excludedAt
      FROM project_auto_include_exclusions
      WHERE project_id = ?
    `).all(projectId) as Array<{ taskId: string; excludedAt: string }>)
      .map((row) => [row.taskId, row.excludedAt]),
  );

  return taskRows.map((task) => ({
    ...task,
    tagNames: tagsByTask.get(task.id)?.names ?? [],
    tagSlugs: tagsByTask.get(task.id)?.slugs ?? [],
    alreadyAssigned: assigned.has(task.id),
    excludedAt: excluded.get(task.id) ?? null,
  }));
}

function preview(
  sqlite: Database.Database,
  project: ProjectAutomationProject,
  candidateTaskIds?: readonly string[],
): ProjectRuleMatch[] {
  if (project.rules.length === 0 && project.bindings.length === 0) return [];
  return matchProjectAutomationTasks(
    project,
    loadTasks(sqlite, project.id, candidateTaskIds),
  );
}

function evaluate(
  sqlite: Database.Database,
  project: ProjectAutomationProject,
  candidateTaskIds?: readonly string[],
): ProjectRuleEvaluation {
  const matches = preview(sqlite, project, candidateTaskIds);
  const candidateIds = matches
    .filter((match) => !match.alreadyAssigned && !match.excluded)
    .map((match) => match.taskId);
  const assigned = new Set<string>();
  let added = 0;

  for (const taskIdBatch of batches(candidateIds)) {
    const placeholders = taskIdBatch.map(() => '?').join(', ');
    const currentExclusions = sqlite.prepare(`
      SELECT task_id AS taskId, excluded_at AS excludedAt
      FROM project_auto_include_exclusions
      WHERE project_id = ? AND task_id IN (${placeholders})
    `).all(project.id, ...taskIdBatch) as Array<{ taskId: string; excludedAt: string }>;
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
    for (const taskId of taskIdBatch) {
      if (exclusionByTask.has(taskId)) continue;
      const insertion = sqlite.prepare(`
        INSERT OR IGNORE INTO task_projects (task_id, project_id) VALUES (?, ?)
      `).run(taskId, project.id);
      added += insertion.changes;
      assigned.add(taskId);
    }
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

export function createSqliteProjectAutomationRepository(
  sqlite: Database.Database,
): ProjectAutomationRepository {
  return {
    evaluateAll() {
      return Promise.resolve(sqlite.transaction(() => {
        const results: Array<{ projectId: string; added: number }> = [];
        for (const project of listProjects(sqlite)) {
          if (project.rules.length === 0 && project.bindings.length === 0) continue;
          results.push({
            projectId: project.id,
            added: evaluate(sqlite, project).added,
          });
        }
        return results;
      }).immediate());
    },
    evaluateProject(projectId) {
      return Promise.resolve(sqlite.transaction(() => {
        const project = getProject(sqlite, projectId);
        return project
          ? evaluate(sqlite, project)
          : { added: 0, matched: 0, matches: [] };
      }).immediate());
    },
    previewProject(projectId) {
      return Promise.resolve(sqlite.transaction(() => {
        const project = getProject(sqlite, projectId);
        return project ? preview(sqlite, project) : [];
      }).immediate());
    },
    evaluateTasks(taskIds) {
      if (taskIds.length === 0) return Promise.resolve();
      sqlite.transaction(() => {
        for (const project of listProjects(sqlite)) {
          if (project.rules.length === 0 && project.bindings.length === 0) continue;
          evaluate(sqlite, project, taskIds);
        }
      }).immediate();
      return Promise.resolve();
    },
  };
}
