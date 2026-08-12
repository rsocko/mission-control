import {
  taskFilterContextToTaskQuery,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type { UniverseDimension } from './universe-types';

export function buildUniverseGraphSearchParams(
  context: TaskFilterContext,
  dimensions: UniverseDimension[],
  maxNodes: number,
): URLSearchParams {
  const graphParams = new URLSearchParams({
    dimensions: dimensions.join(','),
    maxNodes: String(maxNodes),
  });
  return taskFilterContextToTaskQuery(context, graphParams);
}
