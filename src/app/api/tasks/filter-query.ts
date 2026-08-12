import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  not,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import db from '@/db';
import {
  projectPhaseItems,
  sourceLists,
  tags,
  taskProjects,
  taskTags,
  tasks,
} from '@/db/schema';
import { parseFilterQuery, type FilterToken } from '@/lib/utils/parseFilterQuery';
import { getAnyTagSlugFilterCondition } from './filter-factory';
import {
  containsLiteral,
  literalContainsPattern,
  unique,
} from './query-input';

const PRIORITIES = ['critical', 'high', 'medium', 'low', 'none'] as const;

export async function getFilterQueryConditions(
  filterQuery: string,
  today: string,
  weekFromNow: string,
): Promise<SQL[]> {
  const parsed = parseFilterQuery(filterQuery);
  const conditions: SQL[] = [];
  const priorityTokens = unique(parsed.priorityTokens);
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
        : sql`1 = 0`
    );
  }

  if (statusTokens.length > 0) {
    conditions.push(inArray(tasks.status, statusTokens));
  }
  if (sourceTokens.length > 0) {
    conditions.push(inArray(tasks.connectorType, sourceTokens));
  }
  if (titleTokens.length > 0) {
    conditions.push(or(...titleTokens.map((value) => containsLiteral(tasks.title, value)))!);
  }
  if (listTokens.length > 0) {
    conditions.push(getListTokenCondition(listTokens));
  }
  if (listIdTokens.length > 0) {
    conditions.push(getSourceListIdsCondition(listIdTokens));
  }
  if (assigneeTokens.length > 0) {
    conditions.push(getAssigneeTokenCondition(assigneeTokens));
  }
  if (dueTokens.length > 0) {
    conditions.push(or(...dueTokens.map((value) => getDueTokenCondition(value, today, weekFromNow)))!);
  }
  if (dispositionTokens.length > 0) {
    const valid = dispositionTokens.filter(isLocalDisposition);
    conditions.push(valid.length > 0
      ? inArray(tasks.localDisposition, valid)
      : sql`1 = 0`);
  }

  if (tagTokens.length > 0) {
    conditions.push(getTagTokenCondition(tagTokens));
  }
  if (projectTokens.length > 0) {
    conditions.push(getProjectTokenCondition(projectTokens));
  }
  if (phaseTokens.length > 0) {
    conditions.push(getPhaseTokenCondition(phaseTokens));
  }

  for (const term of textTerms) {
    const searchConditions: SQL[] = [
      containsLiteral(tasks.title, term),
      containsLiteral(tasks.sourceId, term),
      containsLiteral(tasks.assignee, term),
      containsLiteral(tasks.sourceListName, term),
      containsLiteral(tasks.metadata, term),
      getTagTextCondition(term),
    ];
    conditions.push(or(...searchConditions)!);
  }

  const negatedByType = groupNegatedTokens(parsed.negatedTokens);
  const excludedPriorities = expandPriorityValues(negatedByType.priority);
  if (excludedPriorities.length > 0) {
    conditions.push(notInArray(tasks.priority, excludedPriorities));
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
    const positiveListCondition = getListTokenCondition(excludedLists);
    conditions.push(or(
      and(isNull(tasks.sourceListId), isNull(tasks.sourceListName)),
      not(positiveListCondition),
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
        : or(isNull(tasks.dueDate), not(getDueTokenCondition(value, today, weekFromNow)))!
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

function getAssigneeTokenCondition(values: string[]): SQL {
  const conditions = values
    .filter((value) => value !== 'none')
    .map((value) => containsLiteral(tasks.assignee, value));
  if (values.includes('none')) conditions.push(getNoAssigneeCondition());
  return or(...conditions)!;
}

function getNoAssigneeCondition(): SQL {
  return or(isNull(tasks.assignee), sql`trim(${tasks.assignee}) = ''`)!;
}

function getTagTokenCondition(values: string[]): SQL {
  const conditions: SQL[] = [];
  const namedValues = values.filter((value) => value !== 'none');
  if (namedValues.length > 0) {
    conditions.push(getAnyTagSlugFilterCondition(namedValues));
  }
  if (values.includes('none')) {
    conditions.push(sql`${tasks.id} NOT IN (SELECT ${taskTags.taskId} FROM ${taskTags})`);
  }
  return conditions.length > 0 ? or(...conditions)! : sql`1 = 0`;
}

function getProjectTokenCondition(values: string[]): SQL {
  const conditions: SQL[] = [];
  const projectIds = values.filter((value) => value !== 'none');
  if (projectIds.length > 0) {
    const matchingTasks = db
      .select({ taskId: taskProjects.taskId })
      .from(taskProjects)
      .where(inArray(taskProjects.projectId, projectIds));
    conditions.push(inArray(tasks.id, matchingTasks));
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
    const matchingTasks = db
      .select({ taskId: projectPhaseItems.taskId })
      .from(projectPhaseItems)
      .where(inArray(projectPhaseItems.phaseId, phaseIds));
    conditions.push(inArray(tasks.id, matchingTasks));
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
      sql`${tasks.dueDate} <= ${weekFromNow}`
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

function getTagTextCondition(value: string): SQL {
  const matchingTasks = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .innerJoin(tags, eq(taskTags.tagId, tags.id))
    .where(or(containsLiteral(tags.name, value), containsLiteral(tags.slug, value)));
  return inArray(tasks.id, matchingTasks);
}

function isLocalDisposition(value: string): value is 'active' | 'handled' | 'dismissed' {
  return value === 'active' || value === 'handled' || value === 'dismissed';
}
