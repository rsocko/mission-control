import 'server-only';

import type {
  AutoIncludeRule,
  ProjectRuleEvaluation,
  ProjectRuleMatch,
} from '@/db/persistence/project-automation';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export type { AutoIncludeRule, ProjectRuleEvaluation, ProjectRuleMatch };

const RULE_TYPES = new Set<AutoIncludeRule['type']>([
  'tag',
  'title_contains',
  'source_list',
  'connector',
]);

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
    return normalizedValue
      ? [{ type: type as AutoIncludeRule['type'], value: normalizedValue }]
      : [];
  });
}

export async function evaluateAllProjectRules(): Promise<Array<{ projectId: string; added: number }>> {
  return (await getWorkerPersistenceRepositories()).projectAutomation.evaluateAll();
}

export async function reevaluateProject(projectId: string): Promise<ProjectRuleEvaluation> {
  return (await getWorkerPersistenceRepositories()).projectAutomation.evaluateProject(projectId);
}

export async function previewProjectRules(projectId: string): Promise<ProjectRuleMatch[]> {
  return (await getWorkerPersistenceRepositories()).projectAutomation.previewProject(projectId);
}

export async function evaluateRulesForTasks(taskIds: string[]): Promise<void> {
  if (taskIds.length === 0) return;
  await (await getWorkerPersistenceRepositories()).projectAutomation.evaluateTasks(taskIds);
}
