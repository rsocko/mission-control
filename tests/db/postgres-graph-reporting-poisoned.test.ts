import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GraphReportingPersistence } from '@/db/persistence/graph-reporting';
import type {
  TagOverviewResult,
  TaskCoreTaskRow,
  TaskMovePreviewSnapshot,
} from '@/lib/tasks/core/contracts';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/index', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('@/db/bootstrap/connection', () => {
  throw new Error('SQLite bootstrap must not be evaluated');
});
vi.mock('@/db/persistence/sqlite-task-core-repositories', () => {
  throw new Error('SQLite task-core repositories must not be evaluated');
});
vi.mock('better-sqlite3', () => {
  throw new Error('better-sqlite3 must not be loaded');
});
vi.mock('drizzle-orm/better-sqlite3', () => {
  throw new Error('the SQLite drizzle driver must not be loaded');
});

const calls = vi.hoisted(() => ({
  addTaskTags: vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 })),
  createProject: vi.fn(async () => ({ id: 'project-cluster' })),
  deleteProject: vi.fn(async () => undefined),
  applyHierarchy: vi.fn(async () => ({ revision: 2 })),
  synchronizeDependency: vi.fn(async (dependency) => dependency),
  removeDependency: vi.fn(
    async (): Promise<{ deleted: boolean; error?: string }> => ({ deleted: true }),
  ),
  findProject: vi.fn(async () => false),
  deleteProjectIfCreationToken: vi.fn(async () => ({
    deleted: true,
    affectedTaskIds: [] as string[],
  })),
  createTagInSource: vi.fn(async () => undefined),
  removeTagFromTask: vi.fn(async () => undefined),
  moveTaskToList: vi.fn(async (): Promise<string | undefined> => 'gh:acme/other#7'),
  evaluateRules: vi.fn(async () => undefined),
  /** Ordered trace used to assert the connector fences and move ordering. */
  order: [] as string[],
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
  publishSemanticEntityUpsert: async () => {
    calls.order.push('semantic:upsert');
  },
  publishSemanticEntityDelete: async () => {
    calls.order.push('semantic:delete');
  },
}));
vi.mock('@/lib/sync/task-dependency-manager', () => ({
  synchronizeCreatedTaskDependency: async (...args: unknown[]) => {
    calls.order.push('dependency:sync');
    return calls.synchronizeDependency(...(args as [unknown]));
  },
  removeTaskDependencyFromSource: async () => {
    calls.order.push('dependency:remote-remove');
    return calls.removeDependency();
  },
}));

/* ── Task-organization collaborators ─────────────────────────────────── */

const connector = {
  id: 'gh-1',
  type: 'github-issues',
  createTagInSource: async (...args: unknown[]) => {
    calls.order.push('connector:createTagInSource');
    return calls.createTagInSource(...(args as []));
  },
  removeTagFromTask: async (...args: unknown[]) => {
    calls.order.push('connector:removeTagFromTask');
    return calls.removeTagFromTask(...(args as []));
  },
  moveTaskToList: async (...args: unknown[]) => {
    calls.order.push('connector:moveTaskToList');
    return calls.moveTaskToList(...(args as []));
  },
};

vi.mock('@/lib/external-identities', () => ({
  executeFencedGitHubSourceMutation: async (input: { write: () => Promise<unknown> }) => {
    calls.order.push('fence:source');
    return input.write();
  },
  executeFencedGitHubTaskMutation: async (input: { write: () => Promise<unknown> }) => {
    calls.order.push('fence:task');
    return input.write();
  },
}));
vi.mock('@/lib/rules', () => ({
  evaluateRulesForTasks: async (...args: unknown[]) => {
    calls.order.push('rules:evaluate');
    return calls.evaluateRules(...(args as []));
  },
}));
vi.mock('@/lib/priority-entities', () => ({
  getResolvedPriorityEntities: async () => [],
}));
vi.mock('@/lib/mode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mode')>();
  return { ...actual, isDemoMode: () => false, isPublicDemoMode: () => false };
});
vi.mock('@/lib/public-demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/public-demo')>();
  return { ...actual, isPublicDemoMode: () => false };
});
vi.mock('@/lib/connectors/capabilities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/connectors/capabilities')>();
  return {
    ...actual,
    getConnectorCapabilities: async () => ({
      ...actual.CAPABILITY_DEFAULTS['github-issues'],
      taskSourceModel: 'remote-managed',
      write: true,
      taskMove: true,
    }),
    isConnectorEnabled: async () => true,
  };
});

interface ConnectorRecord {
  id: string;
  type: string;
  name: string;
  capabilities: Record<string, unknown>;
  settings: Record<string, unknown>;
  syncedLists: string[];
  deletedAt: string | null;
}
interface SourceListRecord {
  id: string;
  connectorInstanceId: string;
  sourceId: string;
  name: string;
  groupId: string | null;
  hidden: boolean;
}

const connectorRow: ConnectorRecord = {
  id: 'gh-1',
  type: 'github-issues',
  name: 'GitHub',
  capabilities: { read: true, write: true, taskCreate: true },
  settings: {},
  syncedLists: ['list-a', 'list-b'],
  deletedAt: null,
};
const sourceLists: SourceListRecord[] = [
  {
    id: 'list-a',
    connectorInstanceId: 'gh-1',
    sourceId: 'acme/repo',
    name: 'acme/repo',
    groupId: null,
    hidden: false,
  },
  {
    id: 'list-b',
    connectorInstanceId: 'gh-1',
    sourceId: 'acme/other',
    name: 'acme/other',
    groupId: null,
    hidden: false,
  },
];

const getConnector = vi.fn(async (id: string) => {
  calls.order.push('management:getConnector');
  return connectorRow.id === id ? connectorRow : null;
});
const getSourceList = vi.fn(async (id: string) => {
  calls.order.push('management:getSourceList');
  return sourceLists.find((list) => list.id === id) ?? null;
});
const getConnectorListSnapshot = vi.fn(async () => {
  calls.order.push('management:getConnectorListSnapshot');
  return {
    connector: connectorRow,
    sourceLists,
    openTaskCounts: [],
    groups: [],
  };
});

vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: async () => ({
    getConnector,
    getSourceList,
    getConnectorListSnapshot,
  }),
}));
vi.mock('@/lib/connectors/runtime', () => ({
  getOrInitializeConnector: async (id: string) => (id === 'gh-1' ? connector : null),
}));

/* Kanban settings ride the selected core settings repository. */
const settingsStore = new Map<string, unknown>();
const settingsGet = vi.fn(async (key: string) => settingsStore.get(key) ?? null);
const settingsSet = vi.fn(async (key: string, value: unknown) => {
  settingsStore.set(key, value);
});
const settingsDelete = vi.fn(async (key: string) => {
  settingsStore.delete(key);
});

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    settings: { get: settingsGet, set: settingsSet, delete: settingsDelete },
  }),
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
      dependencies: [dependency],
      dependencyTasks: [{
        ...task,
        id: 'task-2',
        title: 'Task task-2',
      }],
      projects: [],
      phases: [],
      tags: [],
    }),
    listTasks: async () => [],
    listRelationshipTasks: async (taskIds) => taskIds.map((id) => ({
      id,
      title: `Task ${id}`,
      status: 'todo',
      connectorType: 'local',
      sourceId: `local:${id}`,
      metadata: {},
      projectIds: [],
      projectNames: [],
    })),
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
    createDependency: async () => {
      calls.order.push('dependency:local-commit');
      return {
        kind: 'created',
        dependency,
        blocker: dependencyTask,
        blocked: { ...dependencyTask, id: 'task-2', sourceId: 'local:task-2' },
      };
    },
    getDependencyDeleteContext: async () => {
      calls.order.push('dependency:read-delete-context');
      return {
        kind: 'found',
        dependency,
        blocker: dependencyTask,
        blocked: { ...dependencyTask, id: 'task-2', sourceId: 'local:task-2' },
      };
    },
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

/* ── The selected task-core organization repository ──────────────────── */

function coreTask(
  overrides: Partial<TaskCoreTaskRow> & Pick<TaskCoreTaskRow, 'id'>,
): TaskCoreTaskRow {
  return {
    sourceId: `local:${overrides.id}`,
    connectorType: 'local',
    connectorInstanceId: 'local',
    title: 'Test',
    description: null,
    status: 'todo',
    localDisposition: 'active',
    priority: 'medium',
    planningHorizon: null,
    dueDate: null,
    pushCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    recurrenceGeneratedFromTaskId: null,
    parentId: null,
    depth: 0,
    isChecklistItem: false,
    sourceListId: null,
    sourceListName: null,
    assignee: null,
    microStatus: null,
    statusReason: null,
    metadata: {},
    syncStatus: 'synced',
    lastSyncedAt: '2026-01-01T00:00:00.000Z',
    pushRetryCount: 0,
    kanbanColumn: null,
    kanbanOrder: null,
    snoozedUntil: null,
    reminderAt: null,
    reminderRelative: null,
    reminderDueTime: null,
    effort: null,
    isBulkImport: false,
    ...overrides,
  };
}

const TAG_ROW = {
  id: 'tag-1',
  name: 'Alpha',
  slug: 'alpha',
  type: 'hub',
  color: '#ff0000',
};
const TAG_OVERVIEW: TagOverviewResult = {
  tags: [{
    ...TAG_ROW,
    source: null,
    confirmed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    unifiedInto: null,
    usageCount: 1,
    sources: ['github-issues'],
    sourceNames: ['acme/repo'],
    listUsage: [],
    sourceUsage: [],
  }],
  sourceTagSlugs: ['bug'],
};
const TEMPLATE_ROW = {
  id: 'template-1',
  name: 'Template',
  description: 'A template',
  category: 'work',
  type: 'single',
  subtasks: [{ title: 'Step', priority: 'medium', estimatedMinutes: 15 }],
  workflowTasks: null,
  icon: null,
  isBuiltIn: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const state = {
  previewSnapshot: null as TaskMovePreviewSnapshot | null,
  templateType: 'single' as 'single' | 'workflow',
  templateDelete: 'deleted' as 'deleted' | 'missing' | 'built-in',
};

const organization = {
  readTagOverview: vi.fn(async () => TAG_OVERVIEW),
  createHubTag: vi.fn(async () => ({ kind: 'created' as const, tag: TAG_ROW })),
  updateTag: vi.fn(async () => ({ affectedTaskIds: ['task-1'] })),
  deleteHubTag: vi.fn(async () => ({
    kind: 'deleted' as const,
    affectedTaskIds: ['task-1'],
  })),
  getTagConsolidationCandidates: vi.fn(async () => ({
    target: { id: 'tag-1', name: 'Alpha', type: 'hub' },
    sources: [{ id: 'tag-2', name: 'Beta', type: 'hub' }],
  })),
  mergeTags: vi.fn(async () => ({ kind: 'merged' as const, reassigned: 2 })),
  unifyTags: vi.fn(async () => ({
    kind: 'unified' as const,
    linked: 2,
    detached: 0,
    detachedTaskIds: [] as string[],
    localTagIds: ['tag-2'],
    targetIsSourceBacked: false,
  })),
  listTaskIdsForTag: vi.fn(async () => ['task-1']),
  getTagPushSubject: vi.fn(async () => TAG_ROW),
  getTagSourceRemovalContext: vi.fn(async () => ({
    tag: { id: 'tag-1', name: 'Alpha' },
    tasks: [
      { id: 'task-1', sourceId: 'acme/repo#1', connectorInstanceId: 'gh-1' },
      { id: 'task-2', sourceId: 'acme/repo#2', connectorInstanceId: 'gh-1' },
      { id: 'task-3', sourceId: 'local:task-3', connectorInstanceId: 'local' },
    ],
  })),
  ensureBuiltInSubtaskTemplates: vi.fn(async () => undefined),
  listSubtaskTemplates: vi.fn(async () => [TEMPLATE_ROW]),
  getSubtaskTemplate: vi.fn(async () => TEMPLATE_ROW),
  getSubtaskTemplateApplicationPlan: vi.fn(async () => (
    state.templateType === 'workflow'
      ? {
          id: 'template-1',
          type: 'workflow',
          subtasks: [],
          workflowTasks: [{
            title: 'Phase one',
            description: null,
            priority: 'high',
            subtasks: ['Step A', 'Step B'],
            tags: [],
          }],
        }
      : {
          id: 'template-1',
          type: 'single',
          subtasks: [{ title: 'Step', priority: 'medium', estimatedMinutes: 15 }],
          workflowTasks: [],
        }
  )),
  createSubtaskTemplate: vi.fn(async () => TEMPLATE_ROW),
  updateSubtaskTemplate: vi.fn(async () => TEMPLATE_ROW),
  deleteSubtaskTemplate: vi.fn(async () => ({ kind: state.templateDelete })),
  applyWorkflowTemplate: vi.fn(async () => undefined),
  applySingleTemplate: vi.fn(
    async (): Promise<{ kind: 'applied' | 'missing-parent' }> => ({ kind: 'applied' }),
  ),
  getTaskMoveToListContext: vi.fn(async (taskId: string) => ({
    id: taskId,
    sourceId: 'acme/repo#1',
    connectorType: 'github-issues',
    connectorInstanceId: 'gh-1',
    sourceListId: 'acme/repo',
  })),
  finalizeTaskMoveToList: vi.fn(async () => {
    calls.order.push('organization:finalizeTaskMoveToList');
  }),
  getTaskMovePreviewSnapshot: vi.fn(async () => state.previewSnapshot),
  readSmartScoreInputs: vi.fn(async () => ({
    tasks: [coreTask({ id: 'task-1', title: 'Scored' })],
    sourceRankings: [{
      id: 'gh-1',
      connectorType: 'github-issues',
      name: 'GitHub',
      rank: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    }],
    taskTags: [{ taskId: 'task-1', tagId: 'tag-1', tagName: 'Alpha' }],
    taskProjects: [],
    estimatedDurations: [{ taskId: 'task-1', estimatedDuration: 30 }],
  })),
};

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    organization,
    filterInputs: {
      listMyDayTaskIds: async () => [],
      listAssignedGitHubUsernames: async () => [],
      listInboxListEntries: async () => [],
    },
    policyIdentities: {
      getTaskSourceIdentity: async (taskId: string) => ({
        id: taskId,
        sourceId: `local:${taskId}`,
        connectorType: 'local',
        connectorInstanceId: 'local',
      }),
      getDependencyEndpoints: async () => ({
        taskId: dependency.taskId,
        dependsOnTaskId: dependency.dependsOnTaskId,
      }),
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
    calls.order.length = 0;
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

  it('serves the task relationship facade from PostgreSQL-shaped collaborators', async () => {
    const relationships = await import('@/app/api/tasks/[id]/relationships/route');
    const listed = await relationships.GET(
      request('/api/tasks/task-1/relationships'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(listed.status).toBe(200);
    const body = await listed.json();
    // Proves the presentation rows come from `neighbors.listRelationshipTasks`
    // rather than a route-side SQLite join.
    expect(body.relationships).toEqual([
      expect.objectContaining({
        direction: 'outgoing',
        task: expect.objectContaining({ id: 'task-2', title: 'Task task-2' }),
      }),
    ]);

    const created = await relationships.POST(
      request('/api/tasks/task-1/relationships', {
        method: 'POST',
        body: JSON.stringify({
          relatedTaskId: 'task-2',
          type: 'blocks',
          direction: 'outgoing',
        }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(created.status).toBe(201);
    // Create commits locally first, then synchronizes to the source.
    expect(calls.synchronizeDependency).toHaveBeenCalledOnce();

    const remove = await import('@/app/api/tasks/[id]/relationships/[relationshipId]/route');
    const deleted = await remove.DELETE(
      request('/api/tasks/task-1/relationships/dependency-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'task-1', relationshipId: 'dependency-1' }) },
    );
    expect(deleted.status).toBe(200);
    // Delete is remote-first: the source removal runs before the durable delete.
    expect(calls.removeDependency).toHaveBeenCalledOnce();
  }, 15_000);

  it('surfaces a refused source removal as 502 without deleting locally', async () => {
    calls.removeDependency.mockResolvedValueOnce({
      deleted: false,
      error: 'Source refused the removal',
    });
    const remove = await import('@/app/api/tasks/[id]/relationships/[relationshipId]/route');
    const response = await remove.DELETE(
      request('/api/tasks/task-1/relationships/dependency-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'task-1', relationshipId: 'dependency-1' }) },
    );
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'Source refused the removal' });
  });

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


function post(path: string, body: unknown, method = 'POST') {
  return request(path, { method, body: JSON.stringify(body) });
}

/**
 * The same poisoned module graph, applied to every route the task-organization
 * migration owns. A surviving direct-persistence import would blow these up at
 * evaluation time rather than fail an assertion.
 */
describe('poisoned-SQLite task-organization routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calls.order.length = 0;
    settingsStore.clear();
    state.previewSnapshot = null;
    state.templateType = 'single';
    state.templateDelete = 'deleted';
  });

  it('proves the SQLite persistence modules really are poisoned', async () => {
    await expect(import('@/db')).rejects.toThrow();
    await expect(import('@/db/schema')).rejects.toThrow();
    await expect(import('@/db/persistence/sqlite-task-core-repositories'))
      .rejects.toThrow();
    await expect(import('better-sqlite3')).rejects.toThrow();
  });

  /* ── Tags ──────────────────────────────────────────────────────────── */

  it('serves the tag overview, create, update and delete from the selected runtime', async () => {
    const route = await import('@/app/api/tags/route');

    const list = await route.GET(request('/api/tags?type=hub&source=github-issues&listId=list-a'));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({
      tags: TAG_OVERVIEW.tags,
      sourceTagSlugs: ['bug'],
    });
    expect(organization.readTagOverview).toHaveBeenCalledWith({
      type: 'hub',
      source: 'github-issues',
      listId: 'list-a',
      includeUsageBreakdown: false,
    });

    const created = await route.POST(post('/api/tags', { name: 'Alpha', color: '#ff0000' }));
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({
      id: 'tag-alpha',
      name: 'Alpha',
      slug: 'alpha',
      type: 'hub',
      color: '#ff0000',
    });
    expect(organization.createHubTag).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'tag-alpha', slug: 'alpha', color: '#ff0000' }),
    );

    const patched = await route.PATCH(post('/api/tags', { id: 'tag-1', name: 'Renamed' }, 'PATCH'));
    expect(patched.status).toBe(200);
    expect(organization.updateTag).toHaveBeenCalled();

    const deleted = await route.DELETE(request('/api/tags?id=tag-1', { method: 'DELETE' }));
    expect(deleted.status).toBe(200);
    expect(organization.deleteHubTag).toHaveBeenCalledWith('tag-1');
  });

  it('merges tags and evaluates rules only after the durable merge', async () => {
    const route = await import('@/app/api/tags/merge/route');
    const response = await route.POST(post('/api/tags/merge', {
      targetTagId: 'tag-1',
      sourceTagIds: ['tag-2'],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      merged: 1,
      reassigned: 2,
    });
    expect(organization.mergeTags).toHaveBeenCalled();
    expect(calls.order).toContain('rules:evaluate');
  });

  it('unifies tags and publishes the semantic upsert after the durable write', async () => {
    const route = await import('@/app/api/tags/unify/route');
    const response = await route.POST(post('/api/tags/unify', {
      targetTagId: 'tag-1',
      sourceTagIds: ['tag-2'],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true, unified: 1, linked: 2 });
    expect(organization.unifyTags).toHaveBeenCalled();
    expect(calls.order).toContain('semantic:upsert');
  });

  it('rejects a stale unify before touching any collaborator', async () => {
    organization.getTagConsolidationCandidates.mockResolvedValueOnce({
      target: { id: 'tag-1', name: 'Alpha', type: 'hub' },
      sources: [],
    });
    const route = await import('@/app/api/tags/unify/route');
    const response = await route.POST(post('/api/tags/unify', {
      targetTagId: 'tag-1',
      sourceTagIds: ['ghost'],
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'One or more source tags not found',
    });
    expect(organization.unifyTags).not.toHaveBeenCalled();
  });

  it('pushes a tag through the GitHub fence after validating the list', async () => {
    const route = await import('@/app/api/tags/push/route');
    const response = await route.POST(post('/api/tags/push', {
      tagId: 'tag-1',
      sourceListId: 'list-a',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    // Read/validate, then fence, then the single remote write.
    expect(calls.order).toEqual([
      'management:getSourceList',
      'management:getConnector',
      'fence:source',
      'connector:createTagInSource',
    ]);
    expect(calls.createTagInSource).toHaveBeenCalledWith('acme/repo', 'Alpha', '#ff0000');
  });

  it('removes a tag from every source task sequentially, reporting partial errors', async () => {
    calls.removeTagFromTask
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));

    const route = await import('@/app/api/tags/remove-from-source/route');
    const response = await route.POST(post('/api/tags/remove-from-source', {
      tagId: 'tag-1',
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      removed: 1,
      errors: ['acme/repo#2: boom'],
    });
    // One connector group, two fenced writes in order, the local task skipped.
    expect(calls.order).toEqual([
      'management:getConnector',
      'fence:task',
      'connector:removeTagFromTask',
      'fence:task',
      'connector:removeTagFromTask',
    ]);
  });

  /* ── Subtask templates ─────────────────────────────────────────────── */

  it('runs the whole subtask-template surface off the selected runtime', async () => {
    const route = await import('@/app/api/subtask-templates/route');

    const list = await route.GET(request('/api/subtask-templates?category=work&type=single'));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ templates: [TEMPLATE_ROW] });
    expect(organization.ensureBuiltInSubtaskTemplates).toHaveBeenCalled();
    expect(organization.listSubtaskTemplates).toHaveBeenCalledWith({
      category: 'work',
      type: 'single',
    });

    const created = await route.POST(post('/api/subtask-templates', {
      name: 'Template',
      subtasks: [{ title: 'Step' }],
    }));
    expect(created.status).toBe(201);

    const patched = await route.PATCH(post('/api/subtask-templates', {
      id: 'template-1',
      name: 'Renamed',
    }, 'PATCH'));
    expect(patched.status).toBe(200);

    const deleted = await route.DELETE(
      request('/api/subtask-templates?id=template-1', { method: 'DELETE' }),
    );
    expect(deleted.status).toBe(200);
  });

  it('refuses to delete a built-in template', async () => {
    state.templateDelete = 'built-in';
    const route = await import('@/app/api/subtask-templates/route');
    const response = await route.DELETE(
      request('/api/subtask-templates?id=template-1', { method: 'DELETE' }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'Cannot delete built-in templates',
    });
  });

  it('applies a single template atomically through the selected runtime', async () => {
    const route = await import('@/app/api/subtask-templates/route');
    const response = await route.PUT(post('/api/subtask-templates', {
      templateId: 'template-1',
      parentTaskId: 'task-1',
    }, 'PUT'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      templateType: 'single',
      parentTaskId: 'task-1',
      subtasksCreated: 1,
    });
    expect(organization.applySingleTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'template-1', parentTaskId: 'task-1' }),
    );
    expect(organization.applyWorkflowTemplate).not.toHaveBeenCalled();
  });

  it('applies a workflow template atomically through the selected runtime', async () => {
    state.templateType = 'workflow';
    const route = await import('@/app/api/subtask-templates/route');
    const response = await route.PUT(post('/api/subtask-templates', {
      templateId: 'template-1',
      connectorType: 'local',
    }, 'PUT'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      templateType: 'workflow',
      tasksCreated: 1,
    });
    expect(organization.applyWorkflowTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'template-1', isLocalOnly: true }),
    );
  });

  it('reports a missing parent task instead of a partial application', async () => {
    organization.applySingleTemplate.mockResolvedValueOnce({ kind: 'missing-parent' });
    const route = await import('@/app/api/subtask-templates/route');
    const response = await route.PUT(post('/api/subtask-templates', {
      templateId: 'template-1',
      parentTaskId: 'ghost',
    }, 'PUT'));
    expect(response.status).toBe(404);
  });

  /* ── Kanban settings ───────────────────────────────────────────────── */

  it('reads, writes and resets kanban columns through the core settings repository', async () => {
    const route = await import('@/app/api/kanban-settings/route');

    const defaults = await route.GET();
    expect(defaults.status).toBe(200);
    expect(await defaults.json()).toMatchObject({ isDefault: true });

    const saved = await route.PUT(post('/api/kanban-settings', {
      columns: [{ id: 'todo', title: 'Todo' }],
    }, 'PUT'));
    expect(saved.status).toBe(200);
    expect(settingsSet).toHaveBeenCalled();

    const stored = await route.GET();
    expect(await stored.json()).toMatchObject({ isDefault: false });

    const reset = await route.DELETE();
    expect(reset.status).toBe(200);
    expect(settingsDelete).toHaveBeenCalled();

    const empty = await route.PUT(post('/api/kanban-settings', { columns: [] }, 'PUT'));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      error: 'At least one column is required',
    });
  });

  /* ── Smart score ───────────────────────────────────────────────────── */

  it('scores tasks from the selected runtime snapshot', async () => {
    const route = await import('@/app/api/smart-score/route');
    const response = await route.GET(request('/api/smart-score'));

    expect(response.status).toBe(200);
    const body = await response.json() as {
      scores: unknown[];
      total: number;
      hasSourceRankings: boolean;
    };
    expect(body.total).toBe(1);
    expect(body.scores).toHaveLength(1);
    expect(body.hasSourceRankings).toBe(true);
    expect(organization.readSmartScoreInputs).toHaveBeenCalled();
  });

  /* ── Within-source move ────────────────────────────────────────────── */

  it('validates, moves remotely once, then finalizes locally', async () => {
    const route = await import('@/app/api/tasks/[id]/move-to-list/route');
    const response = await route.POST(
      post('/api/tasks/task-1/move-to-list', { targetListId: 'list-b' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      newSourceId: 'gh:acme/other#7',
      previousListId: 'list-a',
    });
    expect(calls.moveTaskToList).toHaveBeenCalledTimes(1);
    // Read/validate, then a single remote move, then the local finalize.
    const order = calls.order.filter((entry) =>
      entry === 'management:getSourceList'
      || entry === 'connector:moveTaskToList'
      || entry === 'organization:finalizeTaskMoveToList');
    expect(order).toEqual([
      'management:getSourceList',
      'connector:moveTaskToList',
      'organization:finalizeTaskMoveToList',
    ]);
  });

  it('does not finalize locally when the remote move fails', async () => {
    calls.moveTaskToList.mockRejectedValueOnce(new Error('remote down'));
    const route = await import('@/app/api/tasks/[id]/move-to-list/route');
    const response = await route.POST(
      post('/api/tasks/task-1/move-to-list', { targetListId: 'list-b' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(502);
    expect(organization.finalizeTaskMoveToList).not.toHaveBeenCalled();
  });

  it('rejects a target list that belongs to another source', async () => {
    organization.getTaskMoveToListContext.mockResolvedValueOnce({
      id: 'task-1',
      sourceId: 'other:1',
      connectorType: 'github-issues',
      connectorInstanceId: 'gh-other',
      sourceListId: 'acme/repo',
    });
    const route = await import('@/app/api/tasks/[id]/move-to-list/route');
    const response = await route.POST(
      post('/api/tasks/task-1/move-to-list', { targetListId: 'list-b' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(400);
    expect(calls.moveTaskToList).not.toHaveBeenCalled();
  });

  /* ── Cross-connector move preview ──────────────────────────────────── */

  it('previews a cross-connector move from the selected snapshot', async () => {
    state.previewSnapshot = {
      task: coreTask({
        id: 'task-1',
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        sourceId: 'todo:1',
      }),
      tags: [{ name: 'Alpha', slug: 'alpha' }],
      subtaskCount: 2,
      schedule: null,
      storedAttachmentCount: 0,
      storedAttachmentSourceIds: [],
      projectCount: 1,
    };

    const route = await import('@/app/api/tasks/move/preview/route');
    const response = await route.POST(post('/api/tasks/move/preview', {
      taskId: 'task-1',
      targetConnectorInstanceId: 'gh-1',
      targetSourceListId: 'acme/repo',
    }));

    expect(response.status).toBe(200);
    expect(organization.getTaskMovePreviewSnapshot).toHaveBeenCalledWith('task-1');
  });

  it('reports a missing task before consulting the connector', async () => {
    const route = await import('@/app/api/tasks/move/preview/route');
    const response = await route.POST(post('/api/tasks/move/preview', {
      taskId: 'ghost',
      targetConnectorInstanceId: 'gh-1',
    }));

    expect(response.status).toBe(404);
    expect(getConnector).not.toHaveBeenCalled();
  });

  it('rejects a preview that names the same source as the destination', async () => {
    state.previewSnapshot = {
      task: coreTask({
        id: 'task-1',
        connectorType: 'github-issues',
        connectorInstanceId: 'gh-1',
        sourceId: 'acme/repo#1',
        sourceListId: 'acme/repo',
      }),
      tags: [],
      subtaskCount: 0,
      schedule: null,
      storedAttachmentCount: 0,
      storedAttachmentSourceIds: [],
      projectCount: 0,
    };

    const route = await import('@/app/api/tasks/move/preview/route');
    const response = await route.POST(post('/api/tasks/move/preview', {
      taskId: 'task-1',
      targetConnectorInstanceId: 'gh-1',
      targetSourceListId: 'acme/repo',
    }));

    expect(response.status).toBe(409);
  });

  /* ── Relationships (graph facade) ──────────────────────────────────── */

  it('commits a dependency locally before syncing it to the source', async () => {
    const route = await import('@/app/api/tasks/[id]/relationships/route');
    const response = await route.POST(
      post('/api/tasks/task-2/relationships', {
        relatedTaskId: 'task-1',
        type: 'blocks',
        direction: 'outgoing',
      }),
      { params: Promise.resolve({ id: 'task-2' }) },
    );

    expect(response.status).toBe(201);
    expect(calls.order.indexOf('dependency:local-commit'))
      .toBeLessThan(calls.order.indexOf('dependency:sync'));
  });

  it('removes a dependency at the source before the durable delete', async () => {
    const route = await import(
      '@/app/api/tasks/[id]/relationships/[relationshipId]/route'
    );
    const response = await route.DELETE(
      request('/api/tasks/task-2/relationships/dependency-1', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'task-2', relationshipId: 'dependency-1' }) },
    );

    expect(response.status).toBe(200);
    // Validate, then hand the edge to the source; the durable delete only
    // happens once the source has released it.
    expect(calls.order).toEqual([
      'dependency:read-delete-context',
      'dependency:remote-remove',
    ]);
    expect(calls.removeDependency).toHaveBeenCalledTimes(1);
  });
});