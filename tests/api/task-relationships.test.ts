import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createGlobalTaskDependency,
  deleteGlobalTaskDependency,
  getStoredRelationshipMutationPolicies,
  getTaskRelationships,
  searchTaskRelationshipCandidates,
} = vi.hoisted(() => ({
  createGlobalTaskDependency: vi.fn(),
  deleteGlobalTaskDependency: vi.fn(),
  getStoredRelationshipMutationPolicies: vi.fn(),
  getTaskRelationships: vi.fn(),
  searchTaskRelationshipCandidates: vi.fn(),
}));

class MockGraphServiceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) {
    super(message);
  }
}

vi.mock('@/lib/graph/service', () => ({
  createGlobalTaskDependency,
  deleteGlobalTaskDependency,
  getTaskRelationships,
  searchTaskRelationshipCandidates,
  GraphServiceError: MockGraphServiceError,
}));

vi.mock('@/lib/tasks/mutation-policy', () => ({
  getStoredTaskMutationPolicy: vi.fn(async (_taskId: string, field: string) => ({
    task: {},
    capabilities: null,
    policy: { field, sourceModel: 'mc-owned', mutation: 'local', inbound: 'local-wins' },
  })),
  getStoredRelationshipMutationPolicies,
}));

beforeEach(() => {
  vi.clearAllMocks();
  getStoredRelationshipMutationPolicies.mockResolvedValue([{
    task: {},
    capabilities: null,
    policy: {
      field: 'dependencies',
      sourceModel: 'mc-owned',
      mutation: 'local',
      inbound: 'local-wins',
    },
  }]);
});

describe('/api/tasks/[id]/relationships', () => {
  it('lists global relationships with service-provided direction and sync state', async () => {
    getTaskRelationships.mockResolvedValue({
      relationships: [{
        edge: {
          id: 'dependency:relationship-1',
          source: 'task:task-2',
          target: 'task:task-1',
          type: 'blocks',
          provenance: 'explicit',
          syncStatus: 'failed',
          syncAction: 'create',
          syncError: 'GitHub denied the update',
          lastSyncedAt: '2026-07-31T12:00:00.000Z',
        },
        direction: 'incoming',
      }],
      pageInfo: { truncated: false },
    });
    const { GET } = await import('@/app/api/tasks/[id]/relationships/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/relationships'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      relationships: [expect.objectContaining({
        direction: 'incoming',
        edge: expect.objectContaining({
          provenance: 'explicit',
          syncStatus: 'failed',
          syncError: 'GitHub denied the update',
          lastSyncedAt: '2026-07-31T12:00:00.000Z',
        }),
      })],
      pageInfo: { truncated: false },
    });
  });

  it.each([
    ['outgoing', 'task-1', 'task-2'],
    ['incoming', 'task-2', 'task-1'],
  ])('translates %s blocking direction without project scope', async (
    direction,
    sourceTaskId,
    targetTaskId,
  ) => {
    createGlobalTaskDependency.mockResolvedValue({ id: 'relationship-1' });
    const { POST } = await import('@/app/api/tasks/[id]/relationships/route');
    const response = await POST(
      new Request('http://localhost/api/tasks/task-1/relationships', {
        method: 'POST',
        body: JSON.stringify({
          relatedTaskId: 'task-2',
          type: 'blocks',
          direction,
        }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(201);
    expect(createGlobalTaskDependency).toHaveBeenCalledWith({
      sourceTaskId,
      targetTaskId,
      type: 'blocks',
    });
  });

  it('creates symmetric related links and surfaces validation conflicts', async () => {
    createGlobalTaskDependency.mockRejectedValue(
      new MockGraphServiceError('This dependency already exists', 409),
    );
    const { POST } = await import('@/app/api/tasks/[id]/relationships/route');
    const response = await POST(
      new Request('http://localhost/api/tasks/task-1/relationships', {
        method: 'POST',
        body: JSON.stringify({ relatedTaskId: 'task-2', type: 'related' }),
      }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'This dependency already exists' });
  });

  it('deletes only through the current task scope and surfaces connector errors', async () => {
    deleteGlobalTaskDependency.mockRejectedValue(
      new MockGraphServiceError('GitHub rejected dependency removal', 502),
    );
    const { DELETE } = await import(
      '@/app/api/tasks/[id]/relationships/[relationshipId]/route'
    );
    const response = await DELETE(
      new Request('http://localhost/api/tasks/task-1/relationships/relationship-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1', relationshipId: 'relationship-1' }) },
    );

    expect(deleteGlobalTaskDependency).toHaveBeenCalledWith({
      taskId: 'task-1',
      dependencyId: 'relationship-1',
    });
    expect(response.status).toBe(502);
  });

  it('blocks deletion when either relationship endpoint is source-controlled', async () => {
    getStoredRelationshipMutationPolicies.mockResolvedValue([
      {
        task: {},
        capabilities: null,
        policy: {
          field: 'dependencies',
          sourceModel: 'mc-owned',
          mutation: 'local',
          inbound: 'local-wins',
        },
      },
      {
        task: {},
        capabilities: null,
        policy: {
          field: 'dependencies',
          sourceModel: 'remote-mirror',
          mutation: 'blocked',
          inbound: 'source-wins',
          reason: 'This field is source-controlled',
        },
      },
    ]);
    const { DELETE } = await import(
      '@/app/api/tasks/[id]/relationships/[relationshipId]/route'
    );
    const response = await DELETE(
      new Request('http://localhost/api/tasks/task-1/relationships/relationship-1', {
        method: 'DELETE',
      }),
      { params: Promise.resolve({ id: 'task-1', relationshipId: 'relationship-1' }) },
    );

    expect(response.status).toBe(403);
    expect(deleteGlobalTaskDependency).not.toHaveBeenCalled();
  });

  it('uses a bounded global candidate search service', async () => {
    searchTaskRelationshipCandidates.mockResolvedValue([{
      id: 'task-2',
      title: 'Across projects',
    }]);
    const { GET } = await import('@/app/api/tasks/[id]/relationship-candidates/route');
    const response = await GET(
      new Request('http://localhost/api/tasks/task-1/relationship-candidates?query=across&limit=20'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(searchTaskRelationshipCandidates).toHaveBeenCalledWith('task-1', 'across', 20);
  });
});
