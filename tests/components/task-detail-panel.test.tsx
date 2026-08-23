import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { formatTaskDetailUpdatedAt } from '@/lib/utils/task-detail-date';
import { toast } from 'sonner';
import { editableTaskPolicy, makeTaskEditPolicy } from '../fixtures/task-edit-policy';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/components/task-detail/SubtaskSection', () => ({
  SubtaskSection: ({
    subtasks,
    onSubtasksChange,
    canCreateSubtasks = true,
  }: {
    subtasks: Array<{ id: string; title: string; status: string }>;
    onSubtasksChange: (subtasks: Array<{ id: string; title: string; status: string }>) => void;
    canCreateSubtasks?: boolean;
  }) => (
    <div>
      Subtask list
      <button
        type="button"
        onClick={() => onSubtasksChange(subtasks.map((subtask, index) => (
          index === 0 ? { ...subtask, status: 'done' } : subtask
        )))}
      >
        Complete first mocked subtask
      </button>
      {canCreateSubtasks && (
        <button
          type="button"
          onClick={() => onSubtasksChange([
            ...subtasks,
            { id: `subtask-${subtasks.length + 1}`, title: 'New subtask', status: 'todo' },
          ])}
        >
          Add mocked subtask
        </button>
      )}
      <button type="button" onClick={() => onSubtasksChange(subtasks.slice(0, -1))}>
        Remove mocked subtask
      </button>
    </div>
  ),
}));

vi.mock('@/components/task-detail/TaskAttachmentSection', () => ({
  TaskAttachmentSection: () => <div>Attachment list</div>,
  useImagePasteHandler: () => ({ handlePaste: vi.fn(), pasteCount: 0 }),
}));

vi.mock('@/components/task-detail/LinkedSourcesSection', () => ({
  LinkedSourcesSection: () => null,
}));

vi.mock('@/components/task-detail/DuplicateTaskPreview', () => ({
  DuplicateTaskPreview: () => <div>Duplicate candidate</div>,
}));

vi.mock('@/lib/utils/client-date', () => ({
  getLocalToday: () => '2026-08-01',
}));

const task = {
  id: 'task-1',
  title: 'A complete task title that must remain visible in every presentation',
  description: 'Detailed notes',
  status: 'todo',
  microStatus: null,
  statusReason: null,
  priority: 'high',
  dueDate: '2026-08-01',
  connectorType: 'local',
  connectorInstanceId: 'local',
  sourceListId: 'list-1',
  sourceListName: 'Inbox',
  sourceId: 'local:task-1',
  sourceUrl: null,
  assignee: null,
  createdAt: '2026-07-01T12:00:00.000Z',
  updatedAt: '2026-07-31T12:00:00.000Z',
  tagIds: [],
  projectIds: [],
  subtasks: [],
  metadata: null,
  estimatedDuration: 30,
  recurrence: null,
  effort: 2,
  reminderAt: null,
  isInMyDay: false,
  localDisposition: 'active',
  taskSourceModel: 'mc-owned',
  editPolicy: editableTaskPolicy,
};

const projectHierarchy = {
  projectId: 'project-1',
  revision: 3,
  phases: [
    { id: 'phase-1', projectId: 'project-1', name: 'Charts & visualization' },
    { id: 'phase-2', projectId: 'project-1', name: 'Q3 reporting' },
  ],
  phaseItemsByPhase: {
    'phase-1': [{ id: 'item-1', phaseId: 'phase-1', taskId: 'task-1' }],
    'phase-2': [],
  },
};

function json(data: unknown) {
  return Promise.resolve({ ok: true, json: async () => data });
}

function renderPanel(props: React.ComponentProps<typeof TaskDetailPanel>) {
  return render(
    <TooltipProvider>
      <TaskDetailPanel {...props} />
    </TooltipProvider>,
  );
}

function expectBefore(first: Element, second: Element) {
  expect(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  localStorage.clear();
});

describe('TaskDetailPanel redesigned presentations', () => {
  it('renders dialog select menus above the task popout', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'dialog', onClose: vi.fn() });
    const dialog = await screen.findByRole('dialog', { name: `Task details: ${task.title}` });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Task status' }));

    expect(screen.getByRole('listbox')).toHaveClass('z-[100]');
    expect(dialog.parentElement).toHaveClass('z-[90]');
  });

  it('resizes the panel and persists the final dragged width', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });
    const panel = container.querySelector('aside')!;
    const resizeHandle = container.querySelector('.cursor-col-resize')!;

    fireEvent.mouseDown(resizeHandle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 400 });
    fireEvent.mouseUp(document);

    expect(panel).toHaveStyle({ width: '530px' });
    expect(localStorage.getItem('mission-control:detail-panel-width')).toBe('530');
  });

  it('starts resizing from the rendered width when its host constrains it', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });
    const panel = container.querySelector('aside')!;
    const resizeHandle = container.querySelector('.cursor-col-resize')!;
    vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
      bottom: 0,
      height: 0,
      left: 0,
      right: 350,
      top: 0,
      width: 350,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(resizeHandle, { clientX: 500 });
    fireEvent.mouseMove(document, { clientX: 450 });
    fireEvent.mouseUp(document);

    expect(panel).toHaveStyle({ width: '400px' });
    expect(localStorage.getItem('mission-control:detail-panel-width')).toBe('400');
  });

  it('ignores an invalid saved panel width', async () => {
    localStorage.setItem('mission-control:detail-panel-width', 'not-a-number');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });

    expect(container.querySelector('aside')).toHaveStyle({ width: '430px' });
  });

  it('honors a host minimum width when no valid width is saved', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    const { container } = renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      minPanelWidth: 480,
      onClose: vi.fn(),
    });
    await screen.findByRole('heading', { name: task.title });

    expect(container.querySelector('aside')).toHaveStyle({ width: '480px' });
  });

  it('shows a live subtask jump chip only in the side panel when subtasks exist', async () => {
    const taskWithSubtasks = {
      ...task,
      subtasks: [
        { id: 'subtask-1', title: 'First', status: 'todo' },
        { id: 'subtask-2', title: 'Second', status: 'done' },
      ],
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: taskWithSubtasks });
      return json({});
    }));

    const { unmount } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    expect(await screen.findByRole('button', { name: 'Jump to subtasks, 1 of 2 complete' })).toHaveTextContent('Subtasks 1/2');

    fireEvent.click(screen.getByRole('button', { name: 'Complete first mocked subtask' }));
    expect(screen.getByRole('button', { name: 'Jump to subtasks, 2 of 2 complete' })).toHaveTextContent('Subtasks 2/2');

    fireEvent.click(screen.getByRole('button', { name: 'Add mocked subtask' }));
    expect(screen.getByRole('button', { name: 'Jump to subtasks, 2 of 3 complete' })).toHaveTextContent('Subtasks 2/3');

    fireEvent.click(screen.getByRole('button', { name: 'Remove mocked subtask' }));
    expect(screen.getByRole('button', { name: 'Jump to subtasks, 2 of 2 complete' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mocked subtask' }));
    expect(screen.getByRole('button', { name: 'Jump to subtasks, 1 of 1 complete' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove mocked subtask' }));
    expect(screen.queryByRole('button', { name: /Jump to subtasks/ })).not.toBeInTheDocument();
    unmount();

    for (const mode of ['dialog', 'workspace', 'mobile'] as const) {
      const presentation = renderPanel({ taskId: 'task-1', mode, onClose: vi.fn() });
      await screen.findByRole('heading', { name: task.title });
      expect(screen.queryByRole('button', { name: /Jump to subtasks/ })).not.toBeInTheDocument();
      presentation.unmount();
    }
  });

  it('hides the subtask jump chip in the side panel when there are no subtasks', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });
    expect(screen.queryByRole('button', { name: /Jump to subtasks/ })).not.toBeInTheDocument();
  });

  it('scrolls only the panel to subtasks and focuses its heading', async () => {
    const taskWithSubtasks = {
      ...task,
      subtasks: [{ id: 'subtask-1', title: 'First', status: 'todo' }],
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: taskWithSubtasks });
      return json({});
    }));
    const windowScroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const jumpButton = await screen.findByRole('button', { name: 'Jump to subtasks, 0 of 1 complete' });
    const panel = container.querySelector('aside')!;
    const heading = screen.getByRole('heading', { name: 'Subtasks (0/1)' });
    const section = heading.closest('section')!;
    const header = heading.closest('aside')!.querySelector('header')!;
    const panelScroll = vi.fn();
    Object.defineProperty(panel, 'scrollTo', { value: panelScroll });
    Object.defineProperty(section, 'offsetTop', { value: 640 });
    Object.defineProperty(header, 'offsetHeight', { value: 120 });

    fireEvent.click(jumpButton);

    expect(panelScroll).toHaveBeenCalledWith({ top: 520, behavior: 'smooth' });
    expect(heading).toHaveFocus();
    expect(windowScroll).not.toHaveBeenCalled();
  });

  it('scrolls to subtasks when the panel is opened from a list badge', async () => {
    const taskWithSubtasks = {
      ...task,
      subtasks: [{ id: 'subtask-1', title: 'First', status: 'todo' }],
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: taskWithSubtasks });
      return json({});
    }));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));

    const { container, rerender } = renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
    });
    await screen.findByRole('heading', { name: 'Subtasks (0/1)' });
    const panel = container.querySelector('aside')!;
    const section = screen.getByRole('heading', { name: 'Subtasks (0/1)' }).closest('section')!;
    const header = panel.querySelector('header')!;
    const panelScroll = vi.fn();
    Object.defineProperty(panel, 'scrollTo', { value: panelScroll });
    Object.defineProperty(section, 'offsetTop', { value: 640 });
    Object.defineProperty(header, 'offsetHeight', { value: 120 });

    rerender(
      <TooltipProvider>
        <TaskDetailPanel
          taskId="task-1"
          mode="panel"
          onClose={vi.fn()}
          subtasksOpenRequest={{ requestId: 1, taskId: 'task-1' }}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(panelScroll).toHaveBeenCalledWith({ top: 520, behavior: 'smooth' });
    });
    expect(screen.getByRole('heading', { name: 'Subtasks (0/1)' })).toHaveFocus();
  });

  it('keeps the task title header fixed while panel content scrolls', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect((await screen.findByRole('heading', { name: task.title })).closest('header'))
      .toHaveClass('sticky', 'top-0');
  });

  it('avoids smooth panel scrolling when reduced motion is preferred', async () => {
    const taskWithSubtasks = {
      ...task,
      subtasks: [{ id: 'subtask-1', title: 'First', status: 'todo' }],
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: taskWithSubtasks });
      return json({});
    }));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const jumpButton = await screen.findByRole('button', { name: 'Jump to subtasks, 0 of 1 complete' });
    const panel = container.querySelector('aside')!;
    const panelScroll = vi.fn();
    Object.defineProperty(panel, 'scrollTo', { value: panelScroll });

    fireEvent.click(jumpButton);

    expect(panelScroll).toHaveBeenCalledWith({ top: 0, behavior: 'auto' });
  });

  it.each(['panel', 'dialog'] as const)(
    'shows recurring task recovery controls and jumps to Planning in %s mode',
    async (mode) => {
      const recurringTask = {
        ...task,
        connectorType: 'microsoft-todo',
        dueDate: '2026-07-27',
        recurrence: undefined,
        metadata: JSON.stringify({ recurrence: 'weekly' }),
      };
      const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
        if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
        return json({});
      });
      const nextDateLabel = new Date('2026-08-03T12:00:00').toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
      });
      vi.stubGlobal('fetch', fetchMock);
      vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));

      const { container } = renderPanel({ taskId: 'task-1', mode, onClose: vi.fn() });
      const recurrenceShortcut = await screen.findByRole('button', { name: 'View recurrence settings' });
      const recurrencePicker = screen.getByRole('combobox', { name: 'Task recurrence' });
      const skipButton = screen.getByRole('button', { name: `Skip to current Next: ${nextDateLabel}` });
      const planningHeading = screen.getByRole('heading', { name: 'Planning' });
      const planningSection = planningHeading.closest('section')!;
      const scrollHost = mode === 'panel'
        ? container.querySelector('aside')!
        : container.querySelector('[data-task-detail-scroll]')!;
      const scrollTo = vi.fn();
      Object.defineProperty(scrollHost, 'scrollTo', { value: scrollTo });
      Object.defineProperty(planningSection, 'offsetTop', { value: 640 });

      expect(recurrencePicker).toHaveTextContent('Weekly');
      expect(screen.getByText('Overdue')).toBeInTheDocument();

      fireEvent.click(recurrenceShortcut);

      expect(scrollTo).toHaveBeenCalledWith({ top: 624, behavior: 'smooth' });
      expect(planningHeading).toHaveFocus();
      expect(planningSection).toHaveClass('ring-blue-500/10');

      fireEvent.click(skipButton);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        '/api/tasks/task-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ dueDate: '2026-08-03' }),
        }),
      ));
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: /Skip to current/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Due date' })).toHaveTextContent('Aug 3, 2026');
        expect(screen.queryByText('Overdue')).not.toBeInTheDocument();
      });
      expect(toast.success).toHaveBeenCalledWith(`Due date moved to ${nextDateLabel}`);
    },
  );

  it('avoids smooth scrolling when jumping to recurrence with reduced motion enabled', async () => {
    const recurringTask = {
      ...task,
      connectorType: 'microsoft-todo',
      dueDate: '2026-07-27',
      recurrence: undefined,
      metadata: JSON.stringify({ recurrence: 'weekly' }),
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
      return json({});
    }));
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));

    const { container } = renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const recurrenceShortcut = await screen.findByRole('button', { name: 'View recurrence settings' });
    const planningSection = screen.getByRole('heading', { name: 'Planning' }).closest('section')!;
    const panel = container.querySelector('aside')!;
    const panelScroll = vi.fn();
    Object.defineProperty(panel, 'scrollTo', { value: panelScroll });
    Object.defineProperty(planningSection, 'offsetTop', { value: 640 });

    fireEvent.click(recurrenceShortcut);

    expect(panelScroll).toHaveBeenCalledWith({ top: 624, behavior: 'auto' });
  });

  it('saves recurrence through its typed field without mutating metadata', async () => {
    const recurringTask = {
      ...task,
      connectorType: 'microsoft-todo',
      recurrence: 'weekly',
      metadata: JSON.stringify({ mcOwned: { pinned: true } }),
    };
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Task recurrence' }));
    fireEvent.click(screen.getByRole('option', { name: 'Daily' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ recurrence: 'daily' }),
      }),
    ));
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).not.toHaveProperty('metadata');
  });

  it('keeps a cleared typed recurrence from falling back to legacy metadata', async () => {
    const recurringTask = {
      ...task,
      connectorType: 'microsoft-todo',
      dueDate: '2026-07-27',
      recurrence: 'weekly',
      metadata: JSON.stringify({ recurrence: 'weekly' }),
    };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const picker = await screen.findByRole('combobox', { name: 'Task recurrence' });
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole('option', { name: 'Does not repeat' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ recurrence: null }),
      }),
    ));
    expect(picker).toHaveTextContent('Does not repeat');
    expect(screen.queryByRole('button', { name: 'View recurrence settings' })).not.toBeInTheDocument();
  });

  it('disables skip-to-current while its due-date update is in flight', async () => {
    const recurringTask = {
      ...task,
      connectorType: 'microsoft-todo',
      dueDate: '2026-07-27',
      recurrence: undefined,
      metadata: JSON.stringify({ recurrence: 'weekly' }),
    };
    let resolvePatch!: (response: { ok: boolean; json: () => Promise<Record<string, never>> }) => void;
    const patchResponse = new Promise<{ ok: boolean; json: () => Promise<Record<string, never>> }>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') return patchResponse;
      if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const skipButton = await screen.findByRole('button', { name: /Skip to current/ });

    fireEvent.click(skipButton);
    fireEvent.click(skipButton);

    expect(skipButton).toBeDisabled();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);

    await act(async () => {
      resolvePatch({ ok: true, json: async () => ({}) });
      await patchResponse;
    });
  });

  it('keeps skip-to-current available when saving the advanced due date fails', async () => {
    const recurringTask = {
      ...task,
      connectorType: 'microsoft-todo',
      dueDate: '2026-07-27',
      recurrence: undefined,
      metadata: JSON.stringify({ recurrence: 'weekly' }),
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'Save failed' }) });
      }
      if (String(input) === '/api/tasks/task-1') return json({ task: recurringTask });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const nextDateLabel = new Date('2026-08-03T12:00:00').toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const skipButton = await screen.findByRole('button', { name: `Skip to current Next: ${nextDateLabel}` });

    fireEvent.click(skipButton);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    expect(screen.getByRole('button', { name: `Skip to current Next: ${nextDateLabel}` })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Due date' })).toHaveTextContent('Jul 27, 2026');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('does not show the due-date recurrence shortcut for non-recurring tasks', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    await screen.findByRole('heading', { name: task.title });
    expect(screen.queryByRole('button', { name: 'View recurrence settings' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip to current/ })).not.toBeInTheDocument();
  });

  it('keeps a mobile close affordance while task details are loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

    renderPanel({ taskId: 'task-1', mode: 'mobile', onClose: vi.fn() });

    expect(screen.getByRole('button', { name: 'Close task detail' })).toBeInTheDocument();
  });

  it('moves focus into the side panel without scrolling the underlying view', () => {
    vi.stubGlobal('fetch', vi.fn(() => json({})));
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      focusPanelOnMount: true,
    });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true });
  });

  it('keeps the full title visible and exposes popout and expanded Notes actions', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onModeChange = vi.fn();

    const { container } = renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      onModeChange,
    });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    expect(screen.getByText(formatTaskDetailUpdatedAt(task.updatedAt))).toBeInTheDocument();
    expect(container.querySelector('aside')).toHaveStyle({ width: '430px' });
    expect(screen.getByRole('button', { name: task.title })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Open popout' }));
    expect(onModeChange).toHaveBeenCalledWith('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Expand notes' }));
    expect(screen.getByRole('dialog', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
  });

  it('opens expanded Notes in the requested mode after the task loads', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      notesOpenRequest: { requestId: 1, taskId: 'task-1', mode: 'edit' },
    });

    expect(await screen.findByRole('dialog', { name: 'Notes' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Edit notes' })).toHaveValue(task.description);
  });

  it('preserves authored soft breaks, paragraphs, and Markdown formatting in read mode', async () => {
    const formattedTask = {
      ...task,
      description: 'First line\nSecond line\n\n**Bold** and _italic_ with [docs](https://example.com)',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: formattedTask });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    const notes = (await screen.findByRole('heading', { name: 'Notes' })).closest('section')!;
    await waitFor(() => {
      const paragraphs = notes.querySelectorAll('p');
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1);
      expect(paragraphs[0]).toHaveTextContent('First line Second line');
      expect(paragraphs[1].querySelector('strong')).toHaveTextContent('Bold');
      expect(paragraphs[1].querySelector('em')).toHaveTextContent('italic');
    });

    const link = screen.getByRole('link', { name: 'docs' });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    link.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link);
    expect(screen.queryByRole('textbox', { name: 'Edit notes' })).not.toBeInTheDocument();
  });

  it('syntax highlights fenced code blocks using their declared language', async () => {
    const formattedTask = {
      ...task,
      description: '```yaml\nruns-on: [self-hosted, macOS, ARM64, ios]\n```',
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task: formattedTask });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    const notes = (await screen.findByRole('heading', { name: 'Notes' })).closest('section')!;
    await waitFor(() => {
      const code = notes.querySelector('code.language-yaml.hljs');
      expect(code).toBeInTheDocument();
      expect(code?.querySelector('.hljs-attr')).toHaveTextContent('runs-on');
    });
  });

  it('keeps toolbar selection and focus while formatting and persists single newlines', async () => {
    const onUpdate = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') return json({});
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));

    const editor = screen.getByRole('textbox', { name: 'Edit notes' }) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 8);
    const boldButton = screen.getByRole('button', { name: 'Bold' });
    fireEvent.mouseDown(boldButton);
    fireEvent.click(boldButton);

    await waitFor(() => {
      expect(editor).toHaveValue('**Detailed** notes');
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(2);
      expect(editor.selectionEnd).toBe(10);
    });

    editor.setSelectionRange(13, 18);
    fireEvent.keyDown(editor, { key: 'i', ctrlKey: true });
    await waitFor(() => expect(editor).toHaveValue('**Detailed** _notes_'));

    const valueWithSoftBreak = `${editor.value}\nSecond line`;
    fireEvent.change(editor, { target: { value: valueWithSoftBreak } });
    fireEvent.blur(editor, { relatedTarget: document.body });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ description: valueWithSoftBreak }),
      }),
    ));
    expect(onUpdate).toHaveBeenCalledWith({ description: valueWithSoftBreak });
  });

  it('switches inline Notes to read mode before persistence finishes', async () => {
    let resolvePatch!: (response: { ok: boolean; json: () => Promise<object> }) => void;
    const patchRequest = new Promise<{ ok: boolean; json: () => Promise<object> }>((resolve) => {
      resolvePatch = resolve;
    });
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') return patchRequest;
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));

    const editor = screen.getByRole('textbox', { name: 'Edit notes' });
    fireEvent.change(editor, { target: { value: 'Optimistic **notes**' } });
    fireEvent.blur(editor, { relatedTarget: document.body });

    expect(screen.queryByRole('textbox', { name: 'Edit notes' })).not.toBeInTheDocument();
    expect(await screen.findByText('notes')).toBeInTheDocument();
    expect(onUpdate).not.toHaveBeenCalled();

    await act(async () => {
      resolvePatch({ ok: true, json: async () => ({}) });
      await patchRequest;
    });
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ description: 'Optimistic **notes**' }));
  });

  it('restores the inline Notes draft when optimistic persistence fails', async () => {
    let resolvePatch!: (response: { ok: boolean; json: () => Promise<object> }) => void;
    const patchRequest = new Promise<{ ok: boolean; json: () => Promise<object> }>((resolve) => {
      resolvePatch = resolve;
    });
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') return patchRequest;
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));

    const editor = screen.getByRole('textbox', { name: 'Edit notes' });
    fireEvent.change(editor, { target: { value: 'Draft that must survive' } });
    fireEvent.blur(editor, { relatedTarget: document.body });

    expect(screen.queryByRole('textbox', { name: 'Edit notes' })).not.toBeInTheDocument();
    expect(await screen.findByText('Draft that must survive')).toBeInTheDocument();

    await act(async () => {
      resolvePatch({ ok: false, json: async () => ({ error: 'Save failed' }) });
      await patchRequest;
    });

    expect(await screen.findByRole('textbox', { name: 'Edit notes' })).toHaveValue('Draft that must survive');
    expect(toast.error).toHaveBeenCalledWith('Failed to save notes');
  });

  it('does not let an older failed save roll back or report over newer Notes', async () => {
    let resolveFirstPatch!: (response: { ok: boolean; json: () => Promise<object> }) => void;
    const firstPatch = new Promise<{ ok: boolean; json: () => Promise<object> }>((resolve) => {
      resolveFirstPatch = resolve;
    });
    let patchCount = 0;
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') {
        patchCount++;
        return patchCount === 1 ? firstPatch : json({});
      }
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes' }), {
      target: { value: 'First draft' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Edit notes' }), {
      relatedTarget: document.body,
    });

    fireEvent.click(await screen.findByText('First draft'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes' }), {
      target: { value: 'Newest draft' },
    });
    fireEvent.blur(screen.getByRole('textbox', { name: 'Edit notes' }), {
      relatedTarget: document.body,
    });

    expect(await screen.findByText('Newest draft')).toBeInTheDocument();
    expect(patchCount).toBe(1);

    await act(async () => {
      resolveFirstPatch({ ok: false, json: async () => ({ error: 'Save failed' }) });
      await firstPatch;
    });

    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ description: 'Newest draft' }));
    expect(screen.getByText('Newest draft')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Edit notes' })).not.toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps expanded edit and preview rendering in parity', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Expand notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    const editor = screen.getByRole('textbox', { name: 'Edit notes' });
    fireEvent.change(editor, {
      target: { value: 'Preview line one\nPreview line two\n\n**Preview bold**' },
    });

    const preview = screen.getByLabelText('Notes preview');
    await waitFor(() => {
      const paragraphs = preview.querySelectorAll('p');
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0].querySelectorAll('br')).toHaveLength(1);
      expect(paragraphs[1].querySelector('strong')).toHaveTextContent('Preview bold');
    });
    expect(screen.getByRole('toolbar', { name: 'Markdown formatting' })).toBeInTheDocument();
  });

  it('does not show a checklist update as saved when persistence fails', async () => {
    const checklistTask = { ...task, description: '- [ ] Verify persistence' };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'Save failed' }) });
      }
      if (String(input) === '/api/tasks/task-1') return json({ task: checklistTask });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const notes = (await screen.findByRole('heading', { name: 'Notes' })).closest('section')!;
    const checkbox = await waitFor(() => {
      const input = notes.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(input).not.toBeNull();
      return input!;
    });

    await act(async () => {
      fireEvent.click(checkbox);
    });

    await waitFor(() => {
      expect(notes.querySelector<HTMLInputElement>('input[type="checkbox"]')).not.toBeChecked();
      expect(screen.getByText('Verify persistence')).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/tasks/task-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ description: '- [x] Verify persistence' }),
        }),
      );
    });
  });

  it('cancels an inline notes draft on Escape without closing task detail', async () => {
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: string | URL | Request, _init?: RequestInit) => {
      if (String(input) === '/api/tasks/task-1') return json({ task });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose });
    await screen.findByRole('heading', { name: task.title });
    fireEvent.click(screen.getByRole('button', { name: 'Edit notes' }));
    const editor = screen.getByRole('textbox', { name: 'Edit notes' });
    fireEvent.change(editor, { target: { value: 'Unsaved draft' } });

    const boldButton = screen.getByRole('button', { name: 'Bold' });
    act(() => boldButton.focus());
    fireEvent.keyDown(boldButton, { key: 'Escape' });

    expect(screen.queryByRole('textbox', { name: 'Edit notes' })).not.toBeInTheDocument();
    expect(screen.getByText('Detailed notes')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
  });

  it('uses a non-actionable empty state for read-only notes', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/tasks/task-1') {
        return json({
          task: {
            ...task,
            description: null,
            editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }),
          },
        });

        it('persists disabled-mirror disposition locally with upstream explanation', async () => {
          const onUpdate = vi.fn();
          const mirrorTask = {
            ...task,
            connectorType: 'github-issues',
            connectorInstanceId: 'github-disabled',
            sourceId: 'issue:1',
            localDisposition: 'active' as const,
            taskSourceModel: 'remote-mirror' as const,
            editPolicy: makeTaskEditPolicy({
              sourceModel: 'remote-mirror',
              connectorEnabled: false,
            }),
          };
          const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
            if (String(input) === '/api/tasks/task-1' && init?.method === 'PATCH') {
              return json({
                success: true,
                fields: { localDisposition: { mode: 'local', persisted: true } },
              });
            }
            if (String(input) === '/api/tasks/task-1') return json({ task: mirrorTask });
            return json({});
          });
          vi.stubGlobal('fetch', fetchMock);

          renderPanel({ taskId: 'task-1', mode: 'mobile', onClose: vi.fn(), onUpdate });
          expect(await screen.findByText('Hide or restore this task locally. The upstream task is unchanged.'))
            .toBeInTheDocument();
          fireEvent.click(screen.getByRole('button', { name: /Mark handled here/i }));

          await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
            '/api/tasks/task-1',
            expect.objectContaining({
              method: 'PATCH',
              body: JSON.stringify({ localDisposition: 'handled' }),
            }),
          ));
          expect(onUpdate).toHaveBeenCalledWith({ localDisposition: 'handled' });
        });
      }
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByText('description is controlled by the upstream task source')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit notes' })).toBeDisabled();
  });

  it('formats the selected text with the Markdown toolbar in expanded Notes', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      notesOpenRequest: { requestId: 1, taskId: 'task-1', mode: 'edit' },
    });

    const notesDialog = await screen.findByRole('dialog', { name: 'Notes' });
    const editor = within(notesDialog).getByRole('textbox', { name: 'Edit notes' }) as HTMLTextAreaElement;
    editor.setSelectionRange(0, 8);
    const boldButton = within(notesDialog).getByRole('button', { name: 'Bold' });
    fireEvent.mouseDown(boldButton);
    fireEvent.click(boldButton);

    expect(editor).toHaveValue('**Detailed** notes');
    expect(boldButton).toHaveClass('min-h-8', 'min-w-8');
    expect(within(notesDialog).getByRole('button', { name: 'Italic' })).toBeInTheDocument();
    expect(within(notesDialog).getByRole('button', { name: 'Insert link' })).toBeInTheDocument();
    expect(within(notesDialog).getByRole('button', { name: 'Code' })).toBeInTheDocument();
    expect(within(notesDialog).getByRole('button', { name: 'Bulleted list' })).toBeInTheDocument();
  });

  it.each([
    ['panel', false],
    ['mobile', false],
    ['dialog', true],
    ['workspace', true],
  ] as const)('sizes the Notes editor vertically for %s mode', async (mode, fillsAllocatedSpace) => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode, onClose: vi.fn() });

    fireEvent.click(await screen.findByText('Detailed notes'));
    const editor = screen.getByRole('textbox', { name: 'Edit notes' });

    if (fillsAllocatedSpace) {
      expect(editor).toHaveClass('min-h-0', 'flex-1', 'resize-none');
      expect(editor).not.toHaveClass('max-h-72');
      expect(editor.closest('section')).toHaveClass('flex', 'self-stretch');
    } else {
      expect(editor).toHaveClass('min-h-32', 'max-h-72', 'resize-y');
      expect(editor).not.toHaveClass('flex-1');
    }
  });

  it('offers the full workspace from the popout', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onModeChange = vi.fn();

    renderPanel({
      taskId: 'task-1',
      mode: 'dialog',
      onClose: vi.fn(),
      onModeChange,
    });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: `Task details: ${task.title}` })).toHaveClass('w-[min(920px,94vw)]');
    fireEvent.click(screen.getByRole('button', { name: 'Use full workspace' }));
    expect(onModeChange).toHaveBeenCalledWith('workspace');
  });

  it('places conditional duplicate warnings without overlapping workspace fields', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [{ id: 'duplicate-1' }] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'workspace', onClose: vi.fn() });

    const warning = await screen.findByText('Duplicate candidate');
    expect(warning.closest('section')).toHaveClass('col-start-2', 'row-start-5');
  });

  it('keeps conditional duplicate warnings before source actions in the panel flow', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.endsWith('/relationships')) return json({ relationships: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [{ id: 'duplicate-1' }] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      sourceLists: [
        { id: 'list-1', sourceId: 'list-1', connectorInstanceId: 'local', name: 'Inbox', taskCount: 1, groupId: null },
        { id: 'list-2', sourceId: 'list-2', connectorInstanceId: 'local', name: 'Backlog', taskCount: 1, groupId: null },
      ],
      onMoveToList: vi.fn(),
    });

    const warning = (await screen.findByText('Duplicate candidate')).closest('section')!;
    const source = screen.getByRole('heading', { name: 'Source & actions' }).closest('section')!;
    expectBefore(warning, source);
  });

  it('matches the approved panel hierarchy and nests duration under effort', async () => {
    const githubTask = {
      ...task,
      connectorType: 'github-issues',
      sourceId: 'owner/repo:123',
      projectIds: ['project-1'],
      editPolicy: makeTaskEditPolicy({
        sourceModel: 'remote-managed',
        sourceMoveSupported: true,
      }),
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: githubTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'project-1', name: 'Reporting & Insights', icon: null, color: '#60a5fa' },
        { id: 'project-2', name: 'Product analytics', icon: null, color: '#a78bfa' },
      ] });
      if (url === '/api/projects/project-1/hierarchy') return json({ hierarchy: projectHierarchy });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onMoveToList = vi.fn();

    const { container } = renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      onToggleMyDay: vi.fn(),
      sourceLists: [
        { id: 'list-1', sourceId: 'list-1', connectorInstanceId: 'local', name: 'Inbox', taskCount: 1, groupId: null },
        { id: 'list-2', sourceId: 'list-2', connectorInstanceId: 'local', name: 'Backlog', taskCount: 1, groupId: null },
      ],
      onMoveToList,
    });

    const title = await screen.findByRole('heading', { name: task.title });
    expect(title).toHaveTextContent(task.title);
    expect(screen.getByText('#123')).toBeInTheDocument();

    expect(screen.getByRole('combobox', { name: 'Task duration' })).toHaveTextContent('Duration: 30 min');
    expect(screen.queryByRole('button', { name: '15m' })).not.toBeInTheDocument();

    const notes = screen.getByRole('heading', { name: 'Notes' }).closest('section')!;
    const tags = screen.getByRole('heading', { name: 'Tags' }).closest('section')!;
    const projects = screen.getByRole('heading', { name: 'Projects & phases' }).closest('section')!;
    const planning = screen.getByRole('heading', { name: 'Planning' }).closest('section')!;
    const subtasks = screen.getByRole('heading', { name: 'Subtasks' }).closest('section')!;
    const relationships = container.querySelector('[data-task-relationships-slot]')!;
    const source = screen.getByRole('heading', { name: 'Source & actions' }).closest('section')!;
    const attachments = screen.getByText('Attachment list').parentElement!;

    expect(notes).toHaveClass('order-1');
    expect(tags).toHaveClass('order-2');
    expect(projects).toHaveClass('order-3');
    expect(screen.getAllByText('Reporting & Insights')).toHaveLength(2);
    expect(await screen.findByText('Charts & visualization')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Add project' })).toBeInTheDocument();
    expect(planning).toHaveClass('order-4');
    expect(subtasks).toHaveClass('order-5');
    expect(relationships).toHaveClass('order-6');
    expect(screen.getByRole('heading', { name: 'Relationships' })).toBeInTheDocument();
    expect(attachments).toHaveClass('order-8');

    expectBefore(notes, tags);
    expectBefore(tags, projects);
    expectBefore(projects, planning);
    expectBefore(planning, subtasks);
    expectBefore(subtasks, relationships);
    expectBefore(relationships, source);
    expectBefore(source, attachments);

    fireEvent.click(screen.getByRole('button', { name: 'Move list' }));
    expect(source).toHaveClass('overflow-visible');
    fireEvent.click(screen.getByRole('button', { name: 'Backlog' }));
    expect(onMoveToList).toHaveBeenCalledWith('list-2');
  });

  it('shows and removes an assigned hidden project without offering hidden projects for assignment', async () => {
    const projectTask = { ...task, projectIds: ['hidden-project'] };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: projectTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'visible-project', name: 'Visible project', icon: null, color: '#60a5fa', hidden: false },
        { id: 'hidden-project', name: 'Hidden project', icon: null, color: '#a78bfa', hidden: true },
        { id: 'other-hidden-project', name: 'Other hidden project', icon: null, color: '#f472b6', hidden: true },
      ] });
      if (url === '/api/projects/hidden-project/hierarchy') return json({
        hierarchy: { ...projectHierarchy, projectId: 'hidden-project' },
      });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      if (url === '/api/hub-projects/hidden-project/tasks') return json({ success: true });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    const projectMenu = await screen.findByRole('button', { name: 'Edit phase for Hidden project' });
    fireEvent.pointerDown(projectMenu);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove project' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Edit phase for Hidden project' })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('combobox', { name: 'Add project' }));
    expect(screen.getByRole('option', { name: /Visible project/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Other hidden project/ })).not.toBeInTheDocument();
  });

  it('shows recent projects first and groups the remaining project choices by category', async () => {
    localStorage.setItem('mission-control:recent-project-targets', JSON.stringify(['project-recent']));
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'project-work', name: 'Work project', icon: null, color: '#60a5fa', category: 'Work' },
        { id: 'project-personal', name: 'Personal project', icon: null, color: '#60a5fa', category: 'Personal' },
        { id: 'project-recent', name: 'Recent project', icon: null, color: '#60a5fa', category: 'Personal' },
        { id: 'project-other', name: 'Other project', icon: null, color: '#60a5fa', category: null },
      ] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    fireEvent.click(await screen.findByRole('combobox', { name: 'Add project' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent?.replace('📁', ''))).toEqual([
      'Recent project',
      'Personal project',
      'Work project',
      'Other project',
    ]);
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(screen.getByText('Personal')).toBeInTheDocument();
    expect(screen.getByText('Work')).toBeInTheDocument();
    expect(screen.getByText('Uncategorized')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('option', { name: /Work project/ }));
    expect(JSON.parse(localStorage.getItem('mission-control:recent-project-targets') ?? '[]')).toEqual([
      'project-work',
      'project-recent',
    ]);
  });

  it.each(['dialog', 'workspace'] as const)(
    'places relationships in the approved %s primary-column grid slot',
    async (mode) => {
      vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
        const url = String(input);
        if (url === '/api/tasks/task-1') return json({ task });
        if (url.endsWith('/relationships')) return json({ relationships: [] });
        if (url === '/api/features') return json({ taskDestinations: [] });
        if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
        if (url === '/api/connectors') return json({ connectors: [] });
        if (url.includes('detect-duplicates')) return json({ duplicates: [] });
        return json({});
      }));

      const { container } = renderPanel({
        taskId: 'task-1',
        mode,
        onClose: vi.fn(),
      });

      expect(await screen.findByRole('heading', { name: 'Relationships' })).toBeInTheDocument();
      expect(container.querySelector('[data-task-relationships-slot]')).toHaveClass(
        'col-start-1',
        'row-start-6',
      );
    },
  );

  it('keeps expanded Notes open when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'Save failed' }) });
      }
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
    });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand notes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Edit notes' }), { target: { value: 'Unsaved notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save notes' }));

    expect(await screen.findByRole('textbox', { name: 'Edit notes' })).toHaveValue('Unsaved notes');
    expect(screen.getByRole('button', { name: 'Save notes' })).toBeInTheDocument();
  });

  it('gives expanded Notes Escape precedence and restores focus', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onClose = vi.fn();

    renderPanel({ taskId: 'task-1', mode: 'mobile', onClose });
    expect(await screen.findByText(task.title)).toBeInTheDocument();
    const expandButton = screen.getByRole('button', { name: 'Expand notes' });
    fireEvent.click(expandButton);
    expect(screen.getByRole('dialog', { name: 'Notes' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Notes' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    await waitFor(() => expect(expandButton).toHaveFocus());
  });

  it('renders mobile actions without desktop mode controls', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    const onComplete = vi.fn();
    const onDelete = vi.fn();
    const { container } = renderPanel({
      taskId: 'task-1',
      mode: 'mobile',
      onClose: vi.fn(),
      onToggleMyDay: vi.fn(),
      onComplete,
      onDelete,
    });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'My Day' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Complete' })).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Open popout' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Close task detail' }).closest('header')).toHaveClass('sticky', 'top-0');
    expect(await screen.findByRole('button', { name: 'Add' })).toHaveClass('min-h-11');
    const moreButton = screen.getByRole('button', { name: 'More task actions' });
    expect(moreButton).toHaveClass('min-h-11', 'min-w-11');
    expect(container.querySelector('.mx-auto')).toHaveClass('[&_button]:min-w-11');

    fireEvent.click(screen.getByText('Detailed notes'));
    expect(screen.getByRole('button', { name: 'Bold' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Italic' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Complete' }));
    fireEvent.pointerDown(moreButton);
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete task' }));
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it('changes and removes project phases through the revision-safe hierarchy API', async () => {
    const projectTask = { ...task, projectIds: ['project-1'] };
    const updatedHierarchy = {
      ...projectHierarchy,
      revision: 4,
      phaseItemsByPhase: {
        'phase-1': [],
        'phase-2': [{ id: 'item-1', phaseId: 'phase-2', taskId: 'task-1' }],
      },
    };
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: projectTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'project-1', name: 'Reporting & Insights', icon: null, color: '#60a5fa' },
      ] });
      if (url === '/api/projects/project-1/hierarchy' && init?.method === 'POST') {
        const request = JSON.parse(String(init.body)) as { command: { toPhaseId: string | null } };
        const hierarchy = request.command.toPhaseId === null
          ? {
              ...updatedHierarchy,
              revision: 5,
              phaseItemsByPhase: { 'phase-1': [], 'phase-2': [] },
            }
          : updatedHierarchy;
        return json({
          commandId: 'command-1',
          revision: hierarchy.revision,
          hierarchy,
          inverseCommand: { type: 'move_tasks', taskIds: ['task-1'], toPhaseId: 'phase-1', toIndex: 0 },
        });
      }
      if (url === '/api/projects/project-1/hierarchy') return json({ hierarchy: projectHierarchy });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByText('Charts & visualization')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit phase for Reporting & Insights' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Charts & visualization' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Q3 reporting' }));

    expect(await screen.findByText('Q3 reporting')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/project-1/hierarchy',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"toPhaseId":"phase-2"'),
      }),
    );

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit phase for Reporting & Insights' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No phase' }));
    expect(await screen.findByText('No phase')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/projects/project-1/hierarchy',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"toPhaseId":null'),
      }),
    );
  });

  it('keeps the current phase visible when a phase update fails', async () => {
    const projectTask = { ...task, projectIds: ['project-1'] };
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: projectTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'project-1', name: 'Reporting & Insights', icon: null, color: '#60a5fa' },
      ] });
      if (url === '/api/projects/project-1/hierarchy' && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: async () => ({ error: 'Phase update failed' }),
        });
      }
      if (url === '/api/projects/project-1/hierarchy') return json({ hierarchy: projectHierarchy });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    expect(await screen.findByText('Charts & visualization')).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Edit phase for Reporting & Insights' }));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Q3 reporting' }));

    await waitFor(() => expect(screen.getByText('Charts & visualization')).toBeInTheDocument());
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('renders each project phase as its hierarchy request settles', async () => {
    const projectTask = { ...task, projectIds: ['project-1', 'project-2'] };
    const secondHierarchy = {
      ...projectHierarchy,
      projectId: 'project-2',
      phases: [{ id: 'phase-2', projectId: 'project-2', name: 'Ready phase' }],
      phaseItemsByPhase: {
        'phase-2': [{ id: 'item-2', phaseId: 'phase-2', taskId: 'task-1' }],
      },
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: projectTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [
        { id: 'project-1', name: 'Slow project', icon: null, color: '#60a5fa' },
        { id: 'project-2', name: 'Ready project', icon: null, color: '#a78bfa' },
      ] });
      if (url === '/api/projects/project-1/hierarchy') return new Promise(() => {});
      if (url === '/api/projects/project-2/hierarchy') return json({ hierarchy: secondHierarchy });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByText('Ready phase')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit phase for Slow project' }).parentElement)
      .toHaveTextContent('Phase: Loading...');
  });

  it.each([
    { connectorType: 'github-issues', connectorInstanceId: 'github-1', removalMode: 'upstream-close', expectedLabel: 'Close at source' },
    { connectorType: 'microsoft-todo', connectorInstanceId: 'todo-1', removalMode: 'upstream-delete', expectedLabel: 'Delete from source' },
    { connectorType: 'microsoft-todo', connectorInstanceId: 'todo-2', removalMode: 'blocked', expectedLabel: null },
  ] as const)('uses $removalMode mobile removal semantics for $connectorType', async ({
    connectorType,
    connectorInstanceId,
    removalMode,
    expectedLabel,
  }) => {
    const sourceTask = {
      ...task,
      connectorType,
      connectorInstanceId,
      sourceId: `${connectorType}:task-1`,
      editPolicy: makeTaskEditPolicy({
        sourceModel: 'remote-managed',
        removalMode,
        removalReason: removalMode === 'blocked' ? 'The upstream source does not support removing this task' : undefined,
      }),
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: sourceTask });
      if (url === '/api/features') return json({ taskDestinations: [{
        id: connectorInstanceId,
        capabilities: { delete: removalMode === 'upstream-delete' },
      }] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'mobile',
      onClose: vi.fn(),
      onDelete: vi.fn(),
    });

    const moreButton = await screen.findByRole('button', { name: 'More task actions' });
    await waitFor(() => expect(moreButton).toHaveProperty('disabled', expectedLabel === null));
    if (expectedLabel) {
      fireEvent.pointerDown(moreButton);
      expect(await screen.findByRole('menuitem', { name: expectedLabel })).toBeInTheDocument();
    } else {
      expect(screen.queryByRole('menuitem', { name: /source|task/i })).not.toBeInTheDocument();
    }
  });

  it('keeps all desktop presentations reachable at mockup dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onModeChange = vi.fn();

    renderPanel({ taskId: 'task-1', mode: 'workspace', onClose: vi.fn(), onModeChange });
    const workspace = await screen.findByRole('dialog', { name: `Task workspace: ${task.title}` });
    expect(workspace).toHaveClass('max-w-[1320px]');
    expect(workspace.querySelector('.mx-auto')).toHaveClass('max-w-[1320px]');

    fireEvent.click(screen.getByRole('button', { name: 'Exit full workspace' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pin to side panel' }));
    expect(onModeChange).toHaveBeenNthCalledWith(1, 'dialog');
    expect(onModeChange).toHaveBeenNthCalledWith(2, 'panel');
  });

  it('humanizes task detail update dates at local calendar boundaries', () => {
    const now = new Date(2026, 6, 31, 0, 5);
    expect(formatTaskDetailUpdatedAt(new Date(2026, 6, 31, 0, 1).toISOString(), now)).toBe('Updated today');
    expect(formatTaskDetailUpdatedAt(new Date(2026, 6, 30, 23, 59).toISOString(), now)).toBe('Updated yesterday');
    expect(formatTaskDetailUpdatedAt('invalid', now)).toBe('Updated recently');
    expect(formatTaskDetailUpdatedAt(new Date(2026, 6, 20).toISOString(), now)).toMatch(/^Updated Jul 20, 2026$/);
  });

  it('shows existing tags without mutation controls for read-only tasks', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({
        task: {
          ...task,
          tagIds: ['tag-1'],
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            mutations: { tags: 'blocked' },
          }),
        },
      });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'mobile',
      onClose: vi.fn(),
      availableTags: [{ id: 'tag-1', name: 'Read only', slug: 'read-only', color: null }],
    });

    expect(await screen.findByText('Read only')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove tag Read only' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add tag' })).toBeDisabled();
  });

  it('uses the dependency field policy for subtask creation', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({
        task: {
          ...task,
          editPolicy: makeTaskEditPolicy({
            sourceModel: 'remote-mirror',
            mutations: { dependencies: 'blocked' },
          }),
        },
      });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'mobile', onClose: vi.fn() });

    expect(await screen.findByText('Subtask list')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add mocked subtask' })).not.toBeInTheDocument();
  });

  it('hides same-source Move list actions for read-only tasks', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({
        task: { ...task, editPolicy: makeTaskEditPolicy({ sourceModel: 'remote-mirror' }) },
      });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({
      taskId: 'task-1',
      mode: 'panel',
      onClose: vi.fn(),
      sourceLists: [
        { id: 'list-1', sourceId: 'list-1', connectorInstanceId: 'local', name: 'Inbox', taskCount: 1, groupId: null },
        { id: 'list-2', sourceId: 'list-2', connectorInstanceId: 'local', name: 'Backlog', taskCount: 1, groupId: null },
      ],
      onMoveToList: vi.fn(),
    });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move list' })).not.toBeInTheDocument();
  });

  it('marks a task complete without sending immutable lifecycle fields', async () => {
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Complete' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ status: 'done' }),
      }),
    ));
    expect(onUpdate).toHaveBeenCalledWith({ status: 'done' });
    expect(screen.getByRole('combobox', { name: 'Task status' })).toHaveTextContent('Done');
  });

  it('adds a task to My Day from an unhosted detail panel', async () => {
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/my-day' && init?.method === 'POST') {
        return json({ id: 'md-1', writeBack: { attempted: false, success: true } });
      }
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    fireEvent.click(await screen.findByRole('button', { name: 'Add to My Day' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/my-day', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: 'task-1', date: '2026-08-01' }),
    }));
    expect(await screen.findByRole('button', { name: 'On My Day' })).toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledWith();
    expect(toast.success).toHaveBeenCalledWith('Added to My Day');
  });

  it('removes a task from My Day from an unhosted detail panel', async () => {
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: { ...task, isInMyDay: true } });
      if (url === '/api/my-day?taskId=task-1&date=2026-08-01' && init?.method === 'DELETE') {
        return json({ success: true, writeBack: { attempted: false, success: true } });
      }
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    fireEvent.click(await screen.findByRole('button', { name: 'On My Day' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/my-day?taskId=task-1&date=2026-08-01',
      { method: 'DELETE' },
    ));
    expect(await screen.findByRole('button', { name: 'Add to My Day' })).toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalledWith();
    expect(toast.success).toHaveBeenCalledWith('Removed from My Day');
  });

  it('does not report failed status updates as successful', async () => {
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return Promise.resolve({ ok: false, json: async () => ({ error: 'Save failed' }) });
      }
      if (url === '/api/tasks/task-1') return json({ task });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn(), onUpdate });
    fireEvent.click(await screen.findByRole('button', { name: 'Mark Complete' }));

    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    ));
    expect(onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox', { name: 'Task status' })).toHaveTextContent('To Do');
  });

  it('preserves the blocked Kanban status in the shared status picker', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: { ...task, status: 'blocked' } });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByRole('combobox', { name: 'Task status' })).toHaveTextContent('Blocked');
  });

  it('shows only the sticky Complete action for document tasks on mobile', async () => {
    const documentTask = {
      ...task,
      connectorType: 'document-intelligence',
      metadata: JSON.stringify({ previewUrl: 'https://example.com/document' }),
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: documentTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'mobile', onClose: vi.fn(), onComplete: vi.fn() });

    expect(await screen.findByRole('button', { name: 'Complete' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark Complete' })).not.toBeInTheDocument();
  });

  it.each([
    { label: 'active editable', status: 'todo', canEditStatus: true, expectedCompleteActions: 1, expectedDisabled: false },
    { label: 'read-only', status: 'todo', canEditStatus: false, expectedCompleteActions: 1, expectedDisabled: true },
    { label: 'completed', status: 'done', canEditStatus: true, expectedCompleteActions: 0, expectedDisabled: false },
    { label: 'cancelled', status: 'cancelled', canEditStatus: true, expectedCompleteActions: 0, expectedDisabled: false },
  ])('shows canonical completion controls for $label document tasks', async ({
    status,
    canEditStatus,
    expectedCompleteActions,
    expectedDisabled,
  }) => {
    const documentTask = {
      ...task,
      status,
      connectorType: 'document-intelligence',
      metadata: JSON.stringify({ previewUrl: 'https://example.com/document' }),
      editPolicy: makeTaskEditPolicy({
        mutations: canEditStatus ? {} : { status: 'blocked' },
      }),
    };
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task: documentTask });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByRole('link', { name: 'Open Doc' })).toBeInTheDocument();
    const completeActions = screen.queryAllByRole('button', { name: 'Mark Complete' });
    expect(completeActions).toHaveLength(expectedCompleteActions);
    if (completeActions[0]) expect(completeActions[0]).toHaveProperty('disabled', expectedDisabled);
  });

  it('dismisses relationship editing without closing the panel or losing an unsaved title', async () => {
    let relationshipLoads = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') return json({ task });
      if (url.endsWith('/relationships')) {
        relationshipLoads++;
        return json({ relationships: [] });
      }
      if (url.includes('relationship-candidates')) return json({ candidates: [] });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));
    const onClose = vi.fn();

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose });
    fireEvent.click(await screen.findByText(task.title));
    const titleInput = screen.getByDisplayValue(task.title);
    fireEvent.change(titleInput, { target: { value: 'Unsaved title draft' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    const search = screen.getByLabelText('Find a task across all projects');

    fireEvent.keyDown(search, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Find a task across all projects')).not.toBeInTheDocument();
    expect(titleInput).toHaveValue('Unsaved title draft');

    window.dispatchEvent(new CustomEvent('mission-control:task-relationships-changed', {
      detail: { taskIds: ['task-1'] },
    }));
    await waitFor(() => expect(relationshipLoads).toBeGreaterThan(1));
    expect(titleInput).toHaveValue('Unsaved title draft');
  });

  it('renders GitHub embedded images from synchronized notes', async () => {
    const imageUrl = 'https://github.com/user-attachments/assets/61668656-37e6-4245-b2a3-92a4a0daac2a';
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') {
        return json({
          task: {
            ...task,
            description: `<img width="572" height="738" alt="Image" src="${imageUrl}" />`,
            sourceUrl: 'https://github.com/octo-org/mission-control/issues/2149',
          },
        });
      }
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    const image = await screen.findByRole('img', { name: 'Image' });
    expect(image).toHaveAttribute('src', imageUrl);
    expect(image).toHaveAttribute('width', '572');
    expect(image).toHaveAttribute('height', '738');
  });

  it('replaces a failed GitHub image with a link to the source task', async () => {
    const imageUrl = 'https://github.com/user-attachments/assets/private-image';
    const sourceUrl = 'https://github.com/octo-org/mission-control/issues/2149';
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') {
        return json({
          task: {
            ...task,
            description: `<img alt="Architecture diagram" src="${imageUrl}" />`,
            sourceUrl,
          },
        });
      }
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const image = await screen.findByRole('img', { name: 'Architecture diagram' });

    act(() => {
      image.dispatchEvent(new Event('error'));
    });

    expect(await screen.findByText('Image unavailable')).toBeInTheDocument();
    expect(screen.getByText('Private GitHub attachment could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open task in GitHub' })).toHaveAttribute('href', sourceUrl);
    expect(screen.queryByRole('img', { name: 'Architecture diagram' })).not.toBeInTheDocument();
  });

  it('does not render unsafe raw HTML from synchronized notes', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/tasks/task-1') {
        return json({ task: { ...task, description: '<iframe title="unsafe-frame" srcdoc="<script>parent.pwned=1</script>"></iframe>' } });
      }
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });

    expect(await screen.findByText(task.title)).toBeInTheDocument();
    expect(screen.queryByTitle('unsafe-frame')).not.toBeInTheDocument();
  });

  it('does not count raw HTML checkboxes as Markdown checklist items', async () => {
    const description = '<input type="checkbox" checked />\n\n- [ ] Verify persistence';
    const update = vi.fn();
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        update(JSON.parse(String(init.body)));
        return json({ task: { ...task, description } });
      }
      if (url === '/api/tasks/task-1') return json({ task: { ...task, description } });
      if (url === '/api/features') return json({ taskDestinations: [] });
      if (url === '/api/hub-projects?includeHidden=true') return json({ projects: [] });
      if (url === '/api/connectors') return json({ connectors: [] });
      if (url.includes('detect-duplicates')) return json({ duplicates: [] });
      return json({});
    }));

    renderPanel({ taskId: 'task-1', mode: 'panel', onClose: vi.fn() });
    const notes = (await screen.findByRole('heading', { name: 'Notes' })).closest('section')!;
    const checkboxes = await waitFor(() => {
      const inputs = notes.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      expect(inputs).toHaveLength(1);
      return inputs;
    });

    await act(async () => {
      fireEvent.click(checkboxes[0]);
    });

    await waitFor(() => expect(update).toHaveBeenCalledWith({
      description: '<input type="checkbox" checked />\n\n- [x] Verify persistence',
    }));
  });
});
