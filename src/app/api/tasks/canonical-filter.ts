import { and, eq, inArray, isNull, notInArray, sql, type SQL } from 'drizzle-orm';
import { tasks } from '@/db/schema';
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
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import {
  getAssignedFilterCondition,
  getDateBounds,
  getInboxFilterCondition,
  getQuickFilterCondition,
  withCondition,
} from './query-builder';
import { normalizedCsv } from './query-input';
import { getLocalDaysFromNow } from '@/lib/utils/date';
import { buildTaskFilterSpec } from '@/lib/tasks/core/filter-spec';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type { TaskFilterSpec } from '@/lib/tasks/core/contracts';

/**
 * Canonical task filter entry point.
 *
 * Backend-neutral as of L04 in the sense that matters for the migration: this
 * module no longer opens a database. Request input is parsed into a portable
 * `TaskFilterSpec` by `@/lib/tasks/core/filter-spec`, and the only stored
 * input the assembly still needs (My Day membership) is read through the
 * task-core `TaskFilterInputRepository`.
 *
 * The Drizzle predicates it returns are a *compatibility seam* for the task
 * route handlers that have not been migrated yet (L05/L07) — no predicate ever
 * crosses a task-core contract. The portable equivalent of this assembly lives
 * in each adapter (`compileCanonicalTaskFilter`) and is pinned for both
 * backends by `tests/contracts/task-core.contract.ts`; this legacy assembly is
 * pinned by `tests/api/task-attribute-filters.test.ts`.
 */

export interface CanonicalTaskFilterConditions {
  conditions: SQL[];
  openOnly: boolean;
  today: string;
  weekFromNow: string;
  myDayTaskIds: string[];
  quickFilterCondition: SQL | undefined;
  /** The portable filter description this assembly was derived from. */
  spec: TaskFilterSpec;
}

export function getTaskSourceVisibilityConditions(): SQL[] {
  return [
    sql`${tasks.connectorInstanceId} NOT IN (SELECT id FROM connector_configs WHERE deleted_at IS NOT NULL)`,
    notInArray(tasks.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
  ];
}

/** Parses request input into the portable, backend-neutral filter spec. */
export function buildCanonicalTaskFilterSpec(
  searchParams: URLSearchParams,
): TaskFilterSpec {
  // The date boundaries deliberately come from `getDateBounds()` rather than
  // straight from `@/lib/utils/date`, preserving the exact clock seam the
  // legacy route helpers (and their tests) already depend on.
  const { today, weekFromNow } = getDateBounds();
  return buildTaskFilterSpec(searchParams, {
    readCsv: normalizedCsv,
    clock: { today, weekFromNow, recentCutoff: getLocalDaysFromNow(-7) },
  });
}

export async function buildCanonicalTaskFilterConditions(
  searchParams: URLSearchParams,
): Promise<CanonicalTaskFilterConditions> {
  const spec = buildCanonicalTaskFilterSpec(searchParams);
  const conditions = getTaskSourceVisibilityConditions();
  const { filterInputs } = await getTaskCorePersistence();
  const myDayTaskIds = [...await filterInputs.listMyDayTaskIds(spec.myDayDate)];

  if (spec.connectorTypes.length > 1) {
    conditions.push(inArray(tasks.connectorType, [...spec.connectorTypes]));
  } else if (spec.connectorTypes.length === 1) {
    conditions.push(eq(tasks.connectorType, spec.connectorTypes[0]));
  }

  if (spec.statuses.length > 1) {
    conditions.push(inArray(tasks.status, [...spec.statuses]));
  } else if (spec.statuses.length === 1) {
    conditions.push(eq(tasks.status, spec.statuses[0]));
  }

  if (spec.priorities.length > 1) {
    conditions.push(inArray(tasks.priority, [...spec.priorities]));
  } else if (spec.priorities.length === 1) {
    conditions.push(eq(tasks.priority, spec.priorities[0]));
  }

  const horizons = [...spec.planningHorizons] as ('next' | 'soon' | 'later' | 'someday')[];
  if (horizons.length > 1) {
    conditions.push(inArray(tasks.planningHorizon, horizons));
  } else if (horizons.length === 1) {
    conditions.push(eq(tasks.planningHorizon, horizons[0]));
  } else if (spec.planningHorizonIsNull) {
    conditions.push(isNull(tasks.planningHorizon));
  }

  if (spec.localDispositions.length > 1) {
    conditions.push(inArray(tasks.localDisposition, [...spec.localDispositions]));
  } else if (spec.localDispositions.length === 1) {
    conditions.push(eq(tasks.localDisposition, spec.localDispositions[0]));
  }

  if (spec.excludeClosedStatuses) {
    conditions.push(notInArray(tasks.status, ['done', 'cancelled']));
  }
  if (spec.parentOnly) {
    conditions.push(isNull(tasks.parentId));
  }

  if (spec.sourceListIds.length > 0) {
    conditions.push(getSourceListIdsCondition([...spec.sourceListIds]));
  }
  if (spec.sourceListGroupId) {
    conditions.push(getSourceListGroupCondition(spec.sourceListGroupId));
  }

  if (spec.createdAtMax !== null) {
    conditions.push(sql`${tasks.createdAt} <= ${spec.createdAtMax}`);
  }
  if (spec.createdAtMin !== null) {
    conditions.push(sql`${tasks.createdAt} >= ${spec.createdAtMin}`);
  }

  if (spec.filterQuery) {
    conditions.push(
      ...await getFilterQueryConditions(spec.filterQuery, spec.today, spec.weekFromNow),
    );
  }

  if (spec.tagSlug) {
    conditions.push(getTagSlugFilterCondition(spec.tagSlug));
  }
  if (spec.tagSlugs.length > 0) {
    conditions.push(getMultiTagFilterCondition([...spec.tagSlugs]));
  }
  if (spec.projectId) {
    conditions.push(getProjectFilterCondition(spec.projectId));
  }

  const quickFilterCondition = spec.quickFilter === 'assigned'
    ? await getAssignedFilterCondition()
    : spec.quickFilter === 'inbox'
      ? await getInboxFilterCondition()
      : getQuickFilterCondition(
          spec.quickFilter,
          spec.today,
          spec.weekFromNow,
          myDayTaskIds,
        );

  return {
    conditions,
    openOnly: spec.openOnly,
    today: spec.today,
    weekFromNow: spec.weekFromNow,
    myDayTaskIds,
    quickFilterCondition,
    spec,
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
