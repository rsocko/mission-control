import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import { TooltipProvider } from '@/components/ui/Tooltip';
import ProjectDetailPage from '@/app/projects/[id]/page';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const mocks = vi.hoisted(() => ({
  executeHierarchyCommand: vi.fn(),
  loadHierarchy: vi.fn(),
  toastDismiss: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'project-1' }),
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('sonner', () => ({
  toast: {
    dismiss: mocks.toastDismiss,
    error: mocks.toastError,
    success: mocks.toastSuccess,
    warning: vi.fn(),
  },
}));

vi.mock('@/lib/projects/hierarchy-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/projects/hierarchy-client')>();
  return {
    ...actual,
    executeProjectHierarchyCommand: mocks.executeHierarchyCommand,
    loadProjectHierarchy: mocks.loadHierarchy,
  };
});

vi.mock('@/lib/hooks/useSyncStream', () => ({
  useSyncStream: () => ({ progress: { refetchKey: 0 } }),
}));

vi.mock('@/lib/hooks/useQuickAddContext', () => ({
  useQuickAddContext: () => ({
    setQuickAddFilter: vi.fn(),
    clearQuickAddFilter: vi.fn(),
  }),
}));

vi.mock('@/lib/stores/undoStore', () => ({
  pushUndoWithToast: vi.fn(() => 'undo-entry-1'),
  useUndoStore: {
    getState: () => ({ removeEntry: vi.fn() }),
  },
}));

vi.mock('@/components/graph/ProjectStructureGraph', () => ({
  default: () => <div data-testid="project-structure-graph" />,
}));

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({ taskId }: { taskId: string }) => (
    <aside data-testid={`task-detail-${taskId}`}>Task detail</aside>
  ),
}));

vi.mock('@/components/task-list/TaskContextMenu', () => ({
  TaskContextMenu: ({
    actions,
    children,
    task,
  }: {
    actions: {
      onDelete: () => void;
      onMoveToPhase?: (phaseId: string | null) => void;
      onRemoveFromProject?: () => void;
    };
    children: React.ReactNode;
    task: { id: string };
  }) => (
    <section data-testid={`task-actions-${task.id}`}>
      {children}
      <button type="button" onClick={actions.onDelete}>Delete {task.id}</button>
      <button type="button" onClick={() => actions.onMoveToPhase?.('phase-build')}>
        Move {task.id}
      </button>
      <button type="button" onClick={actions.onRemoveFromProject}>
        Remove {task.id}
      </button>
    </section>
  ),
}));

vi.mock('motion/react', () => {
  type MotionProps<T extends HTMLElement> = React.HTMLAttributes<T> & {
    animate?: unknown;
    exit?: unknown;
    initial?: unknown;
    layout?: unknown;
    transition?: unknown;
    variants?: unknown;
  };
  const withoutMotionProps = <T extends HTMLElement,>({
    animate,
    exit,
    initial,
    layout,
    transition,
    variants,
    ...props
  }: MotionProps<T>) => {
    void animate;
    void exit;
    void initial;
    void layout;
    void transition;
    void variants;
    return props;
  };
  const MotionDiv = React.forwardRef<HTMLDivElement, MotionProps<HTMLDivElement>>(
    (props, ref) => <div ref={ref} {...withoutMotionProps(props)} />,
  );
  MotionDiv.displayName = 'MotionDiv';
  const MotionSection = React.forwardRef<HTMLElement, MotionProps<HTMLElement>>(
    (props, ref) => <section ref={ref} {...withoutMotionProps(props)} />,
  );
  MotionSection.displayName = 'MotionSection';
  const MotionSpan = React.forwardRef<HTMLSpanElement, MotionProps<HTMLSpanElement>>(
    (props, ref) => <span ref={ref} {...withoutMotionProps(props)} />,
  );
  MotionSpan.displayName = 'MotionSpan';
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: MotionDiv, section: MotionSection, span: MotionSpan },
    useReducedMotion: () => false,
  };
});

const task = {
  id: 'task-1',
  title: 'Test task',
  status: 'todo' as const,
  priority: 'medium' as const,
  dueDate: null,
  updatedAt: '2026-08-14T12:00:00.000Z',
  connectorType: 'local',
  connectorInstanceId: 'local',
  hubProjectIds: ['project-1'],
  projectPhaseMemberships: [{
    projectId: 'project-1',
    projectName: 'Test Project',
    phaseId: 'phase-plan',
    phaseName: 'Plan',
  }],
  localDisposition: 'active' as const,
  taskSourceModel: 'mc-owned' as const,
  editPolicy: editableTaskPolicy,
};

const phases = [
  {
    id: 'phase-plan',
    projectId: 'project-1',
    name: 'Plan',
    description: null,
    status: 'pending' as const,
    color: '#3b82f6',
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
    status: 'pending' as const,
    color: '#3b82f6',
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

const hierarchy: ProjectHierarchySnapshot = {
  projectId: 'project-1',
  revision: 1,
  phases,
  phaseItemsByPhase: {
    'phase-plan': [{
      id: 'item-1',
      phaseId: 'phase-plan',
      taskId: task.id,
      sortOrder: 0,
      estimatedEffortHours: null,
      isProposed: false,
      proposalType: null,
      createdAt: '2026-08-01T00:00:00.000Z',
    }],
    'phase-build': [],
  },
};

class TestResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { height: 72 } as DOMRectReadOnly } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }

  disconnect() {}
  unobserve() {}
}

function jsonResponse(payload: unknown = {}, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function projectPayload() {
  return {
    project: {
      id: 'project-1',
      name: 'Test Project',
      description: null,
      color: '#3b82f6',
      icon: null,
      iconColor: null,
      sourceBindings: [],
      autoIncludeRules: [],
      kanbanColumns: [],
      defaultView: 'list',
      status: 'active',
      statusOverride: null,
      category: null,
      targetDate: null,
      startedAt: null,
      completedAt: null,
      sortOrder: 0,
      metadata: {},
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
    },
  };
}

async function renderTaskActions() {
  render(
    <TooltipProvider>
      <ProjectDetailPage />
    </TooltipProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Project Tasks (1)' }));
  return screen.findByTestId('task-actions-task-1');
}

describe('project task action orchestration', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      height: 72,
    } as DOMRect);
    mocks.loadHierarchy.mockResolvedValue(hierarchy);
    mocks.executeHierarchyCommand.mockImplementation(async ({
      commandId,
    }: {
      commandId: string;
    }) => ({
      commandId,
      revision: 2,
      hierarchy: {
        ...hierarchy,
        revision: 2,
        phaseItemsByPhase: {
          'phase-plan': [],
          'phase-build': [{
            ...hierarchy.phaseItemsByPhase['phase-plan'][0],
            phaseId: 'phase-build',
          }],
        },
      },
      inverseCommand: {
        type: 'move_tasks',
        taskIds: [task.id],
        toPhaseId: 'phase-plan',
        toIndex: 0,
      },
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/hub-projects/project-1') return jsonResponse(projectPayload());
      if (url.startsWith('/api/tasks?')) return jsonResponse({ tasks: [task] });
      if (url === '/api/hub-projects?includePhases=true') {
        return jsonResponse({
          projects: [{
            id: 'project-1',
            name: 'Test Project',
            color: '#3b82f6',
            phases: phases.map(({ id, name }) => ({ id, name })),
          }],
        });
      }
      if (url === '/api/my-day' && !init?.method) return jsonResponse({ items: [] });
      return jsonResponse();
    }));
  });

  it('keeps completion in flight before sending the exact status update', async () => {
    const actions = await renderTaskActions();
    vi.useFakeTimers();

    const completeButton = within(actions).getByRole('button', { name: 'Mark complete' });
    fireEvent.click(completeButton);

    expect(completeButton).toBeDisabled();
    expect(fetch).not.toHaveBeenCalledWith('/api/tasks/task-1', expect.anything());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    });
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Task completed');
  });

  it('cleans task, phase, and selection state after delete and refreshes hierarchy', async () => {
    const actions = await renderTaskActions();
    fireEvent.click(within(actions).getByText('Test task'));
    expect(await screen.findByTestId('task-detail-task-1')).toBeInTheDocument();
    const hierarchyLoadsBeforeDelete = mocks.loadHierarchy.mock.calls.length;

    fireEvent.click(within(actions).getByRole('button', { name: 'Delete task-1' }));

    await waitFor(() => {
      expect(screen.queryByTestId('task-actions-task-1')).not.toBeInTheDocument();
      expect(screen.queryByTestId('task-detail-task-1')).not.toBeInTheDocument();
    });
    expect(fetch).toHaveBeenCalledWith('/api/tasks/task-1', { method: 'DELETE' });
    expect(mocks.loadHierarchy).toHaveBeenCalledTimes(hierarchyLoadsBeforeDelete + 1);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Task deleted');
  });

  it('restores the complete project view when deferred removal is undone', async () => {
    const actions = await renderTaskActions();
    fireEvent.click(within(actions).getByText('Test task'));
    expect(await screen.findByTestId('task-detail-task-1')).toBeInTheDocument();
    vi.useFakeTimers();

    fireEvent.click(within(actions).getByRole('button', { name: 'Remove task-1' }));
    expect(screen.queryByTestId('task-actions-task-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('task-detail-task-1')).not.toBeInTheDocument();

    const removalToast = mocks.toastSuccess.mock.calls.find(([message]) => (
      message === 'Removed from project'
    ));
    expect(removalToast?.[1]).toMatchObject({
      action: { label: 'Undo' },
      duration: 5000,
    });

    act(() => {
      removalToast?.[1]?.action.onClick();
    });
    expect(screen.getByTestId('task-actions-task-1')).toBeInTheDocument();
    expect(screen.getByTestId('task-detail-task-1')).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5500);
    });
    expect(fetch).not.toHaveBeenCalledWith(
      '/api/hub-projects/project-1/tasks',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('routes phase movement through the canonical hierarchy command only', async () => {
    const actions = await renderTaskActions();

    fireEvent.click(within(actions).getByRole('button', { name: 'Move task-1' }));

    await waitFor(() => {
      expect(mocks.executeHierarchyCommand).toHaveBeenCalledWith({
        projectId: 'project-1',
        expectedRevision: 1,
        commandId: expect.any(String),
        command: {
          type: 'move_tasks',
          taskIds: ['task-1'],
          toPhaseId: 'phase-build',
          toIndex: 0,
        },
      });
    });
    expect(vi.mocked(fetch).mock.calls.some(([input]) => (
      String(input).startsWith('/api/project-phases/')
    ))).toBe(false);
  });
});
