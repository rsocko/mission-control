import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import {
  useDashboardTaskActions,
  type DashboardTaskConfirmDialog,
  type DashboardTaskExit,
} from '@/lib/hooks/useDashboardTaskActions';
import type {
  DashboardTaskResponseViewModel as TaskResponse,
  DashboardTaskViewModel as Task,
} from '@/types/dashboard';
import { NAVIGATION_COUNTS_REFRESH_EVENT } from '@/lib/navigation/badges';
import { TASK_CHANGED_EVENT } from '@/lib/task-change-events';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock('sonner', () => ({ toast }));

const task = {
  id: 'task-1',
  title: 'Test task',
  status: 'todo',
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  microStatus: null,
  priority: 'none',
  dueDate: null,
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListName: 'Local',
  assignee: null,
  tags: [],
  metadata: null,
  sourceId: null,
  hasDescription: false,
  editPolicy: {
    fields: {
      priority: { mutation: 'local' },
      status: { mutation: 'local' },
    },
    removalMode: 'local-delete',
  } as Task['editPolicy'],
} satisfies Task;

const initialResponse: TaskResponse = {
  tasks: [task],
  total: 1,
  hasMore: false,
  sourceCounts: { local: 1 },
  availableTags: [],
  stats: {
    totalOpen: 1,
    overdue: 0,
    dueThisWeek: 0,
    highPriority: 0,
    assignedToMe: 1,
    myDay: 0,
    recentlyCreated: 0,
    recentlyClosed: 0,
    waiting: 0,
    inbox: 0,
  },
};

function useHarness(
  quickFilter: string | null = null,
  runTaskCompletion = vi.fn(),
  updateTaskGroupCounts = vi.fn(),
) {
  const [taskResponse, setTaskResponse] = useState(initialResponse);
  const [, setMyDayTaskIds] = useState(new Set<string>());
  const [myDayItemStatuses, setMyDayItemStatuses] = useState(new Map<string, string>());
  const [, setExitingTasks] = useState<DashboardTaskExit[]>([]);
  const [, setConfirmDialog] = useState<DashboardTaskConfirmDialog>({
    open: false,
    title: '',
    message: '',
    confirmLabel: '',
    variant: 'danger',
    onConfirm: () => {},
  });
  const listRef = useRef<HTMLDivElement>(null);
  const actions = useDashboardTaskActions({
    taskResponse,
    setTaskResponse,
    sourceLists: [],
    projects: [],
    quickFilter,
    textFilter: '',
    myDayItemStatuses,
    setMyDayItemStatuses,
    setMyDayTaskIds,
    setExitingTasks,
    setConfirmDialog,
    listRef,
    completionScopeKey: 'all-tasks',
    runTaskCompletion,
    fetchData: vi.fn(),
    updateTaskGroupCounts,
  });

  return { actions, taskResponse };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toast.error.mockReset();
  toast.success.mockReset();
  toast.warning.mockReset();
});

describe('useDashboardTaskActions', () => {
  it('keeps the action object and its functions stable across state and option changes', () => {
    const { result, rerender } = renderHook(
      ({ quickFilter }) => useHarness(quickFilter),
      { initialProps: { quickFilter: null as string | null } },
    );
    const originalActions = result.current.actions;
    const originalFunctions = Object.values(originalActions);

    act(() => {
      originalActions.patchTaskInList('task-1', { title: 'Updated title' });
    });
    rerender({ quickFilter: 'overdue' });

    expect(result.current.actions).toBe(originalActions);
    expect(Object.values(result.current.actions)).toEqual(originalFunctions);
    expect(result.current.taskResponse.tasks[0].title).toBe('Updated title');
  });

  it('rolls an optimistic priority mutation back when persistence fails', async () => {
    let resolveFetch!: (response: { ok: boolean }) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((resolve) => {
      resolveFetch = resolve;
    })));
    const { result } = renderHook(() => useHarness());

    let mutation!: Promise<void>;
    act(() => {
      mutation = result.current.actions.setTaskPriority('task-1', 'high');
    });
    expect(result.current.taskResponse.tasks[0].priority).toBe('high');

    await act(async () => {
      resolveFetch({ ok: false });
      await mutation;
    });

    expect(result.current.taskResponse.tasks[0].priority).toBe('none');
    expect(toast.error).toHaveBeenCalledWith('Failed to update priority');
  });

  it('reports successful list mutations so an open detail panel can refresh', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const taskChanged = vi.fn();
    window.addEventListener(TASK_CHANGED_EVENT, taskChanged);
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.actions.setTaskStatus('task-1', 'in_progress');
    });

    expect(taskChanged).toHaveBeenCalledOnce();
    expect((taskChanged.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: 'task-1' });
    window.removeEventListener(TASK_CHANGED_EVENT, taskChanged);
  });

  it('refreshes navigation counts when My Day membership changes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({}),
    }));
    const refreshListener = vi.fn();
    window.addEventListener(NAVIGATION_COUNTS_REFRESH_EVENT, refreshListener);
    const { result } = renderHook(() => useHarness());

    await act(async () => {
      await result.current.actions.addToMyDay('task-1');
    });

    expect(refreshListener).toHaveBeenCalledTimes(1);
    window.removeEventListener(NAVIGATION_COUNTS_REFRESH_EVENT, refreshListener);
  });

  it('updates grouped totals with the optimistic completion', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    const updateTaskGroupCounts = vi.fn();
    const runTaskCompletion = vi.fn(async (
      _taskId: string,
      options: {
        optimisticUpdate: () => void;
        request: () => Promise<void>;
      },
    ) => {
      options.optimisticUpdate();
      await options.request();
      return 'completed' as const;
    });
    const { result } = renderHook(() => useHarness(
      null,
      runTaskCompletion,
      updateTaskGroupCounts,
    ));

    await act(async () => {
      await result.current.actions.completeTask('task-1');
    });

    expect(updateTaskGroupCounts).toHaveBeenCalledWith(task, null);
  });
});
