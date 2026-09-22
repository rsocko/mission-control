import { beforeEach, describe, expect, it, vi } from 'vitest';

const getDependencyDeleteContext = vi.fn();
const removeTaskDependencyFromSource = vi.fn();

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    graphReporting: {
      projects: { getDependencyDeleteContext },
    },
  }),
}));

vi.mock('@/lib/sync/task-dependency-manager', () => ({
  removeTaskDependencyFromSource,
  synchronizeCreatedTaskDependency: vi.fn(),
}));

describe('deleteTaskDependency', () => {
  beforeEach(() => {
    getDependencyDeleteContext.mockReset();
    removeTaskDependencyFromSource.mockReset();
  });

  it('removes a dependency when both tasks belong to the project', async () => {
    const dependency = {
      id: 'dependency-1',
      taskId: 'task-2',
      dependsOnTaskId: 'task-1',
      type: 'blocks',
    };
    const blocker = {
      id: 'task-1', sourceId: '1', connectorInstanceId: null, isChecklistItem: false,
    };
    const blocked = {
      id: 'task-2', sourceId: '2', connectorInstanceId: null, isChecklistItem: false,
    };
    getDependencyDeleteContext.mockResolvedValue({
      kind: 'found',
      dependency,
      blocker,
      blocked,
    });
    removeTaskDependencyFromSource.mockResolvedValue({ deleted: true });
    const { deleteTaskDependency } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'dependency-1',
    })).resolves.toEqual({ deleted: true });
    expect(removeTaskDependencyFromSource).toHaveBeenCalledWith(
      dependency,
      blocker,
      blocked,
    );
  });

  it('rejects an unknown dependency', async () => {
    getDependencyDeleteContext.mockResolvedValue({ kind: 'missing' });
    const { deleteTaskDependency, GraphServiceError } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'missing',
    })).rejects.toEqual(new GraphServiceError('Dependency not found', 404));
    expect(removeTaskDependencyFromSource).not.toHaveBeenCalled();
  });

  it('rejects a dependency whose tasks do not both belong to the project', async () => {
    getDependencyDeleteContext.mockResolvedValue({
      kind: 'missing-project-membership',
    });
    const { deleteTaskDependency, GraphServiceError } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'dependency-1',
    })).rejects.toEqual(new GraphServiceError('Dependency not found in this project', 404));
    expect(removeTaskDependencyFromSource).not.toHaveBeenCalled();
  });
});
