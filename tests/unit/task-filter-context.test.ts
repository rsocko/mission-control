import { describe, expect, it } from 'vitest';
import {
  EMPTY_TASK_FILTER_CONTEXT,
  TASK_FILTER_CONTEXT_PARAM,
  clearTaskFilterContextFromSearchParams,
  countTaskFilters,
  describeTaskFilterCriteria,
  hydrateTaskFilterContext,
  migrateLegacyUniverseFilters,
  normalizeTaskFilterContext,
  parseTaskFilterContext,
  removeTaskFilterCriterion,
  serializeTaskFilterContext,
  setTaskFilterContextInSearchParams,
  taskFilterContextFromDashboard,
  taskFilterContextFromSavedView,
  taskFilterContextForToday,
  taskFilterContextToDashboard,
  taskFilterContextToSavedView,
  taskFilterContextToTaskQuery,
  updateTaskFilterContext,
} from '@/lib/task-filter-context';
import { parseFilterQuery } from '@/lib/utils/parseFilterQuery';

describe('task filter context', () => {
  it('normalizes set-like criteria and drops unsupported enum values', () => {
    expect(normalizeTaskFilterContext({
      query: '  priority:HIGH title:"Release Train"  ',
      sources: [' GitHub-Issues ', 'github-issues'],
      listIds: ['list-b', 'list-a', 'list-b'],
      tagSlugs: ['Frontend', 'backend'],
      priorities: ['HIGH', 'future'],
      statuses: ['done', 'unknown'],
      completion: 'all',
      ageMinDays: '7',
      ageMaxDays: -1,
    })).toEqual({
      ...EMPTY_TASK_FILTER_CONTEXT,
      query: 'priority:HIGH title:"Release Train"',
      sources: ['github-issues'],
      listIds: ['list-a', 'list-b'],
      tagSlugs: ['backend', 'frontend'],
      priorities: ['high'],
      statuses: ['done'],
      completion: 'all',
      ageMinDays: 7,
    });
  });

  it('serializes deterministically and preserves rich query semantics', () => {
    const context = normalizeTaskFilterContext({
      query: 'title:"Hello World" -tag:wontfix NOT priority:low free-text',
      sources: ['todoist', 'github-issues'],
      statuses: ['todo'],
    });

    const serialized = serializeTaskFilterContext(context);
    const hydrated = parseTaskFilterContext(serialized);

    expect(serializeTaskFilterContext(hydrated.context)).toBe(serialized);
    expect(parseFilterQuery(hydrated.context.query).tokens.map((token) => ({
      type: token.type,
      value: token.value,
      negated: token.negated,
    }))).toEqual(parseFilterQuery(context.query).tokens.map((token) => ({
      type: token.type,
      value: token.value,
      negated: token.negated,
    })));
  });

  it('reports stale values instead of silently retaining them', () => {
    const hydrated = parseTaskFilterContext(JSON.stringify({
      version: 1,
      priorities: ['high', 'obsolete'],
      statuses: ['todo', 'archived'],
    }));

    expect(hydrated.context.priorities).toEqual(['high']);
    expect(hydrated.context.statuses).toEqual(['todo']);
    expect(hydrated.issues).toEqual([
      'Dropped unsupported priorities: obsolete',
      'Dropped unsupported statuses: archived',
    ]);
  });

  it('round trips through a URL while preserving unrelated presentation params', () => {
    const original = new URLSearchParams('dimensions=tags,project&camera=120,80&source=legacy');
    const context = normalizeTaskFilterContext({
      query: 'due:today',
      tagSlugs: ['backend', 'urgent'],
      completion: 'all',
    });

    const encoded = setTaskFilterContextInSearchParams(original, context);
    const hydration = hydrateTaskFilterContext(encoded);

    expect(encoded.get('dimensions')).toBe('tags,project');
    expect(encoded.get('camera')).toBe('120,80');
    expect(encoded.get('source')).toBeNull();
    expect(encoded.has(TASK_FILTER_CONTEXT_PARAM)).toBe(true);
    expect(hydration).toEqual({ context, source: 'canonical', issues: [] });

    const cleared = clearTaskFilterContextFromSearchParams(encoded);
    expect(cleared.toString()).toBe('dimensions=tags%2Cproject&camera=120%2C80');
  });

  it('hydrates legacy task URLs when no canonical payload exists', () => {
    const hydration = hydrateTaskFilterContext(new URLSearchParams(
      'source=github-issues&listId=backlog&tagSlugs=api,urgent'
      + '&priorities=high,critical&filterQuery=assignee%3Aocto-org&openOnly=false',
    ));

    expect(hydration.source).toBe('legacy');
    expect(hydration.context).toMatchObject({
      query: 'assignee:octo-org',
      sources: ['github-issues'],
      listIds: ['backlog'],
      tagSlugs: ['api', 'urgent'],
      priorities: ['critical', 'high'],
      completion: 'all',
    });
  });

  it('gives the canonical payload precedence over contradictory legacy params', () => {
    const canonical = normalizeTaskFilterContext({ sources: ['todoist'] });
    const params = new URLSearchParams({
      source: 'github-issues',
      [TASK_FILTER_CONTEXT_PARAM]: serializeTaskFilterContext(canonical),
    });

    expect(hydrateTaskFilterContext(params).context.sources).toEqual(['todoist']);
  });

  it('returns an explicit issue for malformed or unsupported payloads', () => {
    expect(parseTaskFilterContext('{').issues).toEqual(['Invalid task filter context']);
    expect(parseTaskFilterContext('{"version":2}').issues).toEqual([
      'Unsupported task filter context version',
    ]);
  });

  it('converts Dashboard state to and from the canonical context', () => {
    const dashboard = {
      sourceFilter: 'github-issues',
      listFilter: 'backlog',
      listGroupFilter: 'work',
      tagFilter: ['urgent', 'api'],
      quickFilter: 'overdue',
      projectFilter: 'project-1',
      priorityFilter: ['high'],
      statusFilter: ['todo'],
      textFilter: 'title:"release train"',
      showCompleted: true,
      myDayDate: null,
      ageMinDays: 30,
      ageMaxDays: 90,
    };

    const context = taskFilterContextFromDashboard(dashboard);

    expect(taskFilterContextToDashboard(context)).toEqual({
      ...dashboard,
      tagFilter: ['api', 'urgent'],
    });
    expect(context.ageMinDays).toBe(30);
    expect(context.ageMaxDays).toBe(90);
  });

  it('moves multi-source context into the existing rich query for Dashboard', () => {
    const dashboard = taskFilterContextToDashboard(normalizeTaskFilterContext({
      query: 'due:today',
      sources: ['todoist', 'github-issues'],
    }));

    expect(dashboard.sourceFilter).toBeNull();
    expect(parseFilterQuery(dashboard.textFilter).sourceTokens).toEqual([
      'github-issues',
      'todoist',
    ]);
    expect(parseFilterQuery(dashboard.textFilter).dueTokens).toEqual(['today']);
  });

  it('preserves multi-list context as exact rich-query tokens for Dashboard', () => {
    const dashboard = taskFilterContextToDashboard(normalizeTaskFilterContext({
      listIds: ['account-a:backlog', 'account-b:backlog'],
    }));

    expect(dashboard.listFilter).toBeNull();
    expect(parseFilterQuery(dashboard.textFilter).listIdTokens).toEqual([
      'account-a:backlog',
      'account-b:backlog',
    ]);
  });

  it('removes conflicting rich tokens when explicit Dashboard controls supersede them', () => {
    const context = taskFilterContextFromDashboard({
      sourceFilter: 'linear',
      listFilter: null,
      listGroupFilter: null,
      tagFilter: [],
      quickFilter: null,
      projectFilter: null,
      priorityFilter: ['critical'],
      statusFilter: [],
      textFilter: 'source:github-issues source:todoist priority:low due:today',
      showCompleted: false,
    });

    expect(context.sources).toEqual(['linear']);
    expect(parseFilterQuery(context.query).sourceTokens).toEqual([]);
    expect(parseFilterQuery(context.query).priorityTokens).toEqual([]);
    expect(parseFilterQuery(context.query).dueTokens).toEqual(['today']);
  });

  it('preserves legacy saved views and emits backward-compatible definitions', () => {
    const context = taskFilterContextFromSavedView({
      source: 'github-issues',
      tag: 'api,urgent',
      priorities: 'critical,high',
      query: 'due:week',
      showCompleted: 'true',
    });

    expect(context.completion).toBe('all');
    expect(taskFilterContextToSavedView(context)).toEqual({
      source: 'github-issues',
      tagSlugs: 'api,urgent',
      priorities: 'critical,high',
      query: 'due:week',
      completion: 'all',
    });
  });

  it('migrates persisted Universe filters without dimensions or layout state', () => {
    const migrated = migrateLegacyUniverseFilters({
      search: 'release',
      priorities: ['high'],
      statuses: ['todo'],
      sources: ['github-issues', 'todoist'],
      lists: ['account-a:backlog', 'account-b:backlog'],
    });

    expect(migrated.context).toMatchObject({
      query: 'release',
      priorities: ['high'],
      statuses: ['todo'],
      sources: ['github-issues', 'todoist'],
      listIds: ['account-a:backlog', 'account-b:backlog'],
    });
    expect(migrated.context).not.toHaveProperty('dimensions');
  });

  it('constructs equivalent existing task API parameters', () => {
    const context = taskFilterContextFromDashboard({
      sourceFilter: 'github-issues',
      listFilter: 'backlog',
      listGroupFilter: 'engineering',
      tagFilter: ['urgent'],
      quickFilter: 'overdue',
      projectFilter: 'project-1',
      priorityFilter: ['high'],
      statusFilter: ['todo'],
      textFilter: 'assignee:octo-org',
      showCompleted: false,
    });

    const initial = new URLSearchParams('parentOnly=true&limit=50&offset=0');

    expect(taskFilterContextToTaskQuery(context, initial).toString()).toBe(
      'parentOnly=true&limit=50&offset=0'
      + '&source=github-issues&listId=backlog&listGroupId=engineering'
      + '&tag=urgent&projectId=project-1&priorities=high&statuses=todo'
      + '&quickFilter=overdue&filterQuery=assignee%3Aocto-org',
    );
  });

  it('captures Today as an explicit date and completion semantic', () => {
    const context = taskFilterContextForToday('2026-08-01');
    const query = taskFilterContextToTaskQuery(context);

    expect(context).toMatchObject({
      quickFilter: 'myDay',
      myDayDate: '2026-08-01',
      completion: 'all',
    });

    expect(query.toString()).toBe('quickFilter=myDay&myDayDate=2026-08-01');
  });

  it('preserves saved My Day and age criteria through Dashboard conversion', () => {
    const context = normalizeTaskFilterContext({
      quickFilter: 'myDay',
      myDayDate: '2026-07-31',
      ageMinDays: 7,
      ageMaxDays: 30,
      completion: 'all',
    });

    const dashboard = taskFilterContextToDashboard(context);
    expect(dashboard).toMatchObject({
      quickFilter: 'myDay',
      myDayDate: '2026-07-31',
      ageMinDays: 7,
      ageMaxDays: 30,
      showCompleted: true,
    });
    expect(taskFilterContextFromDashboard(dashboard)).toEqual(context);
  });

  it('drops a My Day date when the matching collection semantic is absent', () => {
    expect(normalizeTaskFilterContext({
      quickFilter: 'overdue',
      myDayDate: '2026-08-01',
    }).myDayDate).toBeNull();
  });

  it('uses plural API parameters for collection filters and keeps list identities', () => {
    const query = taskFilterContextToTaskQuery(normalizeTaskFilterContext({
      sources: ['todoist', 'github-issues'],
      listIds: ['account-a:backlog', 'account-b:backlog'],
    }));

    expect(query.get('sources')).toBe('github-issues,todoist');
    expect(query.get('listIds')).toBe('account-a:backlog,account-b:backlog');
    expect(query.get('openOnly')).toBe('true');
  });

  it('preserves one connector-qualified list identity in task API parameters', () => {
    const query = taskFilterContextToTaskQuery(normalizeTaskFilterContext({
      listIds: ['Account-A:Backlog'],
    }));

    expect(query.get('listId')).toBe('Account-A:Backlog');
  });

  it('does not add openOnly when statuses explicitly define completion semantics', () => {
    const query = taskFilterContextToTaskQuery(normalizeTaskFilterContext({
      statuses: ['done'],
    }));

    expect(query.get('statuses')).toBe('done');
    expect(query.has('openOnly')).toBe(false);
  });

  it('supports immutable updates and semantic active-filter counts', () => {
    const updated = updateTaskFilterContext(EMPTY_TASK_FILTER_CONTEXT, {
      query: 'priority:high release',
      tagSlugs: ['api'],
      completion: 'all',
    });

    expect(countTaskFilters(updated)).toBe(4);
    expect(EMPTY_TASK_FILTER_CONTEXT.query).toBe('');
  });

  it('describes and removes canonical criteria without Graph-specific encoding', () => {
    const context = normalizeTaskFilterContext({
      query: 'assignee:alice due:today',
      sources: ['github-issues', 'todoist'],
      listIds: ['work:repo'],
      tagSlugs: ['graph'],
      projectId: 'project-graph',
      priorities: ['high'],
      statuses: ['todo'],
      quickFilter: 'myDay',
      myDayDate: '2026-08-01',
      completion: 'all',
    });
    const descriptors = describeTaskFilterCriteria(context);

    expect(descriptors.map(({ origin, kind, value, label }) => ({
      origin,
      kind,
      value,
      label,
    }))).toEqual(expect.arrayContaining([
      { origin: 'query', kind: 'assignee', value: 'alice', label: 'assignee:alice' },
      { origin: 'query', kind: 'due', value: 'today', label: 'due:today' },
      { origin: 'context', kind: 'source', value: 'github-issues', label: 'source:github-issues' },
      { origin: 'context', kind: 'list', value: 'work:repo', label: 'list:work:repo' },
      { origin: 'context', kind: 'quickFilter', value: 'myDay', label: 'date:myDay@2026-08-01' },
      { origin: 'context', kind: 'completion', value: 'all', label: 'completion:all' },
    ]));
    expect(countTaskFilters(context)).toBe(descriptors.length);

    const withoutAssignee = removeTaskFilterCriterion(
      context,
      descriptors.find((descriptor) => descriptor.kind === 'assignee')!,
    );
    expect(withoutAssignee.query).toBe('due:today');
    expect(withoutAssignee.sources).toEqual(['github-issues', 'todoist']);

    const withoutSource = removeTaskFilterCriterion(
      context,
      descriptors.find((descriptor) => descriptor.value === 'github-issues')!,
    );
    expect(withoutSource.sources).toEqual(['todoist']);
    expect(withoutSource.query).toBe(context.query);

    const withoutMyDay = removeTaskFilterCriterion(
      context,
      descriptors.find((descriptor) => descriptor.kind === 'quickFilter')!,
    );
    expect(withoutMyDay.quickFilter).toBeNull();
    expect(withoutMyDay.myDayDate).toBeNull();
  });
});
