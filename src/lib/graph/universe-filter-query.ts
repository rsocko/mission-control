import {
  taskFilterContextToTaskQuery,
  type TaskFilterContext,
} from '@/lib/task-filter-context';
import type { UniverseDimension } from './universe-types';

export function buildUniverseGraphSearchParams(
  context: TaskFilterContext,
  dimensions: UniverseDimension[],
  maxNodes: number,
  seedTaskIds: string[] = [],
): URLSearchParams {
  const graphParams = new URLSearchParams({
    dimensions: dimensions.join(','),
    maxNodes: String(maxNodes),
    parentOnly: 'true',
  });
  if (seedTaskIds.length) graphParams.set('seedTaskIds', seedTaskIds.slice(0, 10).join(','));
  return taskFilterContextToTaskQuery(context, graphParams);
}
