import {
  and,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  not,
  notInArray,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import {
  connectorConfigs,
  hubProjects,
  projectPhaseItems,
  projectPhases,
  sourceLists,
  tags,
  taskProjects,
  taskTags,
  tasks,
} from '../schema';
import { parseFilterQuery, type FilterToken } from '@/lib/utils/parseFilterQuery';
import { isPlanningHorizon } from '@/lib/tasks/planning-horizon';
import { NOTIFICATION_ONLY_CONNECTOR_TYPES } from '@/lib/connectors/task-source-profiles';
import { NO_EFFORT_GROUP_LABEL } from '@/lib/tasks/task-grouping';
import {
  CLOSED_TASK_STATUSES,
  HIGH_PRIORITY_VALUES,
  SELF_ASSIGNED_CONNECTOR_TYPES,
  WAITING_MICRO_STATUSES,
  type InboxListEntry,
  type TaskFilterSpec,
  type TaskQuickFilter,
} from '@/lib/tasks/core/contracts';

/**
 * PostgreSQL dialect compiler for the canonical task filter.
 *
 * Deliberately a *sibling* of `src/db/persistence/sqlite-task-filter.ts`
 * rather than a shared generic query builder: the two dialects genuinely
 * differ (jsonb metadata needs an explicit `::text` cast for substring
 * matching, `IS <value>` null-safe equality is spelled
 * `IS NOT DISTINCT FROM`, `INSERT OR IGNORE` is `ON CONFLICT DO NOTHING`).
 * The shared thing is the `TaskFilterSpec` *input* and the observable result,
 * which the contract suite pins for both backends.
 */

export interface PostgresCanonicalTaskFilterInputs {
  readonly myDayTaskIds: readonly string[];
  readonly assignedGitHubUsernames: readonly string[];
  readonly inboxListEntries: readonly InboxListEntry[];
}

const PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

export function literalContainsPattern(value: string): string {
  return `%${value.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_')}%`;
}

function containsLiteral(column: SQLWrapper, value: string): SQL {
  return sql`${column} ILIKE ${literalContainsPattern(value)} ESCAPE '!'`;
}

/** `tasks.metadata` is `jsonb` on PostgreSQL, so substring matching needs text. */
const METADATA_TEXT = sql`${tasks.metadata}::text`;

export function getTaskSourceVisibilityConditions(): SQL[] {
  return [
    sql`${tasks.connectorInstanceId} NOT IN (
      SELECT ${connectorConfigs.id} FROM ${connectorConfigs}
      WHERE ${connectorConfigs.deletedAt} IS NOT NULL
    )`,
    notInArray(tasks.connectorType, [...NOTIFICATION_ONLY_CONNECTOR_TYPES]),
  ];
}

export function getTagSlugFilterCondition(tagSlug: string): SQL {
  return sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
    WHERE ${tags.slug} = ${tagSlug}
  )`;
}

export function getMultiTagFilterCondition(tagSlugs: string[]): SQL {
  if (tagSlugs.length === 0) return sql`1 = 0`;
  return sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
    WHERE ${inArray(tags.slug, tagSlugs)}
    GROUP BY ${taskTags.taskId}
    HAVING COUNT(DISTINCT ${tags.slug}) = ${tagSlugs.length}
  )`;
}

export function getAnyTagSlugFilterCondition(tagSlugs: string[]): SQL {
  if (tagSlugs.length === 0) return sql`1 = 0`;
  return sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
    WHERE ${or(inArray(tags.slug, tagSlugs), inArray(tags.name, tagSlugs))}
  )`;
}

export function getTagIdsFilterCondition(tagIds: string[]): SQL {
  if (tagIds.length === 0) return sql`1 = 0`;
  return sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    WHERE ${inArray(taskTags.tagId, tagIds)}
  )`;
}

export function getProjectFilterCondition(projectId: string): SQL {
  return sql`${tasks.id} IN (
    SELECT ${taskProjects.taskId} FROM ${taskProjects}
    WHERE ${taskProjects.projectId} = ${projectId}
  )`;
}

function getTagTextCondition(value: string): SQL {
  return sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
    WHERE ${or(containsLiteral(tags.name, value), containsLiteral(tags.slug, value))}
  )`;
}

function getCollectionSearchCondition(search: string): SQL {
  const stripped = search.startsWith('#') ? search.slice(1) : '';
  const conditions: SQL[] = [
    containsLiteral(tasks.title, search),
    containsLiteral(tasks.sourceId, search),
    containsLiteral(tasks.assignee, search),
    containsLiteral(tasks.sourceListName, search),
    containsLiteral(METADATA_TEXT, search),
    getTagTextCondition(search),
  ];
  if (/^\d+$/.test(stripped)) {
    conditions.push(
      sql`${tasks.sourceId} LIKE ${`%:${stripped}`}`,
      sql`${METADATA_TEXT} LIKE ${`%"issueNumber":${stripped}%`}`,
      sql`${METADATA_TEXT} LIKE ${`%"issueNumber": ${stripped}%`}`,
    );
  }
  return or(...conditions)!;
}

function getCollectionGroupCondition(spec: TaskFilterSpec): SQL | undefined {
  const group = spec.group;
  if (!group) return undefined;
  const value = group.value;
  if (group.mode === 'status') {
    if (value === 'Completed') return eq(tasks.status, 'done');
    if (value === 'Cancelled') return eq(tasks.status, 'cancelled');
    if (value === 'In Progress') return eq(tasks.status, 'in_progress');
    if (value === 'To Do') return notInArray(tasks.status, ['done', 'cancelled', 'in_progress']);
    return undefined;
  }
  if (group.mode === 'priority') {
    return value === 'none'
      ? or(isNull(tasks.priority), eq(tasks.priority, ''), eq(tasks.priority, 'none'))!
      : eq(tasks.priority, value);
  }
  if (group.mode === 'planningHorizon') {
    const byLabel = { Next: 'next', Soon: 'soon', Later: 'later', Someday: 'someday' } as const;
    return value === 'Not set'
      ? isNull(tasks.planningHorizon)
      : byLabel[value as keyof typeof byLabel]
        ? eq(tasks.planningHorizon, byLabel[value as keyof typeof byLabel])
        : sql`1 = 0`;
  }
  if (group.mode === 'source') {
    return value === 'local'
      ? or(isNull(tasks.connectorType), eq(tasks.connectorType, ''), eq(tasks.connectorType, 'local'))!
      : eq(tasks.connectorType, value);
  }
  if (group.mode === 'list') {
    return sql`COALESCE(
      NULLIF((SELECT COALESCE(NULLIF(${sourceLists.userDisplayName}, ''), NULLIF(${sourceLists.name}, ''))
        FROM ${sourceLists}
        WHERE ${sourceLists.connectorInstanceId} = ${tasks.connectorInstanceId}
          AND ${sourceLists.sourceId} = ${tasks.sourceListId} LIMIT 1), ''),
      NULLIF(${tasks.sourceListName}, ''), 'No List'
    ) = ${value}`;
  }
  if (group.mode === 'effort') {
    if (value === NO_EFFORT_GROUP_LABEL) return isNull(tasks.effort);
    const effort = Number(value);
    return Number.isInteger(effort) ? eq(tasks.effort, effort) : sql`1 = 0`;
  }
  if (group.mode === 'dueDate') {
    if (value === 'No Due Date') return or(isNull(tasks.dueDate), eq(tasks.dueDate, ''))!;
    if (value === 'Overdue') {
      return and(isNotNull(tasks.dueDate), not(eq(tasks.dueDate, '')), lt(tasks.dueDate, spec.today))!;
    }
    return eq(tasks.dueDate, value === 'Today' ? spec.today : value);
  }
  if (group.mode === 'tag') {
    if (value === 'Untagged') {
      return sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`;
    }
    return sql`${tasks.id} IN (
      SELECT ${taskTags.taskId} FROM ${taskTags}
      INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
      WHERE ${tags.name} = ${value}
    )`;
  }
  if (value === 'No Project') {
    return sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`;
  }
  const separator = value.lastIndexOf(' › ');
  if (separator < 0) return sql`1 = 0`;
  const projectName = value.slice(0, separator);
  const phaseName = value.slice(separator + 3);
  if (phaseName === 'Unphased') {
    return and(
      sql`${tasks.id} IN (
        SELECT ${taskProjects.taskId} FROM ${taskProjects}
        INNER JOIN ${hubProjects} ON ${taskProjects.projectId} = ${hubProjects.id}
        WHERE ${hubProjects.name} = ${projectName}
      )`,
      sql`${tasks.id} NOT IN (
        SELECT ${projectPhaseItems.taskId} FROM ${projectPhaseItems}
        INNER JOIN ${projectPhases} ON ${projectPhaseItems.phaseId} = ${projectPhases.id}
        INNER JOIN ${hubProjects} ON ${projectPhases.projectId} = ${hubProjects.id}
        WHERE ${hubProjects.name} = ${projectName}
      )`,
    );
  }
  return sql`${tasks.id} IN (
    SELECT ${projectPhaseItems.taskId} FROM ${projectPhaseItems}
    INNER JOIN ${projectPhases} ON ${projectPhaseItems.phaseId} = ${projectPhases.id}
    INNER JOIN ${hubProjects} ON ${projectPhases.projectId} = ${hubProjects.id}
    INNER JOIN ${taskProjects}
      ON ${taskProjects.taskId} = ${projectPhaseItems.taskId}
      AND ${taskProjects.projectId} = ${projectPhases.projectId}
    WHERE ${hubProjects.name} = ${projectName} AND ${projectPhases.name} = ${phaseName}
  )`;
}

export function getSourceListIdsCondition(values: string[]): SQL {
  const conditions = values.map((value) => {
    const separator = value.indexOf(':');
    if (separator < 0) return eq(tasks.sourceListId, value);
    return or(
      eq(tasks.sourceListId, value),
      and(
        eq(tasks.connectorInstanceId, value.slice(0, separator)),
        eq(tasks.sourceListId, value.slice(separator + 1)),
      ),
    )!;
  });
  return or(...conditions)!;
}

export function getSourceListGroupCondition(groupId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM ${sourceLists}
    WHERE ${sourceLists.groupId} = ${groupId}
      AND ${sourceLists.connectorInstanceId} = ${tasks.connectorInstanceId}
      AND ${sourceLists.sourceId} = ${tasks.sourceListId}
  )`;
}

export function getQuickFilterCondition(
  quickFilter: string | null,
  today: string,
  weekFromNow: string,
  myDayTaskIds: readonly string[],
  recentCutoff: string,
): SQL | undefined {
  if (quickFilter === 'overdue') return lt(tasks.dueDate, today);
  if (quickFilter === 'today') return eq(tasks.dueDate, today);
  if (quickFilter === 'noDate') return or(isNull(tasks.dueDate), eq(tasks.dueDate, ''));
  if (quickFilter === 'high') return inArray(tasks.priority, [...HIGH_PRIORITY_VALUES]);
  if (quickFilter === 'week') {
    return and(gte(tasks.dueDate, today), lte(tasks.dueDate, weekFromNow));
  }
  if (quickFilter === 'myDay') {
    if (myDayTaskIds.length === 0) return sql`1 = 0`;
    return inArray(tasks.id, [...myDayTaskIds]);
  }
  if (quickFilter === 'recentlyCreated') return gte(tasks.createdAt, recentCutoff);
  if (quickFilter === 'recentlyClosed') {
    return and(
      inArray(tasks.status, [...CLOSED_TASK_STATUSES]),
      gte(tasks.completedAt, recentCutoff),
    );
  }
  if (quickFilter === 'waiting') {
    return inArray(tasks.microStatus, [...WAITING_MICRO_STATUSES]);
  }
  return undefined;
}

export function getAssignedFilterCondition(
  githubUsernames: readonly string[],
): SQL | undefined {
  const conditions: SQL[] = SELF_ASSIGNED_CONNECTOR_TYPES.map(
    (connectorType) => eq(tasks.connectorType, connectorType),
  );

  if (githubUsernames.length > 0) {
    conditions.push(
      and(
        eq(tasks.connectorType, 'github-issues'),
        inArray(tasks.assignee, [...githubUsernames]),
      )!,
    );
  }

  conditions.push(
    and(
      notInArray(tasks.connectorType, [...SELF_ASSIGNED_CONNECTOR_TYPES, 'github-issues']),
      isNotNull(tasks.assignee),
    )!,
  );

  return or(...conditions);
}

export function getInboxFilterCondition(
  inboxLists: readonly InboxListEntry[],
): SQL | undefined {
  const conditions: SQL[] = [eq(tasks.connectorType, 'local')];

  for (const entry of inboxLists) {
    if (entry.sourceListId) {
      conditions.push(and(
        eq(tasks.connectorType, entry.connectorType),
        eq(tasks.sourceListId, entry.sourceListId),
      )!);
    } else if (entry.sourceListName) {
      conditions.push(and(
        eq(tasks.connectorType, entry.connectorType),
        eq(tasks.sourceListName, entry.sourceListName),
      )!);
    }
  }

  conditions.push(sql`${tasks.id} IN (
    SELECT ${taskTags.taskId} FROM ${taskTags}
    INNER JOIN ${tags} ON ${taskTags.tagId} = ${tags.id}
    WHERE ${tags.slug} = 'needs-triage'
  )`);

  return or(...conditions);
}

export function withCondition(
  baseWhere: SQL | undefined,
  condition: SQL | undefined,
): SQL | undefined {
  if (!condition) return baseWhere;
  return baseWhere ? and(baseWhere, condition) : condition;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function expandPriorityValues(values: string[]): string[] {
  const expanded = new Set<string>();

  for (const value of values) {
    const match = /^(>=|<=|>|<)?(critical|high|medium|low|none)$/.exec(value);
    if (!match) continue;
    const operator = match[1] || '=';
    const priority = match[2] as typeof PRIORITIES[number];
    const index = PRIORITIES.indexOf(priority);

    PRIORITIES.forEach((candidate, candidateIndex) => {
      if (
        operator === '=' && candidateIndex === index
        || operator === '>=' && candidateIndex <= index
        || operator === '>' && candidateIndex < index
        || operator === '<=' && candidateIndex >= index
        || operator === '<' && candidateIndex > index
      ) {
        expanded.add(candidate);
      }
    });
  }

  return [...expanded];
}

function getListTokenCondition(values: string[]): SQL {
  const namedValues = values.filter((value) => value !== 'none');
  const noListCondition = and(
    or(isNull(tasks.sourceListId), sql`trim(${tasks.sourceListId}) = ''`),
    or(isNull(tasks.sourceListName), sql`trim(${tasks.sourceListName}) = ''`),
  )!;
  if (namedValues.length === 0) return noListCondition;

  const displayNameMatches = or(...namedValues.map((value) =>
    sql`lower(COALESCE(NULLIF(trim(${sourceLists.userDisplayName}), ''), ${sourceLists.name})) LIKE ${literalContainsPattern(value.toLowerCase())} ESCAPE '!'`
  ))!;
  const authoritativeMatch = sql`EXISTS (
    SELECT 1 FROM ${sourceLists}
    WHERE ${sourceLists.connectorInstanceId} = ${tasks.connectorInstanceId}
      AND ${sourceLists.sourceId} = ${tasks.sourceListId}
      AND ${displayNameMatches}
  )`;
  const hasAuthoritativeList = sql`EXISTS (
    SELECT 1 FROM ${sourceLists}
    WHERE ${sourceLists.connectorInstanceId} = ${tasks.connectorInstanceId}
      AND ${sourceLists.sourceId} = ${tasks.sourceListId}
  )`;
  const denormalizedMatches = namedValues.map((value) =>
    and(isNotNull(tasks.sourceListName), containsLiteral(tasks.sourceListName, value))!
  );
  const fallbackMatches = and(not(hasAuthoritativeList), or(...denormalizedMatches)!)!;
  const namedCondition = or(authoritativeMatch, fallbackMatches)!;
  return values.includes('none') ? or(noListCondition, namedCondition)! : namedCondition;
}

function getNoAssigneeCondition(): SQL {
  return or(isNull(tasks.assignee), sql`trim(${tasks.assignee}) = ''`)!;
}

function getAssigneeTokenCondition(values: string[]): SQL {
  const conditions = values
    .filter((value) => value !== 'none')
    .map((value) => containsLiteral(tasks.assignee, value));
  if (values.includes('none')) conditions.push(getNoAssigneeCondition());
  return or(...conditions)!;
}

function getTagTokenCondition(values: string[]): SQL {
  const conditions: SQL[] = [];
  const namedValues = values.filter((value) => value !== 'none');
  if (namedValues.length > 0) conditions.push(getAnyTagSlugFilterCondition(namedValues));
  if (values.includes('none')) {
    conditions.push(sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`);
  }
  return conditions.length > 0 ? or(...conditions)! : sql`1 = 0`;
}

function getProjectTokenCondition(values: string[]): SQL {
  const conditions: SQL[] = [];
  const projectIds = values.filter((value) => value !== 'none');
  if (projectIds.length > 0) {
    conditions.push(sql`${tasks.id} IN (
      SELECT ${taskProjects.taskId} FROM ${taskProjects}
      WHERE ${inArray(taskProjects.projectId, projectIds)}
    )`);
  }
  if (values.includes('none')) {
    conditions.push(sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`);
  }
  return conditions.length > 0 ? or(...conditions)! : sql`1 = 0`;
}

function getPhaseTokenCondition(values: string[]): SQL {
  const conditions: SQL[] = [];
  const phaseIds = values.filter((value) => value !== 'none');
  if (phaseIds.length > 0) {
    conditions.push(sql`${tasks.id} IN (
      SELECT ${projectPhaseItems.taskId} FROM ${projectPhaseItems}
      WHERE ${inArray(projectPhaseItems.phaseId, phaseIds)}
    )`);
  }
  if (values.includes('none')) {
    conditions.push(
      sql`${tasks.id} NOT IN (SELECT ${projectPhaseItems.taskId} FROM ${projectPhaseItems})`,
    );
  }
  return conditions.length > 0 ? or(...conditions)! : sql`1 = 0`;
}

function getDueTokenCondition(value: string, today: string, weekFromNow: string): SQL {
  if (value === 'none') return isNull(tasks.dueDate);
  if (value === 'overdue') return sql`${tasks.dueDate} < ${today}`;
  if (value === 'today') return eq(tasks.dueDate, today);
  if (value === 'week') {
    return and(
      sql`${tasks.dueDate} >= ${today}`,
      sql`${tasks.dueDate} <= ${weekFromNow}`,
    )!;
  }
  if (value.startsWith('<')) return sql`${tasks.dueDate} < ${value.slice(1)}`;
  if (value.startsWith('>')) return sql`${tasks.dueDate} > ${value.slice(1)}`;
  return eq(tasks.dueDate, value);
}

function groupNegatedTokens(tokensToGroup: FilterToken[]) {
  const grouped = {
    title: [] as string[],
    tag: [] as string[],
    priority: [] as string[],
    horizon: [] as string[],
    status: [] as string[],
    source: [] as string[],
    list: [] as string[],
    listid: [] as string[],
    assignee: [] as string[],
    due: [] as string[],
    project: [] as string[],
    phase: [] as string[],
    disposition: [] as string[],
  };

  for (const token of tokensToGroup) {
    if (token.type !== 'text' && !grouped[token.type].includes(token.value)) {
      grouped[token.type].push(token.value);
    }
  }

  return grouped;
}

function isLocalDisposition(value: string): value is 'active' | 'handled' | 'dismissed' {
  return value === 'active' || value === 'handled' || value === 'dismissed';
}

export function compileFilterQueryConditions(
  filterQuery: string,
  today: string,
  weekFromNow: string,
): SQL[] {
  const parsed = parseFilterQuery(filterQuery);
  const conditions: SQL[] = [];
  const priorityTokens = unique(parsed.priorityTokens);
  const horizonTokens = unique(parsed.horizonTokens);
  const statusTokens = unique(parsed.statusTokens);
  const sourceTokens = unique(parsed.sourceTokens);
  const titleTokens = unique(parsed.titleTokens);
  const listTokens = unique(parsed.listTokens);
  const listIdTokens = unique(parsed.listIdTokens);
  const assigneeTokens = unique(parsed.assigneeTokens);
  const dueTokens = unique(parsed.dueTokens);
  const dispositionTokens = unique(parsed.dispositionTokens);
  const tagTokens = unique(parsed.tagTokens);
  const projectTokens = unique(parsed.projectTokens);
  const phaseTokens = unique(parsed.phaseTokens);
  const textTerms = unique(parsed.textTerms);
  const includedPriorities = expandPriorityValues(priorityTokens);

  if (priorityTokens.length > 0) {
    conditions.push(
      includedPriorities.length > 0
        ? inArray(tasks.priority, includedPriorities)
        : sql`1 = 0`,
    );
  }
  if (horizonTokens.length > 0) {
    const includesNone = horizonTokens.includes('none');
    const values = horizonTokens.filter((value) => (
      value === 'next' || value === 'soon' || value === 'later' || value === 'someday'
    )) as ('next' | 'soon' | 'later' | 'someday')[];
    conditions.push(or(
      ...(values.length > 0 ? [inArray(tasks.planningHorizon, values)] : []),
      ...(includesNone ? [isNull(tasks.planningHorizon)] : []),
    ) ?? sql`1 = 0`);
  }

  if (statusTokens.length > 0) conditions.push(inArray(tasks.status, statusTokens));
  if (sourceTokens.length > 0) conditions.push(inArray(tasks.connectorType, sourceTokens));
  if (titleTokens.length > 0) {
    conditions.push(or(...titleTokens.map((value) => containsLiteral(tasks.title, value)))!);
  }
  if (listTokens.length > 0) conditions.push(getListTokenCondition(listTokens));
  if (listIdTokens.length > 0) conditions.push(getSourceListIdsCondition(listIdTokens));
  if (assigneeTokens.length > 0) conditions.push(getAssigneeTokenCondition(assigneeTokens));
  if (dueTokens.length > 0) {
    conditions.push(
      or(...dueTokens.map((value) => getDueTokenCondition(value, today, weekFromNow)))!,
    );
  }
  if (dispositionTokens.length > 0) {
    const valid = dispositionTokens.filter(isLocalDisposition);
    conditions.push(valid.length > 0
      ? inArray(tasks.localDisposition, valid)
      : sql`1 = 0`);
  }
  if (tagTokens.length > 0) conditions.push(getTagTokenCondition(tagTokens));
  if (projectTokens.length > 0) conditions.push(getProjectTokenCondition(projectTokens));
  if (phaseTokens.length > 0) conditions.push(getPhaseTokenCondition(phaseTokens));

  for (const term of textTerms) {
    conditions.push(or(
      containsLiteral(tasks.title, term),
      containsLiteral(tasks.sourceId, term),
      containsLiteral(tasks.assignee, term),
      containsLiteral(tasks.sourceListName, term),
      containsLiteral(METADATA_TEXT, term),
      getTagTextCondition(term),
    )!);
  }

  const negatedByType = groupNegatedTokens(parsed.negatedTokens);
  const excludedPriorities = expandPriorityValues(negatedByType.priority);
  if (excludedPriorities.length > 0) {
    conditions.push(notInArray(tasks.priority, excludedPriorities));
  }
  for (const value of negatedByType.horizon) {
    if (value === 'none') {
      conditions.push(isNotNull(tasks.planningHorizon));
    } else if (isPlanningHorizon(value)) {
      conditions.push(or(isNull(tasks.planningHorizon), not(eq(tasks.planningHorizon, value)))!);
    }
  }
  if (negatedByType.status.length > 0) {
    conditions.push(notInArray(tasks.status, negatedByType.status));
  }
  if (negatedByType.source.length > 0) {
    conditions.push(notInArray(tasks.connectorType, negatedByType.source));
  }
  for (const value of negatedByType.title) {
    conditions.push(not(containsLiteral(tasks.title, value)));
  }
  if (negatedByType.list.includes('none')) {
    conditions.push(not(getListTokenCondition(['none'])));
  }
  const excludedLists = negatedByType.list.filter((value) => value !== 'none');
  if (excludedLists.length > 0) {
    conditions.push(or(
      and(isNull(tasks.sourceListId), isNull(tasks.sourceListName)),
      not(getListTokenCondition(excludedLists)),
    )!);
  }
  if (negatedByType.listid.length > 0) {
    conditions.push(or(
      isNull(tasks.sourceListId),
      not(getSourceListIdsCondition(negatedByType.listid)),
    )!);
  }
  if (negatedByType.assignee.includes('none')) {
    conditions.push(not(getNoAssigneeCondition()));
  }
  for (const value of negatedByType.assignee.filter((value) => value !== 'none')) {
    conditions.push(or(isNull(tasks.assignee), not(containsLiteral(tasks.assignee, value)))!);
  }
  for (const value of negatedByType.due) {
    conditions.push(
      value === 'none'
        ? isNotNull(tasks.dueDate)
        : or(isNull(tasks.dueDate), not(getDueTokenCondition(value, today, weekFromNow)))!,
    );
  }
  if (negatedByType.tag.includes('none')) {
    conditions.push(sql`${tasks.id} IN (SELECT ${taskTags.taskId} FROM ${taskTags})`);
  }
  const excludedTags = negatedByType.tag.filter((value) => value !== 'none');
  if (excludedTags.length > 0) {
    conditions.push(not(getAnyTagSlugFilterCondition(excludedTags)));
  }
  if (negatedByType.project.length > 0) {
    conditions.push(not(getProjectTokenCondition(negatedByType.project)));
  }
  if (negatedByType.phase.length > 0) {
    conditions.push(not(getPhaseTokenCondition(negatedByType.phase)));
  }
  const excludedDispositions = negatedByType.disposition.filter(isLocalDisposition);
  if (excludedDispositions.length > 0) {
    conditions.push(notInArray(tasks.localDisposition, excludedDispositions));
  }

  return conditions;
}

export interface CompiledPostgresTaskFilter {
  readonly conditions: SQL[];
  readonly baseWhere: SQL | undefined;
  readonly quickFilterCondition: SQL | undefined;
  readonly taskWhere: SQL | undefined;
}

export function compileQuickFilterCondition(
  quickFilter: TaskQuickFilter | null,
  spec: TaskFilterSpec,
  inputs: PostgresCanonicalTaskFilterInputs,
): SQL | undefined {
  if (quickFilter === 'assigned') {
    return getAssignedFilterCondition(inputs.assignedGitHubUsernames);
  }
  if (quickFilter === 'inbox') {
    return getInboxFilterCondition(inputs.inboxListEntries);
  }
  return getQuickFilterCondition(
    quickFilter,
    spec.today,
    spec.weekFromNow,
    inputs.myDayTaskIds,
    spec.recentCutoff,
  );
}

export function compileCanonicalTaskFilter(
  spec: TaskFilterSpec,
  inputs: PostgresCanonicalTaskFilterInputs,
): CompiledPostgresTaskFilter {
  const conditions = getTaskSourceVisibilityConditions();

  if (spec.connectorTypes.length === 1) {
    conditions.push(eq(tasks.connectorType, spec.connectorTypes[0]));
  } else if (spec.connectorTypes.length > 1) {
    conditions.push(inArray(tasks.connectorType, [...spec.connectorTypes]));
  }

  if (spec.statuses.length === 1) {
    conditions.push(eq(tasks.status, spec.statuses[0]));
  } else if (spec.statuses.length > 1) {
    conditions.push(inArray(tasks.status, [...spec.statuses]));
  }

  if (spec.priorities.length === 1) {
    conditions.push(eq(tasks.priority, spec.priorities[0]));
  } else if (spec.priorities.length > 1) {
    conditions.push(inArray(tasks.priority, [...spec.priorities]));
  }

  const horizons = [...spec.planningHorizons] as ('next' | 'soon' | 'later' | 'someday')[];
  if (horizons.length === 1) {
    conditions.push(eq(tasks.planningHorizon, horizons[0]));
  } else if (horizons.length > 1) {
    conditions.push(inArray(tasks.planningHorizon, horizons));
  } else if (spec.planningHorizonIsNull) {
    conditions.push(isNull(tasks.planningHorizon));
  }

  if (spec.localDispositions.length === 1) {
    conditions.push(eq(tasks.localDisposition, spec.localDispositions[0]));
  } else if (spec.localDispositions.length > 1) {
    conditions.push(inArray(tasks.localDisposition, [...spec.localDispositions]));
  }

  if (spec.excludeClosedStatuses) {
    conditions.push(notInArray(tasks.status, [...CLOSED_TASK_STATUSES]));
  }
  if (spec.parentOnly) conditions.push(isNull(tasks.parentId));
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
      ...compileFilterQueryConditions(spec.filterQuery, spec.today, spec.weekFromNow),
    );
  }
  if (spec.tagSlug) conditions.push(getTagSlugFilterCondition(spec.tagSlug));
  if (spec.tagSlugs.length > 0) {
    conditions.push(getMultiTagFilterCondition([...spec.tagSlugs]));
  }
  if (spec.projectId) conditions.push(getProjectFilterCondition(spec.projectId));
  if (spec.search) conditions.push(getCollectionSearchCondition(spec.search));
  if (spec.effort !== undefined && spec.effort !== null) {
    conditions.push(Number.isNaN(spec.effort) ? sql`1 = 0` : eq(tasks.effort, spec.effort));
  }
  if (spec.tagIds?.length) conditions.push(getTagIdsFilterCondition([...spec.tagIds]));
  if (spec.noProject) {
    conditions.push(sql`${tasks.id} NOT IN (SELECT ${taskProjects.taskId} FROM ${taskProjects})`);
  }
  const groupCondition = getCollectionGroupCondition(spec);
  if (groupCondition) conditions.push(groupCondition);

  const quickFilterCondition = compileQuickFilterCondition(spec.quickFilter, spec, inputs);
  const baseWhere = and(...conditions);

  return {
    conditions,
    baseWhere,
    quickFilterCondition,
    taskWhere: withCondition(baseWhere, quickFilterCondition),
  };
}

/** The `connector_configs` predicate used to read GitHub identity evidence. */
export function enabledGitHubConnectorCondition(): SQL {
  return and(
    eq(connectorConfigs.type, 'github-issues'),
    eq(connectorConfigs.enabled, true),
    isNull(connectorConfigs.deletedAt),
  )!;
}
