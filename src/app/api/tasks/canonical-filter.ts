import { and, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import db from '@/db';
import { myDayItems, tasks } from '@/db/schema';
import {
  getMultiTagFilterCondition,
  getProjectFilterCondition,
  getTagSlugFilterCondition,
} from './filter-factory';
import {
  getFilterQueryConditions,
  getSourceListGroupCondition,
  getSourceListIdsCondition,
} from './filter-query';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';
import type { LocalDisposition } from '@/types';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import {
  getAssignedFilterCondition,
  getDateBounds,
  getInboxFilterCondition,
  getQuickFilterCondition,
  withCondition,
} from './query-builder';
import { normalizedCsv } from './query-input';

const VALID_STATUSES = new Set(['todo', 'in_progress', 'done', 'cancelled']);
const VALID_PRIORITIES = new Set(['critical', 'high', 'medium', 'low', 'none']);
const VALID_LOCAL_DISPOSITIONS = new Set(['active', 'handled', 'dismissed']);

export interface CanonicalTaskFilterConditions {
  conditions: SQL[];
  openOnly: boolean;
  today: string;
  weekFromNow: string;
  myDayTaskIds: string[];
  quickFilterCondition: SQL | undefined;
}

export function getTaskSourceVisibilityConditions(): SQL[] {
  return [
    sql`${tasks.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`,
    notInArray(tasks.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
  ];
}

export async function buildCanonicalTaskFilterConditions(
  searchParams: URLSearchParams,
): Promise<CanonicalTaskFilterConditions> {
  const conditions = getTaskSourceVisibilityConditions();
  const { today, weekFromNow } = getDateBounds();
  const quickFilter = searchParams.get('quickFilter');
  const myDayDate = searchParams.get('myDayDate');
  const effectiveMyDayDate = myDayDate && /^\d{4}-\d{2}-\d{2}$/.test(myDayDate)
    ? myDayDate
    : today;
  const myDayRows = await db
    .select({ taskId: myDayItems.taskId })
    .from(myDayItems)
    .where(eq(myDayItems.date, effectiveMyDayDate));
  const myDayTaskIds = myDayRows.map((row) => row.taskId);
  const filterQuery = searchParams.get('filterQuery')?.trim();
  const hasDispositionQuery = Boolean(
    filterQuery
    && parseFilterQuery(filterQuery).tokens.some(
      (token) => token.type === 'disposition' && isLocalDisposition(token.value),
    ),
  );

  const sources = normalizedCsv(searchParams, 'sources', VALID_VALUE);
  const source = searchParams.get('source');
  if (sources.length) conditions.push(inArray(tasks.connectorType, sources));
  else if (source) conditions.push(eq(tasks.connectorType, source));

  const statuses = normalizedCsv(searchParams, 'statuses', VALID_STATUSES);
  const status = searchParams.get('status');
  if (statuses.length) conditions.push(inArray(tasks.status, statuses));
  else if (status && VALID_STATUSES.has(status)) conditions.push(eq(tasks.status, status));

  const priorities = normalizedCsv(searchParams, 'priorities', VALID_PRIORITIES);
  const priority = searchParams.get('priority');
  if (priorities.length) conditions.push(inArray(tasks.priority, priorities));
  else if (priority && VALID_PRIORITIES.has(priority)) conditions.push(eq(tasks.priority, priority));

  const localDispositions = normalizedCsv(
    searchParams,
    'localDispositions',
    VALID_LOCAL_DISPOSITIONS,
  ).filter(isLocalDisposition);
  const localDisposition = searchParams.get('localDisposition');
  if (localDispositions.length) {
    conditions.push(inArray(tasks.localDisposition, localDispositions));
  } else if (localDisposition && isLocalDisposition(localDisposition)) {
    conditions.push(eq(tasks.localDisposition, localDisposition));
  } else if (localDisposition !== 'all' && !hasDispositionQuery) {
    conditions.push(eq(tasks.localDisposition, 'active'));
  }

  const openOnly = searchParams.get('openOnly') === 'true'
    && quickFilter !== 'recentlyClosed';
  if (openOnly && !statuses.length && !status) {
    conditions.push(notInArray(tasks.status, ['done', 'cancelled']));
  }
  if (searchParams.get('parentOnly') === 'true') {
    conditions.push(isNull(tasks.parentId));
  }

  const listIds = normalizedCsv(searchParams, 'listIds', VALID_VALUE);
  const listId = searchParams.get('listId');
  if (listIds.length) {
    conditions.push(getSourceListIdsCondition(listIds));
  } else if (listId) {
    conditions.push(getSourceListIdsCondition([listId]));
  }

  const listGroupId = searchParams.get('listGroupId');
  if (listGroupId) {
    conditions.push(getSourceListGroupCondition(listGroupId));
  }

  const ageMin = nonNegativeInteger(searchParams.get('ageMin'));
  if (ageMin !== null) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ageMin);
    conditions.push(sql`${tasks.createdAt} <= ${cutoff.toISOString()}`);
  }
  const ageMax = nonNegativeInteger(searchParams.get('ageMax'));
  if (ageMax !== null) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - ageMax);
    conditions.push(sql`${tasks.createdAt} >= ${cutoff.toISOString()}`);
  }

  if (filterQuery) {
    conditions.push(...await getFilterQueryConditions(filterQuery, today, weekFromNow));
  }

  const tagSlug = searchParams.get('tag');
  if (tagSlug) {
    conditions.push(getTagSlugFilterCondition(tagSlug));
  }
  const tagSlugs = normalizedCsv(searchParams, 'tagSlugs', VALID_VALUE);
  if (tagSlugs.length) {
    conditions.push(getMultiTagFilterCondition(tagSlugs));
  }

  const projectId = searchParams.get('projectId');
  if (projectId) {
    conditions.push(getProjectFilterCondition(projectId));
  }

  const quickFilterCondition = quickFilter === 'assigned'
    ? await getAssignedFilterCondition()
    : quickFilter === 'inbox'
      ? await getInboxFilterCondition()
      : getQuickFilterCondition(quickFilter, today, weekFromNow, myDayTaskIds);

  return {
    conditions,
    openOnly,
    today,
    weekFromNow,
    myDayTaskIds,
    quickFilterCondition,
  };
}

export async function getCanonicalTaskFilterWhere(searchParams: URLSearchParams) {
  const canonical = await buildCanonicalTaskFilterConditions(searchParams);
  const baseWhere = and(...canonical.conditions);
  return {
    ...canonical,
    baseWhere,
    taskWhere: withCondition(baseWhere, canonical.quickFilterCondition),
  };
}

const VALID_VALUE = { has: (value: string) => Boolean(value) };

function nonNegativeInteger(value: string | null): number | null {
  if (value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isLocalDisposition(value: string): value is LocalDisposition {
  return VALID_LOCAL_DISPOSITIONS.has(value);
}
