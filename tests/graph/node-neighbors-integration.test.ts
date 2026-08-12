import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const findSimilarTaskEmbeddings = vi.fn();

vi.mock('@/lib/search/semantic', () => ({ findSimilarTaskEmbeddings }));

describe('getNodeNeighbors', () => {
  let getNodeNeighbors: typeof import('@/lib/graph/neighbors-service').getNodeNeighbors;
  let GraphAuthorizationError: typeof import('@/lib/graph/neighbors-service').GraphAuthorizationError;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const [{ default: db }, schema, service] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/graph/neighbors-service'),
    ]);
    getNodeNeighbors = service.getNodeNeighbors;
    GraphAuthorizationError = service.GraphAuthorizationError;
    const now = '2030-01-01T00:00:00.000Z';
    const task = (id: string, title: string) => ({
      id,
      sourceId: `source-${id}`,
      connectorType: 'local',
      connectorInstanceId: 'local',
      title,
      description: `${title} description`,
      status: 'todo',
      priority: 'high',
      sourceListId: 'inbox',
      sourceListName: 'Inbox',
      effort: 3,
      metadata: {},
      syncStatus: 'synced' as const,
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });
    await db.insert(schema.tasks).values([
      task('center', 'Center task'),
      task('blocker', 'Blocking task'),
      task('blocked', 'Blocked task'),
      task('semantic', 'Semantic task'),
    ]);
    await db.insert(schema.taskDependencies).values([
      {
        id: 'dependency-in',
        taskId: 'center',
        dependsOnTaskId: 'blocker',
        type: 'blocks',
        syncStatus: 'synced',
        lastSyncedAt: now,
        createdAt: now,
      },
      {
        id: 'dependency-out',
        taskId: 'blocked',
        dependsOnTaskId: 'center',
        type: 'blocks',
        syncStatus: 'pending',
        syncAction: 'create',
        createdAt: now,
      },
      {
        id: 'dependency-related',
        taskId: 'center',
        dependsOnTaskId: 'blocked',
        type: 'related',
        syncStatus: 'local',
        createdAt: now,
      },
    ]);
    await db.insert(schema.hubProjects).values({
      id: 'project-1',
      name: 'Graph project',
      color: '#3b82f6',
      status: 'active',
      sourceBindings: [],
      autoIncludeRules: [],
      kanbanColumns: [],
      defaultView: 'list',
      metadata: {},
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.taskProjects).values([
      { taskId: 'center', projectId: 'project-1' },
      { taskId: 'blocked', projectId: 'project-1' },
    ]);
    await db.insert(schema.projectPhases).values({
      id: 'phase-1',
      projectId: 'project-1',
      name: 'Build',
      status: 'in_progress',
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.projectPhaseItems).values({
      id: 'phase-item-1',
      phaseId: 'phase-1',
      taskId: 'center',
      createdAt: now,
    });
    await db.insert(schema.tags).values({
      id: 'tag-1',
      name: 'Graph',
      slug: 'graph',
      type: 'hub',
      confirmed: true,
      createdAt: now,
    });
    await db.insert(schema.taskTags).values([
      { taskId: 'center', tagId: 'tag-1' },
      { taskId: 'blocker', tagId: 'tag-1' },
    ]);
  });

  beforeEach(() => {
    findSimilarTaskEmbeddings.mockReset();
  });

  it('preserves blocking direction, related symmetry, derived provenance, and sync data', async () => {
    findSimilarTaskEmbeddings.mockResolvedValue({
      status: 'available',
      provider: 'ollama',
      model: 'nomic-embed-text',
      sourceUpdatedAt: '2030-01-01T00:00:00.000Z',
      neighbors: [{
        taskId: 'semantic',
        score: 0.75,
        embeddingUpdatedAt: '2030-01-01T00:00:00.000Z',
      }],
    });
    const graph = await getNodeNeighbors({
      nodeId: 'task:center',
      include: ['explicit', 'derived', 'semantic'],
      maxNodes: 50,
      maxEdges: 50,
    });

    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'dependency:dependency-in',
        source: 'task:blocker',
        target: 'task:center',
        type: 'blocks',
        syncStatus: 'synced',
        lastSyncedAt: '2030-01-01T00:00:00.000Z',
      }),
      expect.objectContaining({
        id: 'dependency:dependency-out',
        source: 'task:center',
        target: 'task:blocked',
        type: 'blocks',
        syncStatus: 'pending',
        syncAction: 'create',
      }),
      expect.objectContaining({
        id: 'dependency:dependency-related',
        source: 'task:blocked',
        target: 'task:center',
        type: 'related',
      }),
      expect.objectContaining({
        source: 'project:project-1',
        target: 'task:center',
        type: 'contains',
        provenance: 'derived',
      }),
      expect.objectContaining({
        source: 'task:center',
        target: 'tag:tag-1',
        type: 'has-tag',
        provenance: 'derived',
      }),
      expect.objectContaining({
        type: 'semantic-similarity',
        provenance: 'embedding',
        score: 0.75,
        embedding: expect.objectContaining({ model: 'nomic-embed-text' }),
      }),
    ]));
    expect(graph.edges.filter((edge) => edge.provenance === 'explicit').map((edge) => edge.id))
      .toEqual([
        'dependency:dependency-in',
        'dependency:dependency-out',
        'dependency:dependency-related',
      ]);
    expect(graph.nodes).toContainEqual(expect.objectContaining({
      id: 'property:effort:3',
      label: 'Effort 3',
    }));
    expect(graph.semantic).toEqual({ requested: true, status: 'available' });
  });

  it('returns explicit semantic fallback metadata without fabricating an edge', async () => {
    findSimilarTaskEmbeddings.mockResolvedValue({
      status: 'stale',
      note: 'The selected task embedding is older than the task.',
      neighbors: [],
    });
    const graph = await getNodeNeighbors({
      nodeId: 'task:center',
      include: ['semantic'],
    });
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
    expect(graph.semantic).toMatchObject({
      requested: true,
      status: 'stale',
      note: expect.stringContaining('older'),
    });
  });

  it('enforces authorization and total budgets in the service', async () => {
    await expect(getNodeNeighbors({
      nodeId: 'task:center',
      authorizeTask: () => false,
    })).rejects.toBeInstanceOf(GraphAuthorizationError);

    const graph = await getNodeNeighbors({
      nodeId: 'task:center',
      include: ['explicit', 'derived'],
      maxNodes: 2,
      maxEdges: 1,
    });
    expect(graph.nodes.length).toBeLessThanOrEqual(2);
    expect(graph.edges.length).toBeLessThanOrEqual(1);
    expect(graph.edges).toEqual([
      expect.objectContaining({ id: 'dependency:dependency-in' }),
    ]);
    expect(graph.pageInfo.truncated).toBe(true);
  });

  it('expands tag, project, and property nodes within total budgets', async () => {
    const tagGraph = await getNodeNeighbors({
      nodeId: 'tag:tag-1',
      include: ['derived'],
      maxNodes: 10,
      maxEdges: 10,
    });
    expect(tagGraph.centerNodeId).toBe('tag:tag-1');
    expect(tagGraph.nodes.map((node) => node.id)).toEqual([
      'tag:tag-1',
      'task:blocker',
      'task:center',
    ]);
    expect(tagGraph.edges).toHaveLength(2);

    const projectGraph = await getNodeNeighbors({
      nodeId: 'project:project-1',
      include: ['derived'],
      maxNodes: 10,
      maxEdges: 10,
    });
    expect(projectGraph.nodes.map((node) => node.id)).toEqual([
      'project:project-1',
      'task:blocked',
      'task:center',
    ]);

    const propertyGraph = await getNodeNeighbors({
      nodeId: 'property:priority:high',
      include: ['derived'],
      maxNodes: 2,
      maxEdges: 10,
    });
    expect(propertyGraph.nodes).toHaveLength(2);
    expect(propertyGraph.pageInfo.truncated).toBe(true);
    expect(propertyGraph.pageInfo.truncationReasons).toContain('source-limit');
  });
});
