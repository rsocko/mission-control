import { beforeEach, describe, expect, it, vi } from 'vitest';

const select = vi.fn();
const removeTaskDependencyFromSource = vi.fn();

vi.mock('@/db', () => ({
  default: { select },
  runTransaction: vi.fn(),
}));

vi.mock('@/db/schema', () => ({
  hubProjects: {},
  projectPhaseItems: {},
  projectPhases: {},
  taskDependencies: {
    id: 'task_dependencies.id',
    taskId: 'task_dependencies.task_id',
    dependsOnTaskId: 'task_dependencies.depends_on_task_id',
  },
  taskProjects: {
    projectId: 'task_projects.project_id',
    taskId: 'task_projects.task_id',
  },
  tasks: {
    id: 'tasks.id',
    sourceId: 'tasks.source_id',
    connectorInstanceId: 'tasks.connector_instance_id',
    isChecklistItem: 'tasks.is_checklist_item',
  },
}));

vi.mock('@/lib/sync/task-dependency-manager', () => ({
  removeTaskDependencyFromSource,
  synchronizeCreatedTaskDependency: vi.fn(),
}));

function mockSelectResult(result: unknown) {
  select.mockReturnValueOnce({
    from: vi.fn(() => ({
      where: vi.fn().mockResolvedValue(result),
    })),
  });
}

describe('deleteTaskDependency', () => {
  beforeEach(() => {
    select.mockReset();
    removeTaskDependencyFromSource.mockReset();
  });

  it('removes a dependency when both tasks belong to the project', async () => {
    const dependency = {
      id: 'dependency-1',
      taskId: 'task-2',
      dependsOnTaskId: 'task-1',
      type: 'blocks',
    };
    mockSelectResult([dependency]);
    mockSelectResult([{ taskId: 'task-1' }, { taskId: 'task-2' }]);
    mockSelectResult([
      { id: 'task-1', sourceId: '1', connectorInstanceId: null, isChecklistItem: false },
      { id: 'task-2', sourceId: '2', connectorInstanceId: null, isChecklistItem: false },
    ]);
    removeTaskDependencyFromSource.mockResolvedValue({ deleted: true });
    const { deleteTaskDependency } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'dependency-1',
    })).resolves.toEqual({ deleted: true });
    expect(removeTaskDependencyFromSource).toHaveBeenCalledWith(
      dependency,
      expect.objectContaining({ id: 'task-1' }),
      expect.objectContaining({ id: 'task-2' }),
    );
  });

  it('rejects an unknown dependency', async () => {
    mockSelectResult([]);
    const { deleteTaskDependency, GraphServiceError } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'missing',
    })).rejects.toEqual(new GraphServiceError('Dependency not found', 404));
    expect(removeTaskDependencyFromSource).not.toHaveBeenCalled();
  });

  it('rejects a dependency whose tasks do not both belong to the project', async () => {
    mockSelectResult([{
      id: 'dependency-1',
      taskId: 'task-2',
      dependsOnTaskId: 'task-1',
      type: 'blocks',
    }]);
    mockSelectResult([{ taskId: 'task-1' }]);
    const { deleteTaskDependency, GraphServiceError } = await import('@/lib/graph/service');

    await expect(deleteTaskDependency({
      projectId: 'project-1',
      dependencyId: 'dependency-1',
    })).rejects.toEqual(new GraphServiceError('Dependency not found in this project', 404));
    expect(removeTaskDependencyFromSource).not.toHaveBeenCalled();
  });
});
