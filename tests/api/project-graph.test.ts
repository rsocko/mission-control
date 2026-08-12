import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProjectSubgraph = vi.fn();
const createTaskDependency = vi.fn();
const deleteTaskDependency = vi.fn();

class MockGraphServiceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 502) {
    super(message);
  }
}

vi.mock('@/lib/graph/service', () => ({
  getProjectSubgraph,
  createTaskDependency,
  deleteTaskDependency,
  GraphServiceError: MockGraphServiceError,
}));

beforeEach(() => {
  getProjectSubgraph.mockReset();
  createTaskDependency.mockReset();
  deleteTaskDependency.mockReset();
});

describe('DELETE /api/projects/[id]/task-dependencies/[dependencyId]', () => {
  it('removes a dependency through the graph service', async () => {
    deleteTaskDependency.mockResolvedValue({ deleted: true });
    const { DELETE } = await import(
      '@/app/api/projects/[id]/task-dependencies/[dependencyId]/route'
    );

    const response = await DELETE(
      new Request('http://localhost/api/projects/project-1/task-dependencies/dependency-1', {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({
          id: 'project-1',
          dependencyId: 'dependency-1',
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(deleteTaskDependency).toHaveBeenCalledWith({
      projectId: 'project-1',
      dependencyId: 'dependency-1',
    });
  });

  it('surfaces source removal failures', async () => {
    deleteTaskDependency.mockRejectedValue(
      new MockGraphServiceError('GitHub rejected dependency removal', 502),
    );
    const { DELETE } = await import(
      '@/app/api/projects/[id]/task-dependencies/[dependencyId]/route'
    );

    const response = await DELETE(
      new Request('http://localhost/api/projects/project-1/task-dependencies/dependency-1', {
        method: 'DELETE',
      }),
      {
        params: Promise.resolve({
          id: 'project-1',
          dependencyId: 'dependency-1',
        }),
      },
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: 'GitHub rejected dependency removal',
    });
  });
});

describe('GET /api/projects/[id]/graph', () => {
  it('returns a bounded project graph', async () => {
    getProjectSubgraph.mockResolvedValue({ nodes: [], edges: [], truncated: false });
    const { GET } = await import('@/app/api/projects/[id]/graph/route');

    const response = await GET(
      new Request('http://localhost/api/projects/project-1/graph?limit=5000'),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(getProjectSubgraph).toHaveBeenCalledWith('project-1', 1000);
  });

  it('returns 404 for a missing project', async () => {
    getProjectSubgraph.mockResolvedValue(null);
    const { GET } = await import('@/app/api/projects/[id]/graph/route');

    const response = await GET(
      new Request('http://localhost/api/projects/missing/graph'),
      { params: Promise.resolve({ id: 'missing' }) },
    );

    expect(response.status).toBe(404);
  });
});

describe('POST /api/projects/[id]/task-dependencies', () => {
  it('creates a validated dependency', async () => {
    createTaskDependency.mockResolvedValue({ id: 'dependency-1' });
    const { POST } = await import('@/app/api/projects/[id]/task-dependencies/route');

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/task-dependencies', {
        method: 'POST',
        body: JSON.stringify({
          sourceTaskId: 'task-1',
          targetTaskId: 'task-2',
          type: 'blocks',
        }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(201);
    expect(createTaskDependency).toHaveBeenCalledWith({
      projectId: 'project-1',
      sourceTaskId: 'task-1',
      targetTaskId: 'task-2',
      type: 'blocks',
    });
  });

  it('rejects malformed dependency input', async () => {
    const { POST } = await import('@/app/api/projects/[id]/task-dependencies/route');
    const response = await POST(
      new Request('http://localhost/api/projects/project-1/task-dependencies', {
        method: 'POST',
        body: JSON.stringify({ sourceTaskId: 'task-1', type: 'unknown' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    expect(createTaskDependency).not.toHaveBeenCalled();
  });

  it('surfaces graph validation conflicts', async () => {
    createTaskDependency.mockRejectedValue(
      new MockGraphServiceError('This dependency would create a cycle', 409),
    );
    const { POST } = await import('@/app/api/projects/[id]/task-dependencies/route');
    const response = await POST(
      new Request('http://localhost/api/projects/project-1/task-dependencies', {
        method: 'POST',
        body: JSON.stringify({
          sourceTaskId: 'task-1',
          targetTaskId: 'task-2',
          type: 'blocks',
        }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'This dependency would create a cycle',
    });
  });
});
