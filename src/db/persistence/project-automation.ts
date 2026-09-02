import type { SourceBinding } from '@/types';

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

export interface ProjectAutomationRepository {
  evaluateAll(): Promise<Array<{ projectId: string; added: number }>>;
  evaluateProject(projectId: string): Promise<ProjectRuleEvaluation>;
  previewProject(projectId: string): Promise<ProjectRuleMatch[]>;
  evaluateTasks(taskIds: readonly string[]): Promise<void>;
}

export interface ProjectAutomationProject {
  id: string;
  rules: AutoIncludeRule[];
  bindings: SourceBinding[];
}

export interface ProjectAutomationTask {
  id: string;
  title: string;
  status: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  tagNames: string[];
  tagSlugs: string[];
  alreadyAssigned: boolean;
  excludedAt: string | null;
}

export function normalizeTagSlug(value: string): string {
  return value
    .trim()
    .replace(/^#+/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export function matchProjectAutomationTasks(
  project: ProjectAutomationProject,
  tasks: readonly ProjectAutomationTask[],
): ProjectRuleMatch[] {
  return tasks.flatMap((task) => {
    const reasons = new Set<string>();
    const tagSlugs = new Set([
      ...task.tagSlugs,
      ...task.tagNames.map(normalizeTagSlug),
    ]);

    for (const binding of project.bindings) {
      if (
        task.connectorInstanceId === binding.connectorInstanceId
        && (!binding.sourceListId || task.sourceListId === binding.sourceListId)
      ) {
        reasons.add(binding.sourceListId
          ? `Bound source list "${binding.sourceListId}"`
          : `Bound connector "${binding.connectorInstanceId}"`);
      }
    }

    for (const rule of project.rules) {
      if (rule.type === 'tag' && tagSlugs.has(normalizeTagSlug(rule.value))) {
        reasons.add(`Tag "${rule.value}"`);
      } else if (
        rule.type === 'title_contains'
        && task.title.toLowerCase().includes(rule.value.toLowerCase())
      ) {
        reasons.add(`Title contains "${rule.value}"`);
      } else if (rule.type === 'source_list' && task.sourceListId === rule.value) {
        reasons.add(`Source list "${rule.value}"`);
      } else if (rule.type === 'connector' && task.connectorInstanceId === rule.value) {
        reasons.add(`Connector "${rule.value}"`);
      }
    }

    if (reasons.size === 0) return [];
    return [{
      taskId: task.id,
      title: task.title,
      status: task.status,
      alreadyAssigned: task.alreadyAssigned,
      excluded: task.excludedAt !== null,
      excludedAt: task.excludedAt,
      reasons: [...reasons],
    }];
  });
}
