import { act, renderHook, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProjectTaskActions } from '@/app/projects/[id]/useProjectTaskActions';
import type { PhaseItem, ProjectPhase, ProjectTask } from '@/app/projects/[id]/types';
import type { HubProject } from '@/components/task-list/TaskContextMenu';
import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandResult,
} from '@/lib/projects/hierarchy-types';
import { TASK_COMPLETION_FEEDBACK_MS } from '@/lib/hooks/useTaskCompletion';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    error: toastMocks.error,
    success: toastMocks.success,
  },
}));

vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-08-15',
  getLocalTomorrow: () => '2026-08-16',
}));

const phases: ProjectPhase[] = [
  {
    id: 'phase-plan',
    projectId: 'project-1',
    name: 'Plan',
    description: null,
    status: 'pending',
    color: null,
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder: 0,
    completedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'phase-build',
    projectId: 'project-1',
    name: 'Build',
    description: null,
    status: 'pending',
    color: null,
    estimatedDays: null,
    targetStart: null,
    targetEnd: null,
    startAfterPhaseId: null,
    sortOrder: 1,
    completedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

const phaseItemsByPhase: Record<string, PhaseItem[]> = {
  'phase-plan': [{
    id: 'item-task-1',
    phaseId: 'phase-plan',
    taskId: 'task-1',
    sortOrder: 0,
    estimatedEffortHours: null,
    isProposed: false,
    proposalType: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  }],
  'phase-build': [{
    id: 'item-existing',
    phaseId: 'phase-build',
    taskId: 'existing-task',
    sortOrder: 0,
    estimatedEffortHours: null,
    isProposed: false,
    proposalType: null,
    createdAt: '2026-08-01T00:00:00.000Z',
  }],
};

const projects: HubProject[] = [
  {
    id: 'project-1',
    name: 'Current project',
    color: 'var(--accent)',
    phases: phases.map(({ id, name }) => ({ id, name })),
  },
  {
    id: 'project-2',
    name: 'Other project',
    color: 'var(--accent)',
    phases: [{ id: 'phase-other', name: 'Delivery' }],
  },
];

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    updatedAt: '2026-08-14T12:00:00.000Z',
    connectorType: 'local',
    connectorInstanceId: 'local',
    hubProjectIds: ['project-1'],
    projectPhaseMemberships: [{
      projectId: 'project-1',
      projectName: 'Current project',
      phaseId: 'phase-plan',
      phaseName: 'Plan',
    }],
    localDisposition: 'active',
    taskSourceModel: 'mc-owned',
    editPolicy: editableTaskPolicy,
    ...overrides,
  };
}

function jsonResponse(payload: unknown = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type HookSetup = {
  initialTasks?: ProjectTask[];
  phaseItems?: Record<string, PhaseItem[]>;
};

function renderActions({
  initialTasks = [makeTask()],
  phaseItems = phaseItemsByPhase,
}: HookSetup = {}) {
  const rollbackProjectRemoval = vi.fn();
  const removeTaskFromView = vi.fn();
  const stageProjectTaskRemoval = vi.fn(() => rollbackProjectRemoval);
  const refreshProjectHierarchy = vi.fn(async () => {});
  const runHierarchyCommand = vi.fn(async (
    command: ProjectHierarchyCommand,
  ): Promise<ProjectHierarchyCommandResult> => ({
    commandId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    revision: 2,
    hierarchy: {
      projectId: 'project-1',
      revision: 2,
      phases,
      phaseItemsByPhase: phaseItems,
    },
    inverseCommand: command,
  }));

  const hook = renderHook(() => {
    const [tasks, setTasks] = useState(initialTasks);
    const actions = useProjectTaskActions({
      projectId: 'project-1',
      tasks,
      setTasks,
      phases,
      phaseItemsByPhase: phaseItems,
      projects,
      removeTaskFromView,
      stageProjectTaskRemoval,
      refreshProjectHierarchy,
      runHierarchyCommand,
    });
    return { ...actions, tasks };
  });

  return {
    ...hook,
    refreshProjectHierarchy,
    removeTaskFromView,
    rollbackProjectRemoval,
    runHierarchyCommand,
    stageProjectTaskRemoval,
  };
}

async function waitForMyDayLoad() {
  await waitFor(() => {
    expect(fetch).toHaveBeenCalledWith('/api/my-day');
  });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === '/api/my-day' && !init?.method) {
      return jsonResponse({ items: [] });
    }
    return jsonResponse();
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useProjectTaskActions field updates', () => {
  it.each([
    ['priority', 'high', 'Priority is source-controlled', 'handleSetTaskPriority'],
    ['status', 'in_progress', 'Status is source-controlled', 'handleSetTaskStatus'],
    ['dueDate', '2026-09-01', 'Due date is source-controlled', 'handleSetTaskDueDate'],
  ] as const)('rejects blocked %s updates before requesting', async (
    field,
    value,
    reason,
    handlerName,
  ) => {
    const editPolicy = makeTaskEditPolicy({
      mutations: { [field]: 'blocked' },
      reasons: { [field]: reason },
    });
    const { result } = renderActions({
      initialTasks: [makeTask({ editPolicy })],
    });
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      await result.current[handlerName]('task-1', value);
    });

    expect(fetch).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith(reason);
  });

  it('sends exact field payloads and updates successful local projections', async () => {
    const { result } = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      await result.current.handleSetTaskPriority('task-1', 'high');
      await result.current.handleSetTaskStatus('task-1', 'in_progress');
      await result.current.handleSetTaskDueDate('task-1', '');
    });

    expect(fetch).toHaveBeenNthCalledWith(1, '/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ priority: 'high' }),
    });
    expect(fetch).toHaveBeenNthCalledWith(2, '/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    expect(fetch).toHaveBeenNthCalledWith(3, '/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dueDate: null }),
    });
    expect(result.current.tasks[0]).toMatchObject({
      priority: 'high',
      status: 'in_progress',
      dueDate: null,
    });
  });

  it('keeps local field state and reports the action-specific error on failure', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/my-day' && !init?.method) return jsonResponse({ items: [] });
      return jsonResponse({}, 500);
    });
    const { result } = renderActions();
    await waitForMyDayLoad();

    await act(async () => {
      await result.current.handleSetTaskPriority('task-1', 'high');
    });

    expect(result.current.tasks[0].priority).toBe('medium');
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to set priority');
  });
});

describe('useProjectTaskActions completion', () => {
  it('shares in-flight state, deduplicates requests, and commits the optimistic update', async () => {
    const { result } = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();
    vi.useFakeTimers();

    let first!: Promise<void>;
    let duplicate!: Promise<void>;
    act(() => {
      first = result.current.handleCompleteTask('task-1');
      duplicate = result.current.handleCompleteTask('task-1');
    });

    expect(result.current.completingIds.has('task-1')).toBe(true);
    expect(result.current.tasks[0].status).toBe('todo');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_COMPLETION_FEEDBACK_MS);
      await Promise.all([first, duplicate]);
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(result.current.tasks[0].status).toBe('done');
    expect(result.current.completingIds.has('task-1')).toBe(false);
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
    expect(toastMocks.success).toHaveBeenCalledWith('Task completed');
  });

  it('rolls back the optimistic completion when persistence fails', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/my-day' && !init?.method) return jsonResponse({ items: [] });
      return jsonResponse({}, 500);
    });
    const { result } = renderActions();
    await waitForMyDayLoad();
    vi.useFakeTimers();

    let completion!: Promise<void>;
    act(() => {
      completion = result.current.handleCompleteTask('task-1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_COMPLETION_FEEDBACK_MS);
      await completion;
    });

    expect(result.current.tasks[0].status).toBe('todo');
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to complete task');
  });
});

describe('useProjectTaskActions local disposition and deletion', () => {
  it('requires disposition persistence and removes handled tasks from the view', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/my-day' && !init?.method) return jsonResponse({ items: [] });
      return jsonResponse({ fields: { localDisposition: { persisted: true } } });
    });
    const mirrorPolicy = makeTaskEditPolicy({ sourceModel: 'remote-mirror' });
    const { result } = renderActions({
      initialTasks: [makeTask({
        editPolicy: mirrorPolicy,
        taskSourceModel: 'remote-mirror',
      })],
    });
    await waitForMyDayLoad();

    await act(async () => {
      await result.current.handleSetTaskLocalDisposition('task-1', 'handled');
    });

    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ localDisposition: 'handled' }),
    });
    expect(result.current.tasks).toEqual([]);
    expect(toastMocks.success).toHaveBeenCalledWith('Marked handled in Mission Control');
  });

  it('surfaces disposition policy and persistence rejection without changing state', async () => {
    const blocked = renderActions({
      initialTasks: [makeTask({
        editPolicy: makeTaskEditPolicy({
          mutations: { localDisposition: 'blocked' },
          reasons: { localDisposition: 'Disposition is unavailable' },
        }),
      })],
    });
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      await blocked.result.current.handleSetTaskLocalDisposition('task-1', 'handled');
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('Disposition is unavailable');

    toastMocks.error.mockClear();
    vi.mocked(fetch).mockImplementation(async () => jsonResponse({
      error: 'Mission Control rejected the update',
      fields: { localDisposition: { persisted: false } },
    }));
    const allowed = renderActions({
      initialTasks: [makeTask({
        editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }),
        taskSourceModel: 'remote-mirror',
      })],
    });
    await act(async () => {
      await allowed.result.current.handleSetTaskLocalDisposition('task-1', 'handled');
    });
    expect(allowed.result.current.tasks).toHaveLength(1);
    expect(toastMocks.error).toHaveBeenCalledWith('Mission Control rejected the update');
  });

  it('rejects blocked deletion and cleans the page view only after success', async () => {
    const blocked = renderActions({
      initialTasks: [makeTask({
        editPolicy: makeTaskEditPolicy({
          removalMode: 'blocked',
          removalReason: 'Deletion is unavailable',
        }),
      })],
    });
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();
    await act(async () => {
      await blocked.result.current.handleDeleteTask('task-1');
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(blocked.removeTaskFromView).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('Deletion is unavailable');

    const allowed = renderActions();
    await act(async () => {
      await allowed.result.current.handleDeleteTask('task-1');
    });
    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', { method: 'DELETE' });
    expect(allowed.removeTaskFromView).toHaveBeenCalledWith('task-1');
    expect(allowed.refreshProjectHierarchy).toHaveBeenCalledOnce();
    expect(toastMocks.success).toHaveBeenCalledWith('Task deleted');
  });

  it('does not mutate the view or refresh hierarchy after failed deletion', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === '/api/my-day' && !init?.method) return jsonResponse({ items: [] });
      return jsonResponse({}, 500);
    });
    const setup = renderActions();
    await waitForMyDayLoad();

    await act(async () => {
      await setup.result.current.handleDeleteTask('task-1');
    });

    expect(setup.removeTaskFromView).not.toHaveBeenCalled();
    expect(setup.refreshProjectHierarchy).not.toHaveBeenCalled();
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to delete task');
  });
});

describe('useProjectTaskActions My Day', () => {
  it('loads membership and applies successful add and remove requests', async () => {
    vi.mocked(fetch).mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/my-day') {
        return jsonResponse({ items: [{ taskId: 'existing-my-day' }] });
      }
      return jsonResponse();
    });
    const { result } = renderActions();
    await waitFor(() => {
      expect(result.current.myDayTaskIds.has('existing-my-day')).toBe(true);
    });

    await act(async () => {
      await result.current.handleAddToMyDay('task-1');
    });
    expect(fetch).toHaveBeenCalledWith('/api/my-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1' }),
    });
    expect(result.current.myDayTaskIds.has('task-1')).toBe(true);

    await act(async () => {
      await result.current.handleRemoveFromMyDay('task-1');
    });
    expect(fetch).toHaveBeenCalledWith('/api/my-day?taskId=task-1', { method: 'DELETE' });
    expect(result.current.myDayTaskIds.has('task-1')).toBe(false);
  });

  it('treats initial load failure as non-critical and reports mutation failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const { result } = renderActions();
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith('/api/my-day');
    });
    expect(toastMocks.error).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleAddToMyDay('task-1');
    });
    expect(result.current.myDayTaskIds).toEqual(new Set());
    expect(toastMocks.error).toHaveBeenCalledWith('Failed to add to My Day');
  });
});

describe('useProjectTaskActions project membership', () => {
  it('restores staged removal when Undo runs before the deferred request', async () => {
    const setup = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();
    vi.useFakeTimers();

    act(() => {
      setup.result.current.handleRemoveFromProject('task-1');
    });

    expect(setup.stageProjectTaskRemoval).toHaveBeenCalledWith('task-1');
    const removalToast = toastMocks.success.mock.calls.find(([message]) => (
      message === 'Removed from project'
    ));
    expect(removalToast?.[1]).toMatchObject({
      action: { label: 'Undo' },
      duration: 5000,
    });
    act(() => {
      removalToast?.[1]?.action.onClick();
    });
    expect(setup.rollbackProjectRemoval).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('executes deferred removal and refreshes hierarchy on success', async () => {
    const setup = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();
    vi.useFakeTimers();

    act(() => {
      setup.result.current.handleRemoveFromProject('task-1');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });

    expect(fetch).toHaveBeenCalledWith('/api/hub-projects/project-1/tasks', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1' }),
    });
    expect(setup.refreshProjectHierarchy).toHaveBeenCalledOnce();
    expect(setup.rollbackProjectRemoval).not.toHaveBeenCalled();
  });

  it.each(['http', 'transport'] as const)(
    'restores staged removal after %s failure',
    async (failureMode) => {
      const setup = renderActions();
      await waitForMyDayLoad();
      vi.mocked(fetch).mockImplementation(async () => {
        if (failureMode === 'transport') throw new Error('offline');
        return jsonResponse({}, 500);
      });
      vi.useFakeTimers();

      act(() => {
        setup.result.current.handleRemoveFromProject('task-1');
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5500);
      });

      expect(setup.rollbackProjectRemoval).toHaveBeenCalledOnce();
      expect(setup.refreshProjectHierarchy).not.toHaveBeenCalled();
      expect(toastMocks.error).toHaveBeenCalledWith('Failed to remove task from project');
    },
  );

  it('adds a task to another project and updates only that membership projection', async () => {
    const { result } = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();

    await act(async () => {
      await result.current.handleAddToProject('task-1', 'project-2', 'phase-other');
    });

    expect(fetch).toHaveBeenCalledWith('/api/hub-projects/project-2/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', phaseId: 'phase-other' }),
    });
    expect(result.current.tasks[0]).toMatchObject({
      hubProjectIds: ['project-1', 'project-2'],
      projectPhaseMemberships: [
        expect.objectContaining({ projectId: 'project-1', phaseId: 'phase-plan' }),
        {
          projectId: 'project-2',
          projectName: 'Other project',
          phaseId: 'phase-other',
          phaseName: 'Delivery',
        },
      ],
    });
    expect(toastMocks.success).toHaveBeenCalledWith('Moved to Other project → Delivery');
  });
});

describe('useProjectTaskActions canonical phase movement', () => {
  it('uses move_tasks with the target append index and skips an unchanged phase', async () => {
    const setup = renderActions();
    await waitForMyDayLoad();

    await act(async () => {
      await setup.result.current.handleMoveTaskToPhase('task-1', 'phase-plan');
    });
    expect(setup.runHierarchyCommand).not.toHaveBeenCalled();

    await act(async () => {
      await setup.result.current.handleMoveTaskToPhase('task-1', 'phase-build');
    });
    expect(setup.runHierarchyCommand).toHaveBeenCalledWith({
      type: 'move_tasks',
      taskIds: ['task-1'],
      toPhaseId: 'phase-build',
      toIndex: 1,
    }, {
      undoLabel: 'Moved Test task to Build',
      announcement: 'Moved Test task to Build',
    });
  });

  it('delegates same-project assignment to canonical movement and surfaces rejection', async () => {
    const setup = renderActions();
    await waitForMyDayLoad();
    setup.runHierarchyCommand.mockRejectedValueOnce(new Error('Hierarchy policy rejected the move'));

    await act(async () => {
      await setup.result.current.handleAddToProject('task-1', 'project-1', 'phase-build');
    });

    expect(setup.runHierarchyCommand).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining('/api/project-phases/'),
      expect.anything(),
    );
    expect(toastMocks.error).toHaveBeenCalledWith('Hierarchy policy rejected the move');
  });

  it('returns the complete task context action surface with deterministic due dates', async () => {
    const { result } = renderActions();
    await waitForMyDayLoad();
    vi.mocked(fetch).mockClear();

    const actions = result.current.getTaskContextActions(result.current.tasks[0]);
    expect(Object.keys(actions).sort()).toEqual([
      'onAddToMyDay',
      'onAddToProject',
      'onClearDueDate',
      'onComplete',
      'onDelete',
      'onDueToday',
      'onDueTomorrow',
      'onMoveToPhase',
      'onPickDate',
      'onRemoveFromMyDay',
      'onRemoveFromProject',
      'onSetLocalDisposition',
      'onSetPriority',
      'onSetStatus',
    ]);

    await act(async () => {
      actions.onDueToday();
    });
    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      body: JSON.stringify({ dueDate: '2026-08-15' }),
    }));
  });
});
