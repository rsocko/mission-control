import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const inboxCondition = { type: 'inbox' };
  const genericCondition = { type: 'generic' };
  const parentOnlyCondition = { type: 'parent-only' };
  const listCondition = { type: 'list' };
  const select = vi.fn();
  const where = vi.fn();
  const eq = vi.fn();
  const and = vi.fn((...conditions: unknown[]) => ({ type: 'and', conditions }));
  // The parentOnly filter is built with the real `isNull()` export (mocked below), not
  // with a `sql` template, so this stub always returns an aliasable SQL-like object.
  // (A previous version matched on template text containing "IS NULL", which broke as
  // soon as a groupExpr's own CASE/WHEN clause legitimately contained that text, e.g.
  // the effort and dueDate groupings.)
  const sql = vi.fn(() => ({ type: 'sql', as: vi.fn(() => 'group') }));
  const getInboxFilterCondition = vi.fn(async () => inboxCondition);
  const getQuickFilterCondition = vi.fn(() => genericCondition);
  const withCondition = vi.fn((baseWhere, condition) => ({ baseWhere, condition }));
  const getSourceListIdsCondition = vi.fn(() => listCondition);

  return {
    genericCondition,
    inboxCondition,
    parentOnlyCondition,
    listCondition,
    select,
    where,
    eq,
    and,
    sql,
    getInboxFilterCondition,
    getQuickFilterCondition,
    withCondition,
    getSourceListIdsCondition,
  };
});

function chainable<T>(terminal: T) {
  const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
    get(_, prop) {
      if (prop === 'then') {
        return (resolve: (value: T) => unknown) => resolve(terminal);
      }
      if (prop === 'where') {
        return (condition: unknown) => {
          mocks.where(condition);
          return chain;
        };
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

vi.mock('@/db', () => ({
  default: {
    select: mocks.select,
  },
}));

vi.mock('drizzle-orm', () => ({
  and: mocks.and,
  count: vi.fn(() => ({ as: vi.fn(() => 'count') })),
  countDistinct: vi.fn(() => ({ as: vi.fn(() => 'count') })),
  eq: mocks.eq,
  inArray: vi.fn(),
  isNull: vi.fn(() => mocks.parentOnlyCondition),
  notInArray: vi.fn(),
  sql: mocks.sql,
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    connectorInstanceId: 'connectorInstanceId',
    connectorType: 'connectorType',
    dueDate: 'dueDate',
    effort: 'effort',
    id: 'id',
    localDisposition: 'localDisposition',
    parentId: 'parentId',
    priority: 'priority',
    sourceListName: 'sourceListName',
    status: 'status',
  },
  myDayItems: {
    taskId: 'taskId',
    date: 'date',
  },
  sourceLists: {},
  taskTags: {},
  tags: {},
  taskProjects: {},
  hubProjects: {},
  projectPhaseItems: {},
  projectPhases: {},
}));

vi.mock('@/app/api/tasks/query-builder', () => ({
  getAssignedFilterCondition: vi.fn(),
  getDateBounds: () => ({ today: '2026-08-03', weekFromNow: '2026-08-10' }),
  getInboxFilterCondition: mocks.getInboxFilterCondition,
  getQuickFilterCondition: mocks.getQuickFilterCondition,
  withCondition: mocks.withCondition,
}));

vi.mock('@/app/api/tasks/filter-factory', () => ({
  getTagSlugFilterCondition: vi.fn(),
  getMultiTagFilterCondition: vi.fn(),
  getProjectFilterCondition: vi.fn(),
}));

vi.mock('@/app/api/tasks/filter-query', () => ({
  getFilterQueryConditions: vi.fn(),
  getSourceListGroupCondition: vi.fn(),
  getSourceListIdsCondition: mocks.getSourceListIdsCondition,
}));

describe('GET /api/tasks/group-counts', () => {
  beforeEach(() => {
    mocks.select.mockReset();
    mocks.select.mockImplementation((selection: Record<string, unknown>) => (
      Object.hasOwn(selection, 'taskId')
        ? chainable([])
        : chainable([{ group: 'To Do', count: 2 }])
    ));
    mocks.where.mockClear();
    mocks.eq.mockClear();
    mocks.and.mockClear();
    mocks.sql.mockClear();
    mocks.getInboxFilterCondition.mockClear();
    mocks.getQuickFilterCondition.mockClear();
    mocks.withCondition.mockClear();
    mocks.getSourceListIdsCondition.mockClear();
  });

  it('applies the Inbox condition to grouped totals', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status&quickFilter=inbox',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ counts: { 'To Do': 2 } });
    expect(mocks.getInboxFilterCondition).toHaveBeenCalledOnce();
    expect(mocks.getQuickFilterCondition).not.toHaveBeenCalled();
    expect(mocks.withCondition).toHaveBeenCalledWith(
      expect.anything(),
      mocks.inboxCondition,
    );
    expect(mocks.where).toHaveBeenCalledWith(
      mocks.withCondition.mock.results[0].value,
    );
    expect(mocks.eq).toHaveBeenCalledWith('localDisposition', 'active');
  });

  it('leaves non-Inbox quick filters on the generic path', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status&quickFilter=overdue',
    ));

    expect(response.status).toBe(200);
    expect(mocks.getInboxFilterCondition).not.toHaveBeenCalled();
    expect(mocks.getQuickFilterCondition).toHaveBeenCalledWith(
      'overdue',
      '2026-08-03',
      '2026-08-10',
      [],
    );
    expect(mocks.where).toHaveBeenCalledWith(
      expect.objectContaining({ condition: mocks.genericCondition }),
    );
  });

  it('builds source totals from the connector type', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=source',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ counts: { 'To Do': 2 } });
    expect(mocks.sql.mock.calls.some(
      ([strings, ...values]) => strings.join('').includes('COALESCE(NULLIF')
        && values.includes('connectorType'),
    )).toBe(true);
  });

  it('builds effort totals with a text group key', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=effort',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ counts: { 'To Do': 2 } });
    expect(mocks.sql.mock.calls.some(
      ([strings, ...values]) => strings.join('').includes('CAST(')
        && values.includes('effort'),
    )).toBe(true);
  });

  it('rejects unsupported groupings instead of returning misleading empty totals', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=unknown',
    ));

    expect(response.status).toBe(400);
  });

  it('excludes subtasks from filtered grouped totals when parentOnly is requested', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status&parentOnly=true'
        + '&source=microsoft-todo&listId=phone-and-tech',
    ));

    expect(response.status).toBe(200);
    expect(mocks.getSourceListIdsCondition).toHaveBeenCalledWith(['phone-and-tech']);
    expect(mocks.and.mock.calls.some(
      (conditions) => conditions.includes(mocks.parentOnlyCondition),
    )).toBe(true);
    expect(mocks.withCondition).toHaveBeenCalledWith(
      expect.objectContaining({
        conditions: expect.arrayContaining([mocks.parentOnlyCondition]),
      }),
      mocks.genericCondition,
    );
  });

  it('rejects over-budget filters before querying', async () => {
    const values = Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(',');
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      `http://localhost/api/tasks/group-counts?groupBy=status&tagSlugs=${values}`,
    ));

    expect(response.status).toBe(422);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
