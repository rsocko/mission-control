import type { TagInsights } from '@/lib/tag-insights/types';
import type { WordInsightsResult } from '@/lib/word-insights/types';
import { boundGraph, canonicalPair, normalizeGraphBudgets } from './query';
import type {
  SharedGraphEdge,
  SharedGraphNode,
  TagCoOccurrenceGraphEdge,
  WordTaskProvenanceGraphEdge,
} from './types';

function taskStatus(status: string) {
  if (status === 'done' || status === 'completed') return 'done' as const;
  if (status === 'in_progress' || status === 'active') return 'in_progress' as const;
  if (status === 'blocked') return 'blocked' as const;
  return 'todo' as const;
}

export function projectTagInsights(
  insights: TagInsights,
  requestedBudgets: { maxNodes?: number; maxEdges?: number } = {},
) {
  const budgets = normalizeGraphBudgets(requestedBudgets);
  const nodes: SharedGraphNode[] = [
    ...insights.tags.map((tag) => ({
      id: `tag:${tag.id}`,
      entityId: tag.id,
      kind: 'tag' as const,
      label: tag.name,
      color: tag.color,
      taskCount: tag.taskCount,
    })),
    ...Object.values(insights.tasks).map((task) => ({
      id: `task:${task.id}`,
      entityId: task.id,
      kind: 'task' as const,
      label: task.title,
      status: taskStatus(task.status),
    })),
  ];
  const edges: SharedGraphEdge[] = [
    ...insights.tags.flatMap((tag) => tag.taskIds.map((taskId) => ({
      id: `has-tag:task:${taskId}:tag:${tag.id}`,
      source: `task:${taskId}`,
      target: `tag:${tag.id}`,
      type: 'has-tag' as const,
      provenance: 'derived' as const,
    }))),
    ...insights.pairs.map((pair): TagCoOccurrenceGraphEdge => {
      const [source, target] = canonicalPair(
        `tag:${pair.sourceTagId}`,
        `tag:${pair.targetTagId}`,
      );
      return {
        id: `tag-co-occurrence:${source}:${target}`,
        source,
        target,
        type: 'tag-co-occurrence',
        provenance: 'derived',
        count: pair.count,
        taskIds: [...pair.taskIds],
      };
    }),
  ];
  return boundGraph(nodes, edges, {
    ...budgets,
    sourceTruncated: insights.meta.truncated,
  });
}

export function projectWordInsights(
  insights: WordInsightsResult,
  requestedBudgets: { maxNodes?: number; maxEdges?: number } = {},
) {
  const budgets = normalizeGraphBudgets(requestedBudgets);
  const tasksById = new Map(insights.tasks.map((task) => [task.id, task]));
  const nodes: SharedGraphNode[] = [
    ...insights.words.map((word) => ({
      id: `word:${encodeURIComponent(word.text)}`,
      entityId: word.text,
      kind: 'word' as const,
      label: word.text,
      count: word.count,
      taskCount: word.taskIds.length,
    })),
    ...insights.tasks.map((task) => ({
      id: `task:${task.id}`,
      entityId: task.id,
      kind: 'task' as const,
      label: task.title,
      status: taskStatus(task.status),
    })),
  ];
  const edges: WordTaskProvenanceGraphEdge[] = insights.words.flatMap((word) =>
    word.provenance
      .filter(({ taskId }) => tasksById.has(taskId))
      .map(({ taskId, sources }) => ({
        id: `word-task-provenance:${encodeURIComponent(word.text)}:${taskId}`,
        source: `word:${encodeURIComponent(word.text)}`,
        target: `task:${taskId}`,
        type: 'word-task-provenance',
        provenance: 'derived',
        sources: sources.map((source) => ({
          ...source,
          labels: [...source.labels],
        })),
      })));
  return boundGraph(nodes, edges, {
    ...budgets,
    sourceTruncated: insights.truncated || insights.wordTruncated,
  });
}
