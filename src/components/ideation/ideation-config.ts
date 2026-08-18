import type { IdeationNodeKind, IdeationPropertyKey } from '@/lib/graph/ideation-types';

export const IDEATION_KIND_OPTION_LABELS: Record<IdeationNodeKind, string> = {
  idea: 'Idea (untyped)',
  phase: 'Phase',
  task: 'Task',
};

export const IDEATION_SHORTCUT_PROPERTIES: Record<string, {
  key: IdeationPropertyKey;
  prefix: string;
  values?: string[];
}> = {
  p: { key: 'priority', prefix: 'priority:: ', values: ['critical', 'high', 'medium', 'low', 'none'] },
  s: { key: 'status', prefix: 'status:: ', values: ['todo', 'in_progress', 'done', 'blocked'] },
  d: { key: 'due', prefix: 'due:: ' },
  l: { key: 'tags', prefix: 'tags:: ' },
  e: { key: 'effort', prefix: 'effort:: ', values: ['1', '2', '3', '4', '5'] },
  a: { key: 'assignee', prefix: 'assignee:: ', values: ['me'] },
};
