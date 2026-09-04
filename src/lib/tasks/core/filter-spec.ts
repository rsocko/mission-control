import { getLocalDaysFromNow, getLocalToday } from '@/lib/utils/date';
import { isPlanningHorizon } from '@/lib/tasks/planning-horizon';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import type { LocalDisposition } from '@/types';
import {
  isTaskQuickFilter,
  TASK_LOCAL_DISPOSITION_VALUES,
  TASK_PLANNING_HORIZON_VALUES,
  TASK_PRIORITY_VALUES,
  TASK_STATUS_VALUES,
  type TaskFilterSpec,
  type TaskGroupMode,
} from './contracts';

/**
 * Pure, backend-neutral canonical task filter parser.
 *
 * This is the single place raw request input becomes a `TaskFilterSpec`.
 * Both portable adapters consume the *same* spec, so they cannot disagree
 * about what the canonical filter means — only about how to express it in SQL.
 *
 * It performs no I/O whatsoever: My Day membership, GitHub identity, and
 * inbox-list configuration are read separately through
 * `TaskFilterInputRepository`, because those are stored data, not request
 * input.
 */

const VALID_STATUSES = new Set<string>(TASK_STATUS_VALUES);
const VALID_PRIORITIES = new Set<string>(TASK_PRIORITY_VALUES);
const VALID_PLANNING_HORIZONS = new Set<string>(TASK_PLANNING_HORIZON_VALUES);
const VALID_LOCAL_DISPOSITIONS = new Set<string>(TASK_LOCAL_DISPOSITION_VALUES);
const ANY_NON_EMPTY_VALUE = { has: (value: string) => Boolean(value) };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TASK_GROUP_MODES = new Set<TaskGroupMode>([
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

export interface TaskFilterSpecClock {
  readonly today: string;
  readonly weekFromNow: string;
  readonly recentCutoff: string;
}

export function getTaskFilterClock(): TaskFilterSpecClock {
  return {
    today: getLocalToday(),
    weekFromNow: getLocalDaysFromNow(7),
    recentCutoff: getLocalDaysFromNow(-7),
  };
}

export function isLocalDisposition(value: string): value is LocalDisposition {
  return VALID_LOCAL_DISPOSITIONS.has(value);
}

/**
 * `true` when the filter query itself pins a local disposition, which
 * suppresses the implicit `localDisposition = 'active'` default. Exported
 * because both dialect compilers need the identical decision.
 */
export function filterQueryPinsDisposition(filterQuery: string | null): boolean {
  if (!filterQuery) return false;
  return parseFilterQuery(filterQuery).tokens.some(
    (token) => token.type === 'disposition' && isLocalDisposition(token.value),
  );
}

export function taskCollectionGroupReturnsEmpty(
  group: TaskFilterSpec['group'],
): boolean {
  if (!group) return false;
  if (group.mode === 'effort') {
    return group.value !== NO_EFFORT_GROUP_LABEL
      && !Number.isInteger(Number(group.value));
  }
  return group.mode === 'project'
    && group.value !== 'No Project'
    && !group.value.includes(' › ');
}

function defaultReadCsv(
  searchParams: URLSearchParams,
  key: string,
  validValues: { has: (value: string) => boolean },
): string[] {
  return [...new Set(
    (searchParams.get(key) ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value && validValues.has(value)),
  )];
}

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function legacyEffort(value: string | null): number | null {
  return value ? Number.parseInt(value, 10) : null;
}

function daysAgoIso(days: number, now: Date): string {
  const cutoff = new Date(now.getTime());
  cutoff.setDate(cutoff.getDate() - days);
  return cutoff.toISOString();
}

export interface BuildTaskFilterSpecOptions {
  /**
   * Reader for CSV parameters. The web layer passes the request-validating
   * `normalizedCsv` (which enforces the per-parameter length/cardinality
   * limits and throws `TaskQueryValidationError`); the default is a plain
   * split + de-duplication for non-request callers (tests, contract suite).
   */
  readonly readCsv?: (
    searchParams: URLSearchParams,
    key: string,
    validValues: { has: (value: string) => boolean },
  ) => string[];
  readonly clock?: TaskFilterSpecClock;
  /** Injectable "now" so age-window bounds are deterministic under test. */
  readonly now?: Date;
}

export function buildTaskFilterSpec(
  searchParams: URLSearchParams,
  options: BuildTaskFilterSpecOptions = {},
): TaskFilterSpec {
  const readCsv = options.readCsv ?? defaultReadCsv;
  const csv = (key: string, validValues: { has: (value: string) => boolean }) =>
    readCsv(searchParams, key, validValues);
  const clock = options.clock ?? getTaskFilterClock();
  const now = options.now ?? new Date();

  const quickFilterParam = searchParams.get('quickFilter');
  const quickFilter = isTaskQuickFilter(quickFilterParam) ? quickFilterParam : null;

  const myDayDateParam = searchParams.get('myDayDate');
  const myDayDate = myDayDateParam && ISO_DATE.test(myDayDateParam)
    ? myDayDateParam
    : clock.today;

  const filterQuery = searchParams.get('filterQuery')?.trim() || null;

  const connectorTypes = csv('sources', ANY_NON_EMPTY_VALUE);
  const source = searchParams.get('source');
  const resolvedConnectorTypes = connectorTypes.length
    ? connectorTypes
    : source
      ? [source]
      : [];

  const statuses = csv('statuses', VALID_STATUSES);
  const status = searchParams.get('status');
  // Mirrors the legacy behaviour exactly: the implicit "open only" exclusion
  // is suppressed by the *presence* of a `status` parameter, even when its
  // value is invalid and therefore contributes no status predicate.
  const hasExplicitStatusFilter = statuses.length > 0 || Boolean(status);
  const resolvedStatuses = statuses.length
    ? statuses
    : status && VALID_STATUSES.has(status)
      ? [status]
      : [];

  const priorities = csv('priorities', VALID_PRIORITIES);
  const priority = searchParams.get('priority');
  const resolvedPriorities = priorities.length
    ? priorities
    : priority && VALID_PRIORITIES.has(priority)
      ? [priority]
      : [];

  const planningHorizons = csv('planningHorizons', VALID_PLANNING_HORIZONS)
    .filter(isPlanningHorizon);
  const planningHorizon = searchParams.get('planningHorizon');
  const resolvedPlanningHorizons = planningHorizons.length
    ? planningHorizons
    : isPlanningHorizon(planningHorizon)
      ? [planningHorizon]
      : [];
  const planningHorizonIsNull = planningHorizons.length === 0 && planningHorizon === 'none';

  const localDispositions = csv('localDispositions', VALID_LOCAL_DISPOSITIONS)
    .filter(isLocalDisposition);
  const localDisposition = searchParams.get('localDisposition');
  const resolvedLocalDispositions: LocalDisposition[] = localDispositions.length
    ? localDispositions
    : localDisposition && isLocalDisposition(localDisposition)
      ? [localDisposition]
      : localDisposition !== 'all' && !filterQueryPinsDisposition(filterQuery)
        ? ['active']
        : [];

  const openOnly = searchParams.get('openOnly') === 'true'
    && quickFilterParam !== 'recentlyClosed';

  const listIds = csv('listIds', ANY_NON_EMPTY_VALUE);
  const listId = searchParams.get('listId');
  const sourceListIds = listIds.length ? listIds : listId ? [listId] : [];

  const ageMin = nonNegativeInteger(searchParams.get('ageMin'));
  const ageMax = nonNegativeInteger(searchParams.get('ageMax'));

  const tagSlugs = csv('tagSlugs', ANY_NON_EMPTY_VALUE);
  const effort = legacyEffort(searchParams.get('effort'));
  const search = searchParams.get('search')?.trim() || null;
  const tagIds = csv('tagIds', ANY_NON_EMPTY_VALUE);
  const noProject = searchParams.get('noProject') === 'true';
  const groupMode = searchParams.get('groupBy');
  const groupValue = searchParams.get('groupValue');
  const group = groupMode && groupValue && TASK_GROUP_MODES.has(groupMode as TaskGroupMode)
    ? { mode: groupMode as TaskGroupMode, value: groupValue }
    : null;

  return {
    connectorTypes: resolvedConnectorTypes,
    statuses: resolvedStatuses,
    priorities: resolvedPriorities,
    planningHorizons: resolvedPlanningHorizons,
    planningHorizonIsNull,
    localDispositions: resolvedLocalDispositions,
    excludeClosedStatuses: openOnly && !hasExplicitStatusFilter,
    openOnly,
    parentOnly: searchParams.get('parentOnly') === 'true',
    sourceListIds,
    sourceListGroupId: searchParams.get('listGroupId') || null,
    createdAtMax: ageMin === null ? null : daysAgoIso(ageMin, now),
    createdAtMin: ageMax === null ? null : daysAgoIso(ageMax, now),
    filterQuery,
    tagSlug: searchParams.get('tag') || null,
    tagSlugs,
    projectId: searchParams.get('projectId') || null,
    quickFilter,
    myDayDate,
    today: clock.today,
    weekFromNow: clock.weekFromNow,
    recentCutoff: clock.recentCutoff,
    ...(search ? { search } : {}),
    ...(effort !== null ? { effort } : {}),
    ...(tagIds.length ? { tagIds } : {}),
    ...(noProject ? { noProject: true } : {}),
    ...(group ? { group } : {}),
  };
}
