import { beforeAll, describe, expect, it, vi } from 'vitest';

describe('getUniverseSubgraph', () => {
  beforeAll(() => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  it('queries a bounded, filtered property projection from relational task data', async () => {
    const [{ default: db }, schema, { getUniverseSubgraph }, { getLocalToday }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/graph/universe-service'),
      import('@/lib/utils/date'),
    ]);
    const now = new Date().toISOString();
    const today = getLocalToday();
    await db.insert(schema.tasks).values([
      {
        id: 'task-graph',
        sourceId: 'source-graph',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Build graph canvas',
        status: 'todo',
        priority: 'high',
        sourceListId: 'inbox',
        sourceListName: 'Inbox',
        assignee: 'alice',
        dueDate: today,
        effort: 3,
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'task-other',
        sourceId: 'source-other',
        connectorType: 'github-issues',
        connectorInstanceId: 'github',
        title: 'Unrelated work',
        status: 'done',
        priority: 'low',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'task-graph-subtask',
        sourceId: 'source-graph-subtask',
        connectorType: 'local',
        connectorInstanceId: 'local',
        title: 'Build graph canvas child',
        status: 'todo',
        priority: 'high',
        sourceListId: 'inbox',
        sourceListName: 'Inbox',
        assignee: 'alice',
        dueDate: today,
        effort: 3,
        parentId: 'task-graph',
        depth: 1,
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);
    await db.insert(schema.tags).values({
      id: 'tag-graph',
      name: 'Graph',
      slug: 'graph',
      type: 'hub',
      color: '#34d399',
      confirmed: true,
      createdAt: now,
    });
    await db.insert(schema.taskTags).values({ taskId: 'task-graph', tagId: 'tag-graph' });
    await db.insert(schema.hubProjects).values({
      id: 'project-graph',
      name: 'Graph project',
      color: '#3b82f6',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.taskProjects).values({
      taskId: 'task-graph',
      projectId: 'project-graph',
    });

    const graph = await getUniverseSubgraph({
      dimensions: ['priority', 'tags', 'list', 'project'],
      taskQuery: new URLSearchParams({
        filterQuery: `graph assignee:alice due:${today}`,
        sources: 'local',
        priorities: 'high',
        statuses: 'todo',
        listId: 'local:inbox',
        tag: 'graph',
        projectId: 'project-graph',
        parentOnly: 'true',
      }),
      maxNodes: 50,
    });

    expect(graph.stats.taskCount).toBe(1);
    expect(graph.stats.filteredTaskCount).toBe(1);
    expect(graph.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'task:task-graph' }),
      expect.objectContaining({ id: 'property:priority:high' }),
      expect.objectContaining({ id: 'tag:tag-graph' }),
      expect.objectContaining({ kind: 'property', dimension: 'list', label: 'Inbox' }),
      expect.objectContaining({ id: 'project:project-graph' }),
    ]));
    expect(graph.facets.sources).toEqual(['local']);
  });

  it('keeps the most recently updated tasks when the result is truncated', async () => {
    const [{ default: db }, schema, { getUniverseSubgraph }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/graph/universe-service'),
    ]);
    const taskValues = Array.from({ length: 26 }, (_, index) => ({
      id: `ordered-${index}`,
      sourceId: `ordered-source-${index}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title: `Ordered task ${index}`,
      status: 'todo',
      priority: 'none',
      metadata: {},
      syncStatus: 'synced',
      createdAt: new Date(Date.UTC(2030, 0, index + 1)).toISOString(),
      updatedAt: new Date(Date.UTC(2030, 0, index + 1)).toISOString(),
      lastSyncedAt: new Date(Date.UTC(2030, 0, index + 1)).toISOString(),
    }));
    await db.insert(schema.tasks).values(taskValues);

    const graph = await getUniverseSubgraph({
      dimensions: [],
      taskQuery: new URLSearchParams('filterQuery=Ordered+task'),
      maxNodes: 25,
    });

    expect(graph.truncated).toBe(true);
    expect(graph.stats.filteredTaskCount).toBe(26);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: 'task:ordered-25' }));
    expect(graph.nodes).not.toContainEqual(expect.objectContaining({ id: 'task:ordered-0' }));
  });

  it('matches list groups by connector and source list identity', async () => {
    const [{ default: db }, schema, { getUniverseSubgraph }] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/graph/universe-service'),
    ]);
    const now = new Date().toISOString();
    await db.insert(schema.listGroups).values({
      id: 'group-exact-lists',
      name: 'Exact lists',
      createdAt: now,
    });
    await db.insert(schema.sourceLists).values({
      id: 'source-list-group-member',
      connectorInstanceId: 'group-connector',
      sourceId: 'shared-list-id',
      name: 'Grouped list',
      type: 'list',
      groupId: 'group-exact-lists',
    });
    await db.insert(schema.tasks).values([
      {
        id: 'task-in-list-group',
        sourceId: 'source-in-list-group',
        connectorType: 'local',
        connectorInstanceId: 'group-connector',
        title: 'Task in exact list group',
        status: 'todo',
        priority: 'none',
        sourceListId: 'shared-list-id',
        sourceListName: 'Grouped list',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
      {
        id: 'task-outside-list-group',
        sourceId: 'source-outside-list-group',
        connectorType: 'local',
        connectorInstanceId: 'other-connector',
        title: 'Task outside exact list group',
        status: 'todo',
        priority: 'none',
        sourceListId: 'shared-list-id',
        sourceListName: 'Ungrouped duplicate list',
        metadata: {},
        syncStatus: 'synced',
        createdAt: now,
        updatedAt: now,
        lastSyncedAt: now,
      },
    ]);

    const graph = await getUniverseSubgraph({
      dimensions: [],
      taskQuery: new URLSearchParams({ listGroupId: 'group-exact-lists' }),
      maxNodes: 50,
    });

    expect(graph.stats.filteredTaskCount).toBe(1);
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: 'task:task-in-list-group' }));
    expect(graph.nodes).not.toContainEqual(expect.objectContaining({ id: 'task:task-outside-list-group' }));
  });
});
