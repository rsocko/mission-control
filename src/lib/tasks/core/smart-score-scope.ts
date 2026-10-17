import type {
  TaskCollectionRow,
  TaskFilterSpec,
} from './contracts';

const QUICK_FILTER_LABELS: Record<string, string> = {
  overdue: 'overdue tasks',
  today: 'today',
  week: 'this week',
  noDate: 'tasks without dates',
  high: 'high-priority tasks',
  myDay: 'My Day',
  recentlyCreated: 'recently created tasks',
  recentlyClosed: 'recently closed tasks',
  recurring: 'recurring tasks',
  waiting: 'waiting tasks',
  assigned: 'assigned tasks',
  inbox: 'inbox tasks',
  delegated: 'delegated tasks',
};

function hasContextFilter(spec: TaskFilterSpec, includeStatus = true): boolean {
  return spec.connectorTypes.length > 0
    || (includeStatus && spec.statuses.length > 0)
    || spec.priorities.length > 0
    || spec.planningHorizons.length > 0
    || spec.planningHorizonIsNull
    || spec.sourceListIds.length > 0
    || Boolean(spec.sourceListGroupId)
    || Boolean(spec.createdAtMax)
    || Boolean(spec.createdAtMin)
    || Boolean(spec.filterQuery)
    || Boolean(spec.tagSlug)
    || spec.tagSlugs.length > 0
    || Boolean(spec.projectId)
    || Boolean(spec.quickFilter)
    || Boolean(spec.search)
    || spec.effort !== undefined
    || Boolean(spec.tagIds?.length)
    || Boolean(spec.noProject)
    || Boolean(spec.group);
}

export function isOverallSmartScoreScope(spec: TaskFilterSpec): boolean {
  const explicitlyOpen = spec.statuses.length === 2
    && spec.statuses.includes('todo')
    && spec.statuses.includes('in_progress');
  const openScope = (spec.excludeClosedStatuses && spec.openOnly) || explicitlyOpen;
  return openScope && !hasContextFilter(spec, false);
}

export function buildOverallSmartScoreSpec(spec: TaskFilterSpec): TaskFilterSpec {
  return {
    ...spec,
    connectorTypes: [],
    statuses: [],
    priorities: [],
    planningHorizons: [],
    planningHorizonIsNull: false,
    excludeClosedStatuses: true,
    openOnly: true,
    sourceListIds: [],
    sourceListGroupId: null,
    createdAtMax: null,
    createdAtMin: null,
    filterQuery: null,
    tagSlug: null,
    tagSlugs: [],
    projectId: null,
    quickFilter: null,
    search: null,
    effort: undefined,
    tagIds: undefined,
    noProject: undefined,
    group: null,
  };
}

export function describeSmartScoreScope(
  spec: TaskFilterSpec,
  rows: readonly TaskCollectionRow[],
): string {
  if (spec.projectId) {
    const projectName = rows
      .flatMap((task) => task.projectPhaseMemberships)
      .find((membership) => membership.projectId === spec.projectId)
      ?.projectName;
    return projectName ?? 'this project';
  }

  if (spec.quickFilter) {
    return QUICK_FILTER_LABELS[spec.quickFilter] ?? 'current view';
  }

  if (spec.sourceListIds.length === 1) {
    const requested = spec.sourceListIds[0];
    const sourceListName = rows.find((task) =>
      requested === task.sourceListId
      || requested === `${task.connectorInstanceId}:${task.sourceListId}`)?.sourceListName;
    return sourceListName ?? 'this list';
  }

  if (spec.sourceListIds.length > 1 || spec.sourceListGroupId) {
    return 'selected lists';
  }

  if (isOverallSmartScoreScope(spec)) return 'all open tasks';
  if (hasContextFilter(spec)) return 'current view';
  return spec.excludeClosedStatuses ? 'all open tasks' : 'all tasks';
}
