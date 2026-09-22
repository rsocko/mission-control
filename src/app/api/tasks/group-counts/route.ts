import { NextResponse } from 'next/server';
import {
  TaskQueryValidationError,
  validateTaskQueryParams,
} from '../query-input';
import { ApiErrors } from '@/lib/api-error';
import logger from '@/lib/logger';
import { buildCanonicalTaskFilterSpec } from '../canonical-filter';
import type { TaskGroupMode } from '@/lib/tasks/core/contracts';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

const GROUP_MODES = new Set<TaskGroupMode>([
  'status',
  'priority',
  'planningHorizon',
  'source',
  'list',
  'effort',
  'dueDate',
  'tag',
  'project',
]);

/**
 * GET /api/tasks/group-counts?groupBy=status&...filters
 *
 * Returns total counts per group for the current filter set,
 * without pagination. Used by the dashboard to show accurate
 * group header counts (e.g., "To Do (127)") even when only
 * a page of tasks has been loaded.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  try {
    validateTaskQueryParams(searchParams);
  } catch (error) {
    if (error instanceof TaskQueryValidationError) {
      logger.warn({ queryKeys: [...searchParams.keys()] }, 'Rejected over-budget task group query');
      return ApiErrors.validation(error.message);
    }
    throw error;
  }

  const groupBy = searchParams.get('groupBy');

  if (!groupBy) {
    return NextResponse.json({ error: 'groupBy parameter required' }, { status: 400 });
  }

  try {
    if (!GROUP_MODES.has(groupBy as TaskGroupMode)) {
      return NextResponse.json({ error: 'Unsupported groupBy value' }, { status: 400 });
    }
    const spec = buildCanonicalTaskFilterSpec(searchParams);
    const { taskReads } = await getTaskCorePersistence();
    const counts = await taskReads.getGroupCounts({
      spec,
      groupBy: groupBy as TaskGroupMode,
    });
    return NextResponse.json({ counts });
  } catch (error) {
    console.error('Group counts error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
