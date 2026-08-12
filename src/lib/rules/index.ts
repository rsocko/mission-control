import db, { runTransaction } from '@/db';
import {
  hubProjects,
  projectAutoIncludeExclusions,
  tasks,
  taskProjects,
  taskTags,
  tags,
} from '@/db/schema';
import type { SourceBinding } from '@/types';
import { and, eq, inArray } from 'drizzle-orm';

export interface AutoIncludeRule {
  type: 'tag' | 'title_contains' | 'source_list' | 'connector';
  value: string;
}

export interface ProjectRuleMatch {
  taskId: string;
  title: string;
  status: string;
  alreadyAssigned: boolean;
  excluded: boolean;
  excludedAt: string | null;
  reasons: string[];
}

export interface ProjectRuleEvaluation {
  added: number;
  matched: number;
  matches: ProjectRuleMatch[];
}

type MatchableTask = {
  id: string;
  title: string;
  status: string;
  connectorInstanceId: string;
  sourceListId: string | null;
};

const RULE_TYPES = new Set<AutoIncludeRule['type']>([
  'tag',
  'title_contains',
  'source_list',
  'connector',
]);
const QUERY_BATCH_SIZE = 500;

function batches<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_BATCH_SIZE) {
    result.push(values.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
}

export function normalizeAutoIncludeRules(value: unknown): AutoIncludeRule[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const { type, value: ruleValue } = candidate as Record<string, unknown>;
    if (typeof type !== 'string' || !RULE_TYPES.has(type as AutoIncludeRule['type'])) return [];
    if (typeof ruleValue !== 'string') return [];
    const normalizedValue = type === 'tag'
      ? ruleValue.trim().replace(/^#+/, '')
      : ruleValue.trim();
    if (!normalizedValue) return [];
    return [{ type: type as AutoIncludeRule['type'], value: normalizedValue }];
  });
}

function normalizeTagSlug(value: string): string {
  return value
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function addReason(reasonsByTaskId: Map<string, Set<string>>, taskId: string, reason: string) {
  const reasons = reasonsByTaskId.get(taskId) ?? new Set<string>();
  reasons.add(reason);
  reasonsByTaskId.set(taskId, reasons);
}

async function findProjectRuleMatches(
  projectId: string,
  rules: AutoIncludeRule[],
  bindings: SourceBinding[],
  candidateTaskIds?: string[],
): Promise<ProjectRuleMatch[]> {
  if (candidateTaskIds?.length === 0 || (rules.length === 0 && bindings.length === 0)) return [];

  let candidateTasks: MatchableTask[];
  if (candidateTaskIds) {
    candidateTasks = [];
    for (const taskIdBatch of batches([...new Set(candidateTaskIds)])) {
      candidateTasks.push(...await db.select({
        id: tasks.id,
        title: tasks.title,
        status: tasks.status,
        connectorInstanceId: tasks.connectorInstanceId,
        sourceListId: tasks.sourceListId,
      }).from(tasks).where(inArray(tasks.id, taskIdBatch)));
    }
  } else {
    candidateTasks = await db.select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      connectorInstanceId: tasks.connectorInstanceId,
      sourceListId: tasks.sourceListId,
    }).from(tasks);
  }
  if (candidateTasks.length === 0) return [];

  const candidateIds = candidateTasks.map((task) => task.id);
  const taskTagRows: Array<{ taskId: string; tagName: string; tagSlug: string }> = [];
  for (const taskIdBatch of batches(candidateIds)) {
    taskTagRows.push(...await db.select({
      taskId: taskTags.taskId,
      tagName: tags.name,
      tagSlug: tags.slug,
    })
      .from(taskTags)
      .innerJoin(tags, eq(tags.id, taskTags.tagId))
      .where(inArray(taskTags.taskId, taskIdBatch)));
  }
  const assignedRows = await db.select({ taskId: taskProjects.taskId })
    .from(taskProjects)
    .where(eq(taskProjects.projectId, projectId));
  const exclusionRows = await db.select({
    taskId: projectAutoIncludeExclusions.taskId,
    excludedAt: projectAutoIncludeExclusions.excludedAt,
  })
    .from(projectAutoIncludeExclusions)
    .where(eq(projectAutoIncludeExclusions.projectId, projectId));

  const tagSlugsByTaskId = new Map<string, Set<string>>();
  for (const row of taskTagRows) {
    const slugs = tagSlugsByTaskId.get(row.taskId) ?? new Set<string>();
    slugs.add(row.tagSlug);
    slugs.add(normalizeTagSlug(row.tagName));
    tagSlugsByTaskId.set(row.taskId, slugs);
  }

  const normalizedRules = normalizeAutoIncludeRules(rules);
  const assignedTaskIds = new Set(assignedRows.map((row) => row.taskId));
  const exclusionsByTaskId = new Map(
    exclusionRows.map((row) => [row.taskId, row.excludedAt]),
  );
  const reasonsByTaskId = new Map<string, Set<string>>();

  for (const task of candidateTasks) {
    for (const binding of bindings) {
      if (
        task.connectorInstanceId === binding.connectorInstanceId
        && (!binding.sourceListId || task.sourceListId === binding.sourceListId)
      ) {
        const source = binding.sourceListId
          ? `Bound source list "${binding.sourceListId}"`
          : `Bound connector "${binding.connectorInstanceId}"`;
        addReason(reasonsByTaskId, task.id, source);
      }
    }

    for (const rule of normalizedRules) {
      if (
        rule.type === 'tag'
        && tagSlugsByTaskId.get(task.id)?.has(normalizeTagSlug(rule.value))
      ) {
        addReason(reasonsByTaskId, task.id, `Tag "${rule.value}"`);
      } else if (
        rule.type === 'title_contains'
        && task.title.toLowerCase().includes(rule.value.toLowerCase())
      ) {
        addReason(reasonsByTaskId, task.id, `Title contains "${rule.value}"`);
      } else if (rule.type === 'source_list' && task.sourceListId === rule.value) {
        addReason(reasonsByTaskId, task.id, `Source list "${rule.value}"`);
      } else if (rule.type === 'connector' && task.connectorInstanceId === rule.value) {
        addReason(reasonsByTaskId, task.id, `Connector "${rule.value}"`);
      }
    }
  }

  return candidateTasks.flatMap((task) => {
    const reasons = reasonsByTaskId.get(task.id);
    if (!reasons) return [];
    return [{
      taskId: task.id,
      title: task.title,
      status: task.status,
      alreadyAssigned: assignedTaskIds.has(task.id),
      excluded: exclusionsByTaskId.has(task.id),
      excludedAt: exclusionsByTaskId.get(task.id) ?? null,
      reasons: [...reasons],
    }];
  });
}

async function evaluateProjectRules(
  projectId: string,
  rules: AutoIncludeRule[],
  bindings: SourceBinding[],
  candidateTaskIds?: string[],
): Promise<ProjectRuleEvaluation> {
  const matches = await findProjectRuleMatches(projectId, rules, bindings, candidateTaskIds);
  const candidateIds = matches
    .filter((match) => !match.alreadyAssigned)
    .map((match) => match.taskId);
  const assignedTaskIds = new Set<string>();
  const currentExclusionsByTaskId = new Map<string, string>();
  let added = 0;

  if (candidateIds.length > 0) {
    runTransaction((tx) => {
      for (const taskIdBatch of batches(candidateIds)) {
        const currentExclusions = tx.select({
          taskId: projectAutoIncludeExclusions.taskId,
          excludedAt: projectAutoIncludeExclusions.excludedAt,
        })
          .from(projectAutoIncludeExclusions)
          .where(and(
            eq(projectAutoIncludeExclusions.projectId, projectId),
            inArray(projectAutoIncludeExclusions.taskId, taskIdBatch),
          ))
          .all();
        const excludedTaskIds = new Set(currentExclusions.map((row) => row.taskId));
        for (const exclusion of currentExclusions) {
          currentExclusionsByTaskId.set(exclusion.taskId, exclusion.excludedAt);
        }
        const eligibleTaskIds = taskIdBatch.filter((taskId) => !excludedTaskIds.has(taskId));
        if (eligibleTaskIds.length === 0) continue;

        const insertion = tx.insert(taskProjects).values(
          eligibleTaskIds.map((taskId) => ({ taskId, projectId })),
        ).onConflictDoNothing().run();
        added += insertion.changes;
        for (const taskId of eligibleTaskIds) assignedTaskIds.add(taskId);
      }
    });
  }

  for (const match of matches) {
    if (match.alreadyAssigned) continue;
    match.excluded = currentExclusionsByTaskId.has(match.taskId);
    match.excludedAt = currentExclusionsByTaskId.get(match.taskId) ?? null;
  }

  return {
    added,
    matched: matches.length,
    matches: matches.map((match) => ({
      ...match,
      alreadyAssigned: match.alreadyAssigned || assignedTaskIds.has(match.taskId),
    })),
  };
}

export async function evaluateAllProjectRules(): Promise<{ projectId: string; added: number }[]> {
  const projects = await db.select().from(hubProjects);
  const results: { projectId: string; added: number }[] = [];

  for (const project of projects) {
    const rules = normalizeAutoIncludeRules(project.autoIncludeRules);
    const bindings = (project.sourceBindings || []) as SourceBinding[];
    if (rules.length === 0 && bindings.length === 0) continue;

    const evaluation = await evaluateProjectRules(project.id, rules, bindings);
    results.push({ projectId: project.id, added: evaluation.added });
  }

  return results;
}

export async function reevaluateProject(projectId: string): Promise<ProjectRuleEvaluation> {
  const [project] = await db.select().from(hubProjects).where(eq(hubProjects.id, projectId)).limit(1);
  if (!project) return { added: 0, matched: 0, matches: [] };

  return evaluateProjectRules(
    projectId,
    normalizeAutoIncludeRules(project.autoIncludeRules),
    (project.sourceBindings || []) as SourceBinding[],
  );
}

export async function previewProjectRules(projectId: string): Promise<ProjectRuleMatch[]> {
  const [project] = await db.select().from(hubProjects).where(eq(hubProjects.id, projectId)).limit(1);
  if (!project) return [];

  return findProjectRuleMatches(
    projectId,
    normalizeAutoIncludeRules(project.autoIncludeRules),
    (project.sourceBindings || []) as SourceBinding[],
  );
}

export async function evaluateRulesForTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  const projects = await db.select().from(hubProjects);

  for (const project of projects) {
    const rules = normalizeAutoIncludeRules(project.autoIncludeRules);
    const bindings = (project.sourceBindings || []) as SourceBinding[];
    if (rules.length === 0 && bindings.length === 0) continue;
    await evaluateProjectRules(project.id, rules, bindings, taskIds);
  }
}
