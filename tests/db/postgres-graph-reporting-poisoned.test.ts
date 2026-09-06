import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphReportingPersistence } from '@/db/persistence/graph-reporting';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});

const calls = vi.hoisted(() => ({
  addTaskTags: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
  createProject: vi.fn(async () => ({ id: 'project-cluster' })),
  deleteProject: vi.fn(async () => undefined),
  applyHierarchy: vi.fn(async () => ({ revision: 2 })),
  synchronizeDependency: vi.fn(async (dependency) => dependency),
  removeDependency: vi.fn(async () => ({ deleted: true })),
  findProject: vi.fn(async () => false),
  deleteProjectIfCreationToken: vi.fn(async () => ({
    deleted: true,
    affectedTaskIds: [] as string[],
  })),
}));

vi.mock('@/lib/graph/universe-semantic-config', () => ({
  isUniverseClustersEnabled: () => true,
  isUniverseSemanticNeighborsEnabled: () => false,
}));
vi.mock('@/app/api/tasks/[id]/tags/route', () => ({ POST: calls.addTaskTags }));
vi.mock('@/lib/projects/organization-service', () => ({
  createHubProject: calls.createProject,
  deleteHubProject: calls.deleteProject,
}));
vi.mock('@/lib/projects/hierarchy-service', () => ({
  getProjectHierarchySnapshot: async () => ({ revision: 1 }),
  applyProjectHierarchyCommand: calls.applyHierarchy,
  ProjectHierarchyServiceError: class extends Error {},
}));
vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityUpsert: async () => undefined,
}));
vi.mock('@/lib/sync/task-dependency-manager', () => ({
  synchronizeCreatedTaskDependency: calls.synchronizeDependency,
  removeTaskDependencyFromSource: calls.removeDependency,
}));

const task = {
  id: 'task-1',
  title: 'Task',
  description: null,
  status: 'todo',
  microStatus: null,
  priority: 'none',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: null,
  sourceListName: null,
  effort: null,
};
const dependency = {
  id: 'dependency-1',
  taskId: 'task-2',
  dependsOnTaskId: 'task-1',
  type: 'blocks' as const,
  connectorInstanceId: null,
  syncStatus: 'local' as const,
  syncAction: null,
  syncError: null,
  lastSyncedAt: null,
  createdAt: '2026-09-05T12:00:00.000Z',
};
const dependencyTask = {
  id: 'task-1',
  sourceId: 'local:task-1',
  connectorInstanceId: 'local',
  isChecklistItem: false,
  metadata: {},
};

const graphReporting: GraphReportingPersistence = {
  universe: {
    read: async () => ({
      tasks: [],
      tags: [],
      projects: [],
      filteredTaskCount: 0,
      hasMoreTasks: false,
    }),
    listEligibleTaskIds: async ({ taskIds }) => [...taskIds],
  },
  neighbors: {
    readAggregate: async () => ({ center: { kind: 'property' }, tasks: [task] }),
    readTask: async () => ({
      center: task,
      dependencies: [],
      dependencyTasks: [],
      projects: [],
      phases: [],
      tags: [],
    }),
    listTasks: async () => [],
    listDeletedConnectorIds: async () => [],
  },
  projects: {
    read: async () => ({
      project: {
        id: 'project-1',
        name: 'Project',
        description: null,
        status: 'active',
        color: '#3b82f6',
      },
      phases: [],
      tasks: [],
      phaseItems: [],
      dependencies: [],
    }),
    createDependency: async () => ({
      kind: 'created',
      dependency,
      blocker: dependencyTask,
      blocked: { ...dependencyTask, id: 'task-2', sourceId: 'local:task-2' },
    }),
    getDependencyDeleteContext: async () => ({
      kind: 'found',
      dependency,
      blocker: dependencyTask,
      blocked: { ...dependencyTask, id: 'task-2', sourceId: 'local:task-2' },
    }),
  },
  overview: {
    read: async () => ({ projects: [], memberships: [], tasks: [], tags: [] }),
    listProjectTaskStatuses: async () => [],
  },
  burn: {
    read: async ({ projectId }) => ({
      scope: {
        projectId,
        scope: 'project',
        scopeId: projectId,
        scopeName: 'Project',
        scheduleStart: null,
        scheduleEnd: null,
      },
      candidateEvents: [],
      tasks: [],
    }),
  },
  clusterSave: {
    findProject: calls.findProject,
    deleteProjectIfCreationToken: calls.deleteProjectIfCreationToken,
    findTagBySlug: async () => ({ id: 'tag-cluster' }),
    createTag: async () => ({ id: 'tag-cluster', created: false }),
    deleteTagIfUnused: async () => true,
    recordTagAudit: async () => undefined,
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({ graphReporting }),
}));
vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    filterInputs: {
      listMyDayTaskIds: async () => [],
      listAssignedGitHubUsernames: async () => [],
      listInboxListEntries: async () => [],
    },
  }),
}));

const BASE = 'http://localhost:3099';
function request(path: string, init?: RequestInit) {
  return new Request(`${BASE}${path}`, {
    headers: {
      host: 'localhost:3099',
      origin: BASE,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    ...init,
  });
}

describe('poisoned-SQLite graph reporting routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('imports and executes all eight routes from PostgreSQL-shaped collaborators', async () => {
    const universe = await import('@/app/api/graph/universe/route');
    expect((await universe.GET(request('/api/graph/universe'))).status).toBe(200);

    const neighbors = await import('@/app/api/graph/nodes/[nodeId]/neighbors/route');
    expect((await neighbors.GET(
      request('/api/graph/nodes/task%3Atask-1/neighbors'),
      { params: Promise.resolve({ nodeId: 'task:task-1' }) },
    )).status).toBe(200);

    const cluster = await import('@/app/api/graph/universe/clusters/save/route');
    expect((await cluster.POST(request('/api/graph/universe/clusters/save', {
      method: 'POST',
      body: JSON.stringify({
        destination: 'tag',
        name: 'Cluster',
        taskIds: ['task-1'],
        clusterId: 'cluster-1',
        projectionFingerprint: 'fingerprint',
      }),
    }))).status).toBe(201);

    const overview = await import('@/app/api/projects-overview/route');
    expect((await overview.GET()).status).toBe(200);

    const graph = await import('@/app/api/projects/[id]/graph/route');
    expect((await graph.GET(
      request('/api/projects/project-1/graph'),
      { params: Promise.resolve({ id: 'project-1' }) },
    )).status).toBe(200);

    const burn = await import('@/app/api/projects/[id]/reports/burn/route');
    expect((await burn.GET(
      request('/api/projects/project-1/reports/burn?start=2026-09-01&end=2026-09-05'),
      { params: Promise.resolve({ id: 'project-1' }) },
    )).status).toBe(200);

    const create = await import('@/app/api/projects/[id]/task-dependencies/route');
    expect((await create.POST(request('/api/projects/project-1/task-dependencies', {
      method: 'POST',
      body: JSON.stringify({
        sourceTaskId: 'task-1',
        targetTaskId: 'task-2',
        type: 'blocks',
      }),
    }), { params: Promise.resolve({ id: 'project-1' }) })).status).toBe(201);

    const remove = await import(
      '@/app/api/projects/[id]/task-dependencies/[dependencyId]/route'
    );
    expect((await remove.DELETE(
      request('/api/projects/project-1/task-dependencies/dependency-1', {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({
          id: 'project-1',
          dependencyId: 'dependency-1',
        }),
      },
    )).status).toBe(200);
  }, 15_000);

  it('does not roll back a concurrently created project', async () => {
    calls.createProject.mockRejectedValueOnce(new Error('duplicate project'));
    calls.deleteProjectIfCreationToken.mockResolvedValueOnce({
      deleted: false,
      affectedTaskIds: [],
    });
    calls.findProject.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const cluster = await import('@/app/api/graph/universe/clusters/save/route');
    const response = await cluster.POST(request('/api/graph/universe/clusters/save', {
      method: 'POST',
      body: JSON.stringify({
        destination: 'project',
        name: 'Cluster',
        taskIds: ['task-1'],
        clusterId: 'cluster-1',
        projectionFingerprint: 'fingerprint',
      }),
    }));

    expect(response.status).toBe(409);
    expect(calls.deleteProjectIfCreationToken).toHaveBeenCalledOnce();
    expect(calls.deleteProject).not.toHaveBeenCalled();
  });
});
