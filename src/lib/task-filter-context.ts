import {
  parseFilterQuery,
  removeFilterQueryToken,
  type FilterToken,
  type FilterTokenType,
} from '@/lib/utils/parseFilterQuery';

export const TASK_FILTER_CONTEXT_PARAM = 'tf';
export const TASK_FILTER_CONTEXT_VERSION = 1 as const;

const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low', 'none']);
const VALID_STATUSES = new Set(['todo', 'in_progress', 'done', 'cancelled']);

export interface TaskFilterContext {
  version: typeof TASK_FILTER_CONTEXT_VERSION;
  query: string;
  sources: string[];
  listIds: string[];
  listGroupId: string | null;
  tagSlugs: string[];
  projectId: string | null;
  priorities: string[];
  statuses: string[];
  quickFilter: string | null;
  myDayDate: string | null;
  completion: 'open' | 'all';
  ageMinDays: number | null;
  ageMaxDays: number | null;
}

export type TaskFilterCriterionKind =
  | FilterTokenType
  | 'listGroup'
  | 'project'
  | 'quickFilter'
  | 'completion'
  | 'ageMin'
  | 'ageMax';

export type TaskFilterContextCriterionField =
  | 'sources'
  | 'listIds'
  | 'listGroupId'
  | 'tagSlugs'
  | 'projectId'
  | 'priorities'
  | 'statuses'
  | 'quickFilter'
  | 'completion'
  | 'ageMinDays'
  | 'ageMaxDays';

export type TaskFilterCriterionDescriptor =
  | {
      id: string;
      origin: 'query';
      kind: FilterTokenType;
      value: string;
      label: string;
      negated: boolean;
      tokenIndex: number;
      token: FilterToken;
    }
  | {
      id: string;
      origin: 'context';
      kind: Exclude<TaskFilterCriterionKind, FilterTokenType>
        | 'source'
        | 'list'
        | 'tag'
        | 'project'
        | 'priority'
        | 'status';
      field: TaskFilterContextCriterionField;
      value: string | number;
      label: string;
    };

export interface DashboardTaskFilterState {
  sourceFilter: string | null;
  listFilter: string | null;
  listGroupFilter: string | null;
  tagFilter: string[];
  quickFilter: string | null;
  projectFilter: string | null;
  priorityFilter: string[];
  statusFilter: string[];
  textFilter: string;
  showCompleted: boolean;
  myDayDate?: string | null;
  ageMinDays?: number | null;
  ageMaxDays?: number | null;
}

export interface LegacyUniverseFilters {
  search?: unknown;
  priorities?: unknown;
  statuses?: unknown;
  sources?: unknown;
  lists?: unknown;
}

export interface TaskFilterHydration {
  context: TaskFilterContext;
  source: 'canonical' | 'legacy' | 'empty';
  issues: string[];
}

export const EMPTY_TASK_FILTER_CONTEXT: TaskFilterContext = Object.freeze({
  version: TASK_FILTER_CONTEXT_VERSION,
  query: '',
  sources: [],
  listIds: [],
  listGroupId: null,
  tagSlugs: [],
  projectId: null,
  priorities: [],
  statuses: [],
  quickFilter: null,
  myDayDate: null,
  completion: 'open',
  ageMinDays: null,
  ageMaxDays: null,
});

export function normalizeTaskFilterContext(value: unknown): TaskFilterContext {
  const input = isRecord(value) ? value : {};
  const quickFilter = stringValue(input.quickFilter);
  return {
    version: TASK_FILTER_CONTEXT_VERSION,
    query: stringValue(input.query) ?? '',
    sources: stringArray(input.sources, true),
    listIds: stringArray(input.listIds),
    listGroupId: stringValue(input.listGroupId),
    tagSlugs: stringArray(input.tagSlugs, true),
    projectId: stringValue(input.projectId),
    priorities: stringArray(input.priorities, true).filter((item) => VALID_PRIORITIES.has(item)),
    statuses: stringArray(input.statuses, true).filter((item) => VALID_STATUSES.has(item)),
    quickFilter,
    myDayDate: quickFilter === 'myDay' ? isoDateValue(input.myDayDate) : null,
    completion: input.completion === 'all' ? 'all' : 'open',
    ageMinDays: nonNegativeInteger(input.ageMinDays),
    ageMaxDays: nonNegativeInteger(input.ageMaxDays),
  };
}

export function serializeTaskFilterContext(context: TaskFilterContext): string {
  return JSON.stringify(normalizeTaskFilterContext(context));
}

export function parseTaskFilterContext(serialized: string): TaskFilterHydration {
  const issues: string[] = [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!isRecord(parsed) || parsed.version !== TASK_FILTER_CONTEXT_VERSION) {
      return {
        context: EMPTY_TASK_FILTER_CONTEXT,
        source: 'empty',
        issues: ['Unsupported task filter context version'],
      };
    }
    collectDroppedValueIssues(parsed, issues);
    return {
      context: normalizeTaskFilterContext(parsed),
      source: 'canonical',
      issues,
    };
  } catch {
    return {
      context: EMPTY_TASK_FILTER_CONTEXT,
      source: 'empty',
      issues: ['Invalid task filter context'],
    };
  }
}

export function hydrateTaskFilterContext(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike,
): TaskFilterHydration {
  const serialized = searchParams.get(TASK_FILTER_CONTEXT_PARAM);
  if (serialized !== null) {
    return parseTaskFilterContext(serialized);
  }

  const context = taskFilterContextFromLegacyParams(searchParams);
  return {
    context,
    source: countTaskFilters(context) > 0 || context.completion === 'all' ? 'legacy' : 'empty',
    issues: [],
  };
}

export function setTaskFilterContextInSearchParams(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike,
  context: TaskFilterContext,
): URLSearchParams {
  const next = new URLSearchParams(searchParams.toString());
  clearLegacyTaskFilterParams(next);
  const normalized = normalizeTaskFilterContext(context);
  if (countTaskFilters(normalized) === 0 && normalized.completion === 'open') {
    next.delete(TASK_FILTER_CONTEXT_PARAM);
  } else {
    next.set(TASK_FILTER_CONTEXT_PARAM, serializeTaskFilterContext(normalized));
  }
  return next;
}

export function clearTaskFilterContextFromSearchParams(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike,
): URLSearchParams {
  const next = new URLSearchParams(searchParams.toString());
  next.delete(TASK_FILTER_CONTEXT_PARAM);
  clearLegacyTaskFilterParams(next);
  return next;
}

export function updateTaskFilterContext(
  context: TaskFilterContext,
  update: Partial<Omit<TaskFilterContext, 'version'>>,
): TaskFilterContext {
  return normalizeTaskFilterContext({ ...context, ...update });
}

export function countTaskFilters(context: TaskFilterContext): number {
  return describeTaskFilterCriteria(context).length;
}

export function describeTaskFilterCriteria(
  context: TaskFilterContext,
): TaskFilterCriterionDescriptor[] {
  const normalized = normalizeTaskFilterContext(context);
  const descriptors: TaskFilterCriterionDescriptor[] = parseFilterQuery(normalized.query).tokens
    .map((queryToken, tokenIndex) => ({
      id: `query:${tokenIndex}:${queryToken.raw}`,
      origin: 'query' as const,
      kind: queryToken.type,
      value: queryToken.value,
      label: queryToken.raw,
      negated: queryToken.negated,
      tokenIndex,
      token: queryToken,
    }));
  addArrayCriteria(descriptors, 'sources', 'source', normalized.sources);
  addArrayCriteria(descriptors, 'listIds', 'list', normalized.listIds);
  addScalarCriterion(descriptors, 'listGroupId', 'listGroup', normalized.listGroupId, 'group');
  addArrayCriteria(descriptors, 'tagSlugs', 'tag', normalized.tagSlugs);
  addScalarCriterion(descriptors, 'projectId', 'project', normalized.projectId, 'project');
  addArrayCriteria(descriptors, 'priorities', 'priority', normalized.priorities);
  addArrayCriteria(descriptors, 'statuses', 'status', normalized.statuses);
  if (normalized.quickFilter) {
    const dateSuffix = normalized.quickFilter === 'myDay' && normalized.myDayDate
      ? `@${normalized.myDayDate}`
      : '';
    descriptors.push({
      id: `context:quickFilter:${normalized.quickFilter}${dateSuffix}`,
      origin: 'context',
      kind: 'quickFilter',
      field: 'quickFilter',
      value: normalized.quickFilter,
      label: `date:${normalized.quickFilter}${dateSuffix}`,
    });
  }
  if (normalized.completion === 'all') {
    descriptors.push({
      id: 'context:completion:all',
      origin: 'context',
      kind: 'completion',
      field: 'completion',
      value: 'all',
      label: 'completion:all',
    });
  }
  addScalarCriterion(descriptors, 'ageMinDays', 'ageMin', normalized.ageMinDays, 'age:>=');
  addScalarCriterion(descriptors, 'ageMaxDays', 'ageMax', normalized.ageMaxDays, 'age:<=');
  return descriptors;
}

export function removeTaskFilterCriterion(
  context: TaskFilterContext,
  descriptor: TaskFilterCriterionDescriptor,
): TaskFilterContext {
  const normalized = normalizeTaskFilterContext(context);
  if (descriptor.origin === 'query') {
    return updateTaskFilterContext(normalized, {
      query: removeFilterQueryToken(
        normalized.query,
        descriptor.tokenIndex,
        descriptor.token,
      ),
    });
  }

  switch (descriptor.field) {
    case 'sources':
    case 'listIds':
    case 'tagSlugs':
    case 'priorities':
    case 'statuses':
      return updateTaskFilterContext(normalized, {
        [descriptor.field]: normalized[descriptor.field]
          .filter((value) => value !== descriptor.value),
      });
    case 'listGroupId':
    case 'projectId':
      return updateTaskFilterContext(normalized, { [descriptor.field]: null });
    case 'quickFilter':
      return updateTaskFilterContext(normalized, {
        quickFilter: null,
        myDayDate: null,
      });
    case 'completion':
      return updateTaskFilterContext(normalized, { completion: 'open' });
    case 'ageMinDays':
    case 'ageMaxDays':
      return updateTaskFilterContext(normalized, { [descriptor.field]: null });
  }
}

type ContextCriterionDescriptor = Extract<
  TaskFilterCriterionDescriptor,
  { origin: 'context' }
>;

function addArrayCriteria(
  descriptors: TaskFilterCriterionDescriptor[],
  field: 'sources' | 'listIds' | 'tagSlugs' | 'priorities' | 'statuses',
  kind: ContextCriterionDescriptor['kind'],
  values: string[],
): void {
  for (const value of values) {
    descriptors.push({
      id: `context:${field}:${value}`,
      origin: 'context',
      kind,
      field,
      value,
      label: `${kind}:${value}`,
    });
  }
}

function addScalarCriterion(
  descriptors: TaskFilterCriterionDescriptor[],
  field: 'listGroupId' | 'projectId' | 'ageMinDays' | 'ageMaxDays',
  kind: ContextCriterionDescriptor['kind'],
  value: string | number | null,
  labelPrefix: string,
): void {
  if (value === null) return;
  descriptors.push({
    id: `context:${field}:${value}`,
    origin: 'context',
    kind,
    field,
    value,
    label: `${labelPrefix}:${value}`,
  });
}

export function taskFilterContextFromDashboard(
  state: DashboardTaskFilterState,
  age?: { minDays?: number | null; maxDays?: number | null },
): TaskFilterContext {
  return normalizeTaskFilterContext({
    query: reconcileDashboardQuery(state),
    sources: state.sourceFilter ? [state.sourceFilter] : [],
    listIds: state.listFilter ? [state.listFilter] : [],
    listGroupId: state.listGroupFilter,
    tagSlugs: state.tagFilter,
    projectId: state.projectFilter,
    priorities: state.priorityFilter,
    statuses: state.statusFilter,
    quickFilter: state.quickFilter,
    myDayDate: state.myDayDate,
    completion: state.showCompleted ? 'all' : 'open',
    ageMinDays: state.ageMinDays ?? age?.minDays,
    ageMaxDays: state.ageMaxDays ?? age?.maxDays,
  });
}

export function taskFilterContextToDashboard(
  context: TaskFilterContext,
): DashboardTaskFilterState {
  const normalized = normalizeTaskFilterContext(context);
  const dashboardState: DashboardTaskFilterState = {
    sourceFilter: normalized.sources.length === 1 ? normalized.sources[0] : null,
    listFilter: normalized.listIds.length === 1 ? normalized.listIds[0] : null,
    listGroupFilter: normalized.listGroupId,
    tagFilter: normalized.tagSlugs,
    quickFilter: normalized.quickFilter,
    projectFilter: normalized.projectId,
    priorityFilter: normalized.priorities,
    statusFilter: normalized.statuses,
    textFilter: mergeQueryWithMultiValueFilters(normalized),
    showCompleted: normalized.completion === 'all',
    myDayDate: normalized.myDayDate,
    ageMinDays: normalized.ageMinDays,
    ageMaxDays: normalized.ageMaxDays,
  };
  dashboardState.textFilter = reconcileDashboardQuery(dashboardState);
  return dashboardState;
}

export function taskFilterContextFromSavedView(
  filters: Record<string, string>,
): TaskFilterContext {
  return normalizeTaskFilterContext({
    query: filters.query ?? filters.filterQuery,
    sources: splitParam(filters.sources ?? filters.source),
    listIds: splitParam(filters.listIds ?? filters.listId),
    listGroupId: filters.listGroupId,
    tagSlugs: splitParam(filters.tagSlugs ?? filters.tag),
    projectId: filters.projectId,
    priorities: splitParam(filters.priorities ?? filters.priority),
    statuses: splitParam(filters.statuses ?? filters.status),
    quickFilter: filters.quickFilter,
    myDayDate: filters.myDayDate,
    completion: filters.completion === 'all' || filters.showCompleted === 'true' ? 'all' : 'open',
    ageMinDays: filters.ageMin,
    ageMaxDays: filters.ageMax,
  });
}

export function taskFilterContextToSavedView(
  context: TaskFilterContext,
): Record<string, string> {
  const params = taskFilterContextToTaskQuery(context);
  const filters: Record<string, string> = {};
  params.forEach((value, key) => {
    if (key === 'openOnly') return;
    filters[key === 'filterQuery' ? 'query' : key] = value;
  });
  if (context.completion === 'all') filters.completion = 'all';
  return filters;
}

export function migrateLegacyUniverseFilters(filters: LegacyUniverseFilters): TaskFilterHydration {
  const candidate = {
    query: stringValue(filters.search),
    priorities: filters.priorities,
    statuses: filters.statuses,
    sources: filters.sources,
    listIds: filters.lists,
  };
  const issues: string[] = [];
  collectDroppedValueIssues(candidate, issues);
  return {
    context: normalizeTaskFilterContext(candidate),
    source: 'legacy',
    issues,
  };
}

export function taskFilterContextToTaskQuery(
  context: TaskFilterContext,
  initial?: URLSearchParams,
): URLSearchParams {
  const normalized = normalizeTaskFilterContext(context);
  const params = new URLSearchParams(initial?.toString());
  clearLegacyTaskFilterParams(params);

  if (normalized.completion === 'open' && normalized.statuses.length === 0) {
    params.set('openOnly', 'true');
  }
  setArrayParam(params, normalized.sources, 'source', 'sources');
  setArrayParam(params, normalized.listIds, 'listId', 'listIds');
  if (normalized.listGroupId) params.set('listGroupId', normalized.listGroupId);
  if (normalized.tagSlugs.length === 1) params.set('tag', normalized.tagSlugs[0]);
  if (normalized.tagSlugs.length > 1) params.set('tagSlugs', normalized.tagSlugs.join(','));
  if (normalized.projectId) params.set('projectId', normalized.projectId);
  if (normalized.priorities.length) params.set('priorities', normalized.priorities.join(','));
  if (normalized.statuses.length) params.set('statuses', normalized.statuses.join(','));
  if (normalized.quickFilter) params.set('quickFilter', normalized.quickFilter);
  if (normalized.quickFilter === 'myDay' && normalized.myDayDate) {
    params.set('myDayDate', normalized.myDayDate);
  }
  if (normalized.query) params.set('filterQuery', normalized.query);
  if (normalized.ageMinDays !== null) params.set('ageMin', String(normalized.ageMinDays));
  if (normalized.ageMaxDays !== null) params.set('ageMax', String(normalized.ageMaxDays));
  return params;
}

function taskFilterContextFromLegacyParams(
  searchParams: URLSearchParams | ReadonlyURLSearchParamsLike,
): TaskFilterContext {
  return normalizeTaskFilterContext({
    query: searchParams.get('filterQuery') ?? searchParams.get('query'),
    sources: splitParam(searchParams.get('sources') ?? searchParams.get('source')),
    listIds: splitParam(searchParams.get('listIds') ?? searchParams.get('listId')),
    listGroupId: searchParams.get('listGroupId'),
    tagSlugs: splitParam(
      searchParams.get('tagSlugs') ?? searchParams.get('tag'),
    ),
    projectId: searchParams.get('projectId'),
    priorities: splitParam(
      searchParams.get('priorities') ?? searchParams.get('priority'),
    ),
    statuses: splitParam(
      searchParams.get('statuses') ?? searchParams.get('status'),
    ),
    quickFilter: searchParams.get('quickFilter'),
    myDayDate: searchParams.get('myDayDate'),
    completion:
      searchParams.get('completion') === 'all' || searchParams.get('openOnly') === 'false'
        ? 'all'
        : 'open',
    ageMinDays: searchParams.get('ageMin'),
    ageMaxDays: searchParams.get('ageMax'),
  });
}

function mergeQueryWithMultiValueFilters(context: TaskFilterContext): string {
  const additions: string[] = [];
  if (context.sources.length > 1) {
    additions.push(...context.sources.map((source) => token('source', source)));
  }
  if (context.listIds.length > 1) {
    additions.push(...context.listIds.map((listId) => token('listid', listId)));
  }
  return [context.query, ...additions].filter(Boolean).join(' ');
}

function reconcileDashboardQuery(state: DashboardTaskFilterState): string {
  const overriddenTypes: FilterTokenType[] = [];
  if (state.sourceFilter) overriddenTypes.push('source');
  if (state.listFilter) overriddenTypes.push('listid');
  if (state.tagFilter.length) overriddenTypes.push('tag');
  if (state.priorityFilter.length) overriddenTypes.push('priority');
  if (state.statusFilter.length) overriddenTypes.push('status');
  return withoutTaskFilterQueryTypes(state.textFilter, overriddenTypes);
}

export function withoutTaskFilterQueryTypes(
  query: string,
  types: FilterTokenType[],
): string {
  if (types.length === 0) return query;
  const removedTypes = new Set(types);
  return parseFilterQuery(query).tokens
    .filter((item) => !removedTypes.has(item.type))
    .map((item) => item.raw)
    .join(' ');
}

function token(type: string, value: string): string {
  const escaped = value.replaceAll('"', '\\"');
  return /\s/.test(escaped) ? `${type}:"${escaped}"` : `${type}:${escaped}`;
}

function clearLegacyTaskFilterParams(params: URLSearchParams): void {
  [
    'query',
    'filterQuery',
    'source',
    'sources',
    'listId',
    'listIds',
    'listGroupId',
    'tag',
    'tagSlugs',
    'projectId',
    'priority',
    'priorities',
    'status',
    'statuses',
    'quickFilter',
    'myDayDate',
    'completion',
    'openOnly',
    'ageMin',
    'ageMax',
  ].forEach((key) => params.delete(key));
}

function setArrayParam(
  params: URLSearchParams,
  values: string[],
  singular: string,
  plural: string,
): void {
  if (values.length === 1) params.set(singular, values[0]);
  if (values.length > 1) params.set(plural, values.join(','));
}

function collectDroppedValueIssues(value: Record<string, unknown>, issues: string[]): void {
  const priorities = stringArray(value.priorities, true);
  const statuses = stringArray(value.statuses, true);
  const invalidPriorities = priorities.filter((item) => !VALID_PRIORITIES.has(item));
  const invalidStatuses = statuses.filter((item) => !VALID_STATUSES.has(item));
  if (invalidPriorities.length) {
    issues.push(`Dropped unsupported priorities: ${invalidPriorities.join(', ')}`);
  }
  if (invalidStatuses.length) {
    issues.push(`Dropped unsupported statuses: ${invalidStatuses.join(', ')}`);
  }
}

function stringArray(value: unknown, lowercase = false): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? splitParam(value) : [];
  return [...new Set(values
    .filter((item): item is string => typeof item === 'string')
    .map((item) => lowercase ? item.trim().toLowerCase() : item.trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function splitParam(value: string | null | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? [];
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isoDateValue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
    ? value
    : null;
}

export function taskFilterContextForToday(
  date: string,
  completion: TaskFilterContext['completion'] = 'all',
): TaskFilterContext {
  return normalizeTaskFilterContext({
    quickFilter: 'myDay',
    myDayDate: date,
    completion,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface ReadonlyURLSearchParamsLike {
  get(name: string): string | null;
  toString(): string;
}
