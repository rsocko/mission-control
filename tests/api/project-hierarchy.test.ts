import { beforeEach, describe, expect, it, vi } from 'vitest';

const getProjectHierarchySnapshot = vi.fn();
const applyProjectHierarchyCommand = vi.fn();

class MockProjectHierarchyServiceError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409,
    readonly code: string,
    readonly current?: unknown,
  ) {
    super(message);
  }
}

vi.mock('@/lib/projects/hierarchy-service', () => ({
  getProjectHierarchySnapshot,
  applyProjectHierarchyCommand,
  ProjectHierarchyServiceError: MockProjectHierarchyServiceError,
}));

beforeEach(() => {
  getProjectHierarchySnapshot.mockReset();
  applyProjectHierarchyCommand.mockReset();
});

describe('/api/projects/[id]/hierarchy', () => {
  it('returns a hierarchy snapshot', async () => {
    const hierarchy = {
      projectId: 'project-1',
      revision: 2,
      phases: [],
      phaseItemsByPhase: {},
    };
    getProjectHierarchySnapshot.mockReturnValue(hierarchy);
    const { GET } = await import('@/app/api/projects/[id]/hierarchy/route');

    const response = await GET(
      new Request('http://localhost/api/projects/project-1/hierarchy'),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ hierarchy });
  });

  it('rejects malformed commands before calling the service', async () => {
    const { POST } = await import('@/app/api/projects/[id]/hierarchy/route');
    const response = await POST(
      new Request('http://localhost/api/projects/project-1/hierarchy', {
        method: 'POST',
        body: JSON.stringify({
          commandId: 'not-a-uuid',
          expectedRevision: -1,
          command: { type: 'move_tasks', taskIds: [] },
        }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(400);
    expect(applyProjectHierarchyCommand).not.toHaveBeenCalled();
  });

  it('applies a validated project-scoped command', async () => {
    const result = {
      commandId: '88888888-8888-4888-8888-888888888888',
      revision: 1,
      hierarchy: {
        projectId: 'project-1',
        revision: 1,
        phases: [],
        phaseItemsByPhase: {},
      },
      inverseCommand: { type: 'reorder_phases', orderedPhaseIds: ['phase-1'] },
    };
    applyProjectHierarchyCommand.mockReturnValue(result);
    const { POST } = await import('@/app/api/projects/[id]/hierarchy/route');
    const request = {
      commandId: result.commandId,
      expectedRevision: 0,
      command: { type: 'reorder_phases', orderedPhaseIds: ['phase-1'] },
    };

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/hierarchy', {
        method: 'POST',
        body: JSON.stringify(request),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(200);
    expect(applyProjectHierarchyCommand).toHaveBeenCalledWith({
      projectId: 'project-1',
      request,
      actor: { type: 'user' },
    });
    expect(await response.json()).toEqual(result);
  });

  it('returns the latest snapshot with revision conflicts', async () => {
    const current = {
      projectId: 'project-1',
      revision: 3,
      phases: [],
      phaseItemsByPhase: {},
    };
    applyProjectHierarchyCommand.mockImplementation(() => {
      throw new MockProjectHierarchyServiceError(
        'Project hierarchy changed',
        409,
        'HIERARCHY_REVISION_CONFLICT',
        current,
      );
    });
    const { POST } = await import('@/app/api/projects/[id]/hierarchy/route');

    const response = await POST(
      new Request('http://localhost/api/projects/project-1/hierarchy', {
        method: 'POST',
        body: JSON.stringify({
          commandId: '99999999-9999-4999-8999-999999999999',
          expectedRevision: 2,
          command: { type: 'reorder_phases', orderedPhaseIds: ['phase-1'] },
        }),
      }),
      { params: Promise.resolve({ id: 'project-1' }) },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'Project hierarchy changed',
      code: 'HIERARCHY_REVISION_CONFLICT',
      current,
    });
  });
});
