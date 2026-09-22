import { NextResponse } from 'next/server';
import { requireTaskEditPolicy, resolveTaskEditPolicies } from '@/lib/tasks/edit-policy';
import { QUICK_SORT_SKIP_MS } from '@/lib/quick-sort/constants';
import { buildQuickSortSourceData } from '@/lib/quick-sort/source-options';
import { taskSourceTypesForFilter } from '@/lib/tasks/source-hierarchy';
import type {
  TaskQuickSortOrder,
  TaskQuickSortQueueMode,
  TaskQuickSortScope,
} from '@/lib/tasks/core/contracts';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';

export type QuickSortQueueMode = TaskQuickSortQueueMode;
export type QuickSortOrder = TaskQuickSortOrder;

const LIMIT = 50;

/**
 * GET /api/tasks/quick-sort?mode=no_priority|quadrant|no_effort|no_tags|no_planning_horizon
 *    &counts=true                         (return badge counts only)
 *    &source=connectorType                (optional scope filter)
 *    &sourceList=sourceListName           (optional scope filter)
 *    &connectorId=connectorInstanceId     (optional scope filter)
 *
 * Smart sort per mode:
 *   no_priority → most recent first (new items need priority urgently)
 *   quadrant    → most recent first (same candidates, guided decision)
 *   no_effort   → highest priority first, then most recent
 *   no_tags     → grouped by source list, then most recent within group
 *   no_planning_horizon → highest priority first, then most recent
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const mode = searchParams.get('mode') as QuickSortQueueMode | null;
  const order = (searchParams.get('order') ?? 'smart') as QuickSortOrder;
  const countsOnly = searchParams.get('counts') === 'true';

  // Optional scope filters
  const sourceFilter = searchParams.get('source');
  const sourceListFilter = searchParams.get('sourceList');
  const sourceListIdFilter = searchParams.get('sourceListId');
  const connectorIdFilter = searchParams.get('connectorId');

  const now = new Date().toISOString();
  const skipCutoff = new Date(Date.now() - QUICK_SORT_SKIP_MS).toISOString();
  const { taskReads } = await getTaskCorePersistence();

  // Return available sources for scope filter UI
  if (searchParams.get('sources') === 'true') {
    const { rows, definitions } = await taskReads.listQuickSortSources({ now, skipCutoff });

    return NextResponse.json({
      sources: buildQuickSortSourceData(rows, definitions),
    });
  }

  const scope: TaskQuickSortScope = {
    now,
    skipCutoff,
    sourceTypes: sourceFilter ? taskSourceTypesForFilter(sourceFilter) : [],
    sourceListId: sourceListIdFilter,
    sourceListName: sourceListIdFilter ? null : sourceListFilter,
    connectorInstanceId: connectorIdFilter,
  };

  if (countsOnly) {
    return NextResponse.json({
      counts: await taskReads.getQuickSortCounts(scope),
    });
  }

  if (!mode || !['no_priority', 'quadrant', 'no_effort', 'no_tags', 'no_planning_horizon'].includes(mode)) {
    return NextResponse.json({ error: 'Invalid mode' }, { status: 400 });
  }

  const rows = await taskReads.listQuickSortTasks({ ...scope, mode, order, limit: LIMIT });
  const editPolicies = await resolveTaskEditPolicies(rows);

  return NextResponse.json({
    tasks: rows.map((row) => {
      const { description, projects, phases, tags, ...task } = row;
      const editPolicy = requireTaskEditPolicy(editPolicies, row.id);
      return {
        ...task,
        hasNotes: Boolean(description?.trim()),
        projects,
        phases,
        tags,
        taskSourceModel: editPolicy.sourceModel,
        editPolicy,
      };
    }),
    returned: rows.length,
    limit: LIMIT,
  });
}
