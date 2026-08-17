import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

describe('task attribute filtering', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let buildConditions: typeof import('@/app/api/tasks/canonical-filter').buildCanonicalTaskFilterConditions;
  let getCanonicalWhere: typeof import('@/app/api/tasks/canonical-filter').getCanonicalTaskFilterWhere;
  let and: typeof import('drizzle-orm').and;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();

    const [dbModule, schemaModule, filterModule, drizzle] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/tasks/canonical-filter'),
      import('drizzle-orm'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    buildConditions = filterModule.buildCanonicalTaskFilterConditions;
    getCanonicalWhere = filterModule.getCanonicalTaskFilterWhere;
    and = drizzle.and;
  }, 30_000);

  beforeEach(async () => {
    await db.delete(schema.projectPhaseItems);
    await db.delete(schema.taskProjects);
    await db.delete(schema.taskTags);
    await db.delete(schema.sourceLists);
    await db.delete(schema.listGroups);
    await db.delete(schema.projectPhases);
    await db.delete(schema.hubProjects);
    await db.delete(schema.tags);
    await db.delete(schema.myDayItems);
    await db.delete(schema.tasks);

    const now = '2026-08-05T12:00:00.000Z';
    await db.insert(schema.tasks).values([
      task('assigned', now, {
        assignee: 'alice',
        dueDate: '2026-08-06',
        priority: 'high',
        sourceListId: 'backlog',
        sourceListName: 'Backlog',
      }),
      task('project-only', now),
      task('unassigned', now),
    ]);
    await db.insert(schema.tags).values([
      {
        id: 'tag-1',
        name: 'Feature',
        slug: 'feature',
        type: 'label',
        createdAt: now,
      },
      {
        id: 'tag-duplicate',
        name: 'Feature duplicate',
        slug: 'feature',
        type: 'label',
        createdAt: now,
      },
      {
        id: 'tag-api',
        name: 'API',
        slug: 'api',
        type: 'label',
        createdAt: now,
      },
    ]);
    await db.insert(schema.taskTags).values([
      { taskId: 'assigned', tagId: 'tag-1' },
      { taskId: 'assigned', tagId: 'tag-api' },
    ]);
    await db.insert(schema.listGroups).values({
      id: 'group-1',
      name: 'Work',
      createdAt: now,
    });
    await db.insert(schema.sourceLists).values({
      id: 'source-list-1',
      connectorInstanceId: 'custom-rest-read-only',
      sourceId: 'backlog',
      name: 'Backlog',
      type: 'list',
      groupId: 'group-1',
    });
    await db.insert(schema.hubProjects).values({
      id: 'project-1',
      name: 'Mission Control',
      color: '#000000',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectPhases).values({
      id: 'phase-1',
      projectId: 'project-1',
      name: 'Delivery',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.taskProjects).values([
      { taskId: 'assigned', projectId: 'project-1' },
      { taskId: 'project-only', projectId: 'project-1' },
    ]);
    await db.insert(schema.projectPhaseItems).values({
      id: 'phase-item-1',
      phaseId: 'phase-1',
      taskId: 'assigned',
      createdAt: now,
    });
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
  });

  async function matchingIds(filterQuery: string): Promise<string[]> {
    const { conditions } = await buildConditions(new URLSearchParams({ filterQuery }));
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(and(...conditions));
    return rows.map((row) => row.id).sort();
  }

  async function matchingParamIds(params: URLSearchParams): Promise<string[]> {
    const { taskWhere } = await getCanonicalWhere(params);
    const rows = await db
      .select({ id: schema.tasks.id })
      .from(schema.tasks)
      .where(taskWhere);
    return rows.map((row) => row.id).sort();
  }

  it('filters by project and phase membership, including unassigned tasks', async () => {
    await expect(matchingIds('project:project-1')).resolves.toEqual(['assigned', 'project-only']);
    await expect(matchingIds('project:none')).resolves.toEqual(['unassigned']);
    await expect(matchingIds('project:project-1 project:none')).resolves.toEqual([
      'assigned',
      'project-only',
      'unassigned',
    ]);
    await expect(matchingIds('phase:phase-1')).resolves.toEqual(['assigned']);
    await expect(matchingIds('phase:none')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('phase:phase-1 phase:none')).resolves.toEqual([
      'assigned',
      'project-only',
      'unassigned',
    ]);
  });

  it('supports none for every unsettable attribute filter', async () => {
    await expect(matchingIds('assignee:none')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('due:none')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('priority:none')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('tag:none')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('list:none')).resolves.toEqual(['project-only', 'unassigned']);
  });

  it('ORs none with selected values in the same category', async () => {
    const allTaskIds = ['assigned', 'project-only', 'unassigned'];

    await expect(matchingIds('assignee:alice assignee:none')).resolves.toEqual(allTaskIds);
    await expect(matchingIds('due:2026-08-06 due:none')).resolves.toEqual(allTaskIds);
    await expect(matchingIds('list:backlog list:none')).resolves.toEqual(allTaskIds);
    await expect(matchingIds('priority:high priority:none')).resolves.toEqual(allTaskIds);
    await expect(matchingIds('tag:feature tag:none')).resolves.toEqual(allTaskIds);
  });

  it('supports excluding project and unassigned membership', async () => {
    await expect(matchingIds('-project:project-1')).resolves.toEqual(['unassigned']);
    await expect(matchingIds('-project:none')).resolves.toEqual(['assigned', 'project-only']);
    await expect(matchingIds('-phase:phase-1')).resolves.toEqual(['project-only', 'unassigned']);
    await expect(matchingIds('-phase:none')).resolves.toEqual(['assigned']);
    await expect(matchingIds('-assignee:none')).resolves.toEqual(['assigned']);
    await expect(matchingIds('-due:none')).resolves.toEqual(['assigned']);
    await expect(matchingIds('-list:none')).resolves.toEqual(['assigned']);
    await expect(matchingIds('-priority:none')).resolves.toEqual(['assigned']);
    await expect(matchingIds('-tag:none')).resolves.toEqual(['assigned']);
  });

  it('keeps AND semantics with duplicate slugs in the SQL tag subquery', async () => {
    const now = '2026-08-05T12:00:00.000Z';
    await db.insert(schema.tasks).values(task('duplicate-tag', now));
    await db.insert(schema.taskTags).values({
      taskId: 'duplicate-tag',
      tagId: 'tag-duplicate',
    });

    await expect(matchingParamIds(new URLSearchParams({
      tagSlugs: 'feature,feature',
    }))).resolves.toEqual(['assigned', 'duplicate-tag']);
    await expect(matchingParamIds(new URLSearchParams({
      tagSlugs: 'feature,api',
    }))).resolves.toEqual(['assigned']);
    await expect(matchingParamIds(new URLSearchParams({
      tagSlugs: 'feature,missing',
    }))).resolves.toEqual([]);
  });

  it('matches list groups with a correlated SQL lookup', async () => {
    await expect(matchingParamIds(new URLSearchParams({
      listGroupId: 'group-1',
    }))).resolves.toEqual(['assigned']);
    await expect(matchingParamIds(new URLSearchParams({
      listGroupId: 'missing',
    }))).resolves.toEqual([]);
  });

  it('treats wildcard characters in filter text literally', async () => {
    const now = '2026-08-05T12:00:00.000Z';
    await db.insert(schema.tasks).values(task('100%-ready', now));
    await expect(matchingIds('title:%')).resolves.toEqual(['100%-ready']);
    await expect(matchingIds('title:_')).resolves.toEqual([]);
  });

  it('shows only tasks closed within the last seven days even when open-only is requested', async () => {
    const now = new Date();
    const recent = new Date(now);
    recent.setDate(recent.getDate() - 2);
    const stale = new Date(now);
    stale.setDate(stale.getDate() - 9);

    await db.insert(schema.tasks).values([
      {
        ...task('recently-closed', now.toISOString()),
        status: 'done',
        completedAt: recent.toISOString(),
      },
      {
        ...task('stale-closed', now.toISOString()),
        status: 'cancelled',
        completedAt: stale.toISOString(),
      },
      {
        ...task('open-with-completion-date', now.toISOString()),
        completedAt: recent.toISOString(),
      },
    ]);

    await expect(matchingParamIds(new URLSearchParams({
      quickFilter: 'recentlyClosed',
      openOnly: 'true',
    }))).resolves.toEqual(['recently-closed']);
  });
});

function task(
  id: string,
  now: string,
  optional: {
    assignee?: string;
    dueDate?: string;
    priority?: string;
    sourceListId?: string;
    sourceListName?: string;
  } = {},
) {
  return {
    id,
    sourceId: `source:${id}`,
    connectorType: 'custom-rest',
    connectorInstanceId: 'custom-rest-read-only',
    title: id,
    status: 'todo',
    localDisposition: 'active' as const,
    priority: optional.priority ?? 'none',
    dueDate: optional.dueDate,
    assignee: optional.assignee,
    sourceListId: optional.sourceListId,
    sourceListName: optional.sourceListName,
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
  };
}
