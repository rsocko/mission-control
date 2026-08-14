import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  assignTasksToProject,
  removeTasksFromProject,
} = vi.hoisted(() => ({
  assignTasksToProject: vi.fn(),
  removeTasksFromProject: vi.fn(),
}));

class MockProjectHierarchyServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

vi.mock('@/lib/projects/hierarchy-service', () => ({
  assignTasksToProject,
  removeTasksFromProject,
  ProjectHierarchyServiceError: MockProjectHierarchyServiceError,
}));

beforeEach(() => {
  assignTasksToProject.mockReset().mockResolvedValue({});
  removeTasksFromProject.mockReset().mockResolvedValue({});
});

describe('POST /api/hub-projects/[id]/tasks', () => {
  it('delegates project and phase assignment to the hierarchy service', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');
    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: 'phase-2' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(assignTasksToProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-1'],
      phaseId: 'phase-2',
      actor: { type: 'user' },
    });
  });

  it('distinguishes omitted phase selection from explicit No phase', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');
    await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );
    await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: null }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(assignTasksToProject).toHaveBeenNthCalledWith(1, expect.objectContaining({
      phaseId: undefined,
    }));
    expect(assignTasksToProject).toHaveBeenNthCalledWith(2, expect.objectContaining({
      phaseId: null,
    }));
  });

  it('rejects an invalid phase value before service invocation', async () => {
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');
    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1', phaseId: 42 }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    expect(assignTasksToProject).not.toHaveBeenCalled();
  });

  it('maps hierarchy authorization errors to the legacy response', async () => {
    assignTasksToProject.mockRejectedValueOnce(new MockProjectHierarchyServiceError(
      'Projects are controlled by the upstream task source',
      403,
      'TASK_MUTATION_BLOCKED',
    ));
    const { POST } = await import('@/app/api/hub-projects/[id]/tasks/route');
    const response = await POST(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'POST',
        body: JSON.stringify({ taskId: 'task-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: 'Projects are controlled by the upstream task source',
      code: 'TASK_MUTATION_BLOCKED',
    });
  });
});

describe('DELETE /api/hub-projects/[id]/tasks', () => {
  it('delegates project removal to the hierarchy service', async () => {
    const { DELETE } = await import('@/app/api/hub-projects/[id]/tasks/route');
    const response = await DELETE(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'DELETE',
        body: JSON.stringify({ taskId: 'task-1' }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(removeTasksFromProject).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskIds: ['task-1'],
      actor: { type: 'user' },
    });
  });

  it('rejects a missing task ID before service invocation', async () => {
    const { DELETE } = await import('@/app/api/hub-projects/[id]/tasks/route');
    const response = await DELETE(
      new Request('http://localhost/api/hub-projects/project-1/tasks', {
        method: 'DELETE',
        body: JSON.stringify({}),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    expect(removeTasksFromProject).not.toHaveBeenCalled();
  });
});
