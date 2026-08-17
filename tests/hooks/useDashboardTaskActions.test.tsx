import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import {
  useDashboardTaskActions,
  type DashboardTaskConfirmDialog,
  type DashboardTaskExit,
} from '@/lib/hooks/useDashboardTaskActions';
import type { Task, TaskResponse } from '@/types/dashboard';

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

function useHarness(quickFilter: string | null = null) {
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
    runTaskCompletion: vi.fn(),
    fetchData: vi.fn(),
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
});
