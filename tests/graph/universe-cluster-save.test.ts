import { describe, expect, it, vi } from 'vitest';
import {
  saveUniverseCluster,
  UniverseClusterSaveError,
  type UniverseClusterSaveAdapters,
} from '@/lib/graph/universe-cluster-save';

const input = {
  destination: 'tag' as const,
  name: 'Release work',
  taskIds: ['task-2', 'task-1'],
  clusterId: 'cluster-abc',
  projectionFingerprint: 'projection-abc',
};

function adapters(
  overrides: Partial<UniverseClusterSaveAdapters> = {},
): UniverseClusterSaveAdapters {
  return {
    authorizeTaskIds: vi.fn(async (taskIds) => taskIds),
    createProject: vi.fn(async () => 'proj-release'),
    assignProjectTasks: vi.fn(async () => undefined),
    rollbackProject: vi.fn(async () => undefined),
    createTag: vi.fn(async () => 'tag-release'),
    addTagToTask: vi.fn(async () => undefined),
    recordTagAudit: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('saveUniverseCluster', () => {
  it('rejects non-sluggable destination names before authorization or mutation', async () => {
    const domain = adapters();

    await expect(saveUniverseCluster({ ...input, name: '!!!' }, domain)).rejects.toMatchObject({
      code: 'INVALID_DESTINATION_NAME',
      status: 400,
    });
    expect(domain.authorizeTaskIds).not.toHaveBeenCalled();
    expect(domain.createTag).not.toHaveBeenCalled();
  });

  it('authorizes every member before any domain mutation', async () => {
    const domain = adapters({
      authorizeTaskIds: vi.fn(async () => ['task-1']),
    });

    await expect(saveUniverseCluster(input, domain)).rejects.toMatchObject<
      Partial<UniverseClusterSaveError>
    >({
      code: 'CLUSTER_MEMBERSHIP_CONFLICT',
      status: 409,
    });
    expect(domain.createTag).not.toHaveBeenCalled();
    expect(domain.addTagToTask).not.toHaveBeenCalled();
    expect(domain.recordTagAudit).not.toHaveBeenCalled();
  });

  it('sorts membership and uses the audited project hierarchy command boundary', async () => {
    const domain = adapters();
    const result = await saveUniverseCluster(
      { ...input, destination: 'project' },
      domain,
    );

    expect(domain.assignProjectTasks).toHaveBeenCalledWith(
      'proj-release',
      ['task-1', 'task-2'],
    );
    expect(result).toMatchObject({
      status: 'saved',
      destinationId: 'proj-release',
      savedTaskIds: ['task-1', 'task-2'],
    });
  });

  it('reports project conflicts and tag partial failures without claiming full success', async () => {
    const projectDomain = adapters({
      assignProjectTasks: vi.fn(async () => {
        throw new Error('Revision conflict');
      }),
    });
    await expect(saveUniverseCluster(
      { ...input, destination: 'project' },
      projectDomain,
    )).rejects.toMatchObject({
      code: 'PROJECT_ASSIGNMENT_FAILED',
      message: 'Revision conflict',
    });
    expect(projectDomain.rollbackProject).toHaveBeenCalledWith('proj-release');

    const tagDomain = adapters({
      addTagToTask: vi.fn(async (taskId) => {
        if (taskId === 'task-2') throw new Error('Source rejected tag');
      }),
    });
    const tagResult = await saveUniverseCluster(input, tagDomain);
    expect(tagResult).toMatchObject({
      status: 'partial',
      savedTaskIds: ['task-1'],
      failures: [{
        taskId: 'task-2',
        code: 'TAG_ASSIGNMENT_FAILED',
        message: 'Source rejected tag',
      }],
    });
    expect(tagDomain.recordTagAudit).toHaveBeenCalledWith(
      input,
      'tag-release',
      ['task-1'],
    );
  });

  it('surfaces revision conflicts and audit failures explicitly', async () => {
    const conflict = new UniverseClusterSaveError(
      'Project hierarchy changed',
      'REVISION_CONFLICT',
      409,
    );
    await expect(saveUniverseCluster(
      { ...input, destination: 'project' },
      adapters({ assignProjectTasks: vi.fn(async () => { throw conflict; }) }),
    )).rejects.toBe(conflict);

    const result = await saveUniverseCluster(input, adapters({
      recordTagAudit: vi.fn(async () => { throw new Error('Audit unavailable'); }),
    }));
    expect(result).toMatchObject({
      status: 'partial',
      savedTaskIds: ['task-1', 'task-2'],
      failures: [{ code: 'AUDIT_RECORD_FAILED', message: 'Audit unavailable' }],
    });
  });

  it('reports partial state only when an incomplete project cannot be rolled back', async () => {
    const result = await saveUniverseCluster(
      { ...input, destination: 'project' },
      adapters({
        assignProjectTasks: vi.fn(async () => { throw new Error('Assignment failed'); }),
        rollbackProject: vi.fn(async () => { throw new Error('Delete failed'); }),
      }),
    );
    expect(result).toMatchObject({
      status: 'partial',
      destinationId: 'proj-release',
      failures: [{
        code: 'PROJECT_ROLLBACK_FAILED',
        message: expect.stringContaining('Delete failed'),
      }],
    });
  });
});
