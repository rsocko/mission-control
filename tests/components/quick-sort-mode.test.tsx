import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QuickSortMode from '@/components/quick-sort/QuickSortMode';
import { editableTaskPolicy } from '../fixtures/task-edit-policy';

const mocks = vi.hoisted(() => ({
  dismiss: vi.fn(),
  refreshCounts: vi.fn(),
  refreshQueue: vi.fn(),
  reloadQueue: vi.fn(),
  alternateReloadQueue: vi.fn(),
  useAlternateReload: false,
  toastError: vi.fn(),
  updateTask: vi.fn(),
  suggestions: {},
  taskPriority: 'none',
  hasTasks: true,
}));

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    info: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock('@/lib/hooks/useQuickSortData', () => ({
  useQuickSortData: () => ({
    tasks: mocks.hasTasks ? [{
      id: 'task-1',
      title: 'Needs context',
      hasNotes: false,
      priority: mocks.taskPriority,
      effort: null,
      status: 'todo',
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceListId: null,
      sourceListName: null,
      dueDate: null,
      createdAt: '2026-07-31T12:00:00.000Z',
      projects: [],
      phases: [],
      tags: [],
      editPolicy: editableTaskPolicy,
    }] : [],
    loading: false,
    counts: { no_priority: 1, no_effort: 1, no_tags: 1, no_due_date: 0 },
    suggestions: mocks.suggestions,
    recentTagIds: [],
    dismiss: mocks.dismiss,
    updateTask: mocks.updateTask,
    refreshQueue: mocks.refreshQueue,
    reloadQueue: mocks.useAlternateReload ? mocks.alternateReloadQueue : mocks.reloadQueue,
    refreshCounts: mocks.refreshCounts,
    recordRecentTag: vi.fn(),
  }),
}));

vi.mock('@/components/quick-sort/ModeSelector', () => ({
  default: ({ onSelect, disabled }: { onSelect: (mode: string) => void; disabled?: boolean }) => (
    <>
      <button disabled={disabled} onClick={() => onSelect('no_tags')}>Open no-tags queue</button>
      <button disabled={disabled} onClick={() => onSelect('no_priority')}>Open priority queue</button>
    </>
  ),
}));
vi.mock('@/components/quick-sort/OrderSelector', () => ({ default: () => null }));
vi.mock('@/components/quick-sort/ScopeFilter', () => ({ default: () => null }));
vi.mock('@/components/quick-sort/ActivityBanner', () => ({ default: () => null }));
vi.mock('@/components/ui/AnimatedCounter', () => ({
  AnimatedCounter: ({ value }: { value: number }) => (
    <span data-testid="animated-counter">{value}</span>
  ),
}));
vi.mock('@/components/quick-sort/QuickSortCard', () => ({ default: () => <div>Task card</div> }));
vi.mock('@/components/quick-sort/QuickSortActions', () => ({
  default: ({ onSkip, onViewTask }: { onSkip: () => void; onViewTask: () => void }) => (
    <>
      <button onClick={onViewTask}>View task</button>
      <button onClick={onSkip}>Skip task</button>
    </>
  ),
}));
vi.mock('@/components/ui/MobileSheet', () => ({
  MobileSheet: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => isOpen ? children : null,
}));
vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({ mode, onUpdate }: { mode: string; onUpdate: () => void }) => (
    <div data-testid="task-detail-panel" data-mode={mode}>
      <button onClick={onUpdate}>Simulate tag update</button>
    </div>
  ),
}));

describe('QuickSortMode task drawer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useAlternateReload = false;
    mocks.refreshQueue.mockResolvedValue(undefined);
    mocks.reloadQueue.mockResolvedValue(undefined);
    mocks.alternateReloadQueue.mockResolvedValue(undefined);
    mocks.suggestions = {};
    mocks.taskPriority = 'none';
    mocks.hasTasks = true;
  });

  it('revalidates queue membership after fieldless drawer updates', () => {
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'View task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulate tag update' }));

    expect(mocks.refreshCounts).toHaveBeenCalledOnce();
    expect(mocks.refreshQueue).toHaveBeenCalledOnce();
  });

  it('opens task details as an inline desktop panel', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'View task' }));

    expect(screen.getByTestId('task-detail-panel')).toHaveAttribute('data-mode', 'panel');
  });

  it('mounts only the queue region appropriate for the responsive layout', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(<QuickSortMode />);

    expect(screen.getAllByRole('complementary', { name: 'Quick Sort queues' })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));

    expect(screen.queryByRole('complementary', { name: 'Quick Sort queues' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.getAllByRole('complementary', { name: 'Quick Sort queues' })).toHaveLength(1);
  });

  it('keeps exactly one queue region mounted beside the desktop workspace', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));

    expect(screen.getAllByRole('complementary', { name: 'Quick Sort queues' })).toHaveLength(1);
  });

  it('updates the mounted queue region when crossing the desktop breakpoint', () => {
    let isSingleColumn = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query === '(max-width: 1023px)' ? isSingleColumn : false,
      addEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        if (query === '(max-width: 1023px)') listeners.add(listener);
      },
      removeEventListener: (_event: string, listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
    })));
    render(<QuickSortMode />);
    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));

    expect(screen.getAllByRole('complementary', { name: 'Quick Sort queues' })).toHaveLength(1);

    isSingleColumn = true;
    act(() => {
      listeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    expect(screen.queryByRole('complementary', { name: 'Quick Sort queues' })).not.toBeInTheDocument();

    isSingleColumn = false;
    act(() => {
      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
    });
    expect(screen.getAllByRole('complementary', { name: 'Quick Sort queues' })).toHaveLength(1);
  });

  it('offers an explicit desktop action for the focused AI suggestion', async () => {
    mocks.suggestions = {
      'task-1': {
        priority: null,
        effort: null,
        tags: [{ id: 'tag-1', name: 'Planning', confidence: 0.9 }],
      },
    };
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply suggestion/ }));

    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('task-1'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('keeps a task visible when Apply all has no applicable suggestion', async () => {
    mocks.taskPriority = 'high';
    mocks.suggestions = {
      'task-1': {
        priority: { value: 'high', confidence: 0.9, reason: 'Already prioritized' },
        effort: null,
        tags: [],
      },
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ success: true }))));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: /Apply all/ }));

    await waitFor(() => expect(screen.getByText('Task card')).toBeInTheDocument());
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(mocks.refreshCounts).not.toHaveBeenCalled();
  });

  it('supports desktop keyboard shortcuts without requiring swipe gestures', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));
    fireEvent.keyDown(document, { key: '2' });

    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('task-1'));
    const patchCall = fetchMock.mock.calls.find(([url]) => url === '/api/tasks/task-1');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ priority: 'high' });
  });

  it('leaves global navigation chords to the app shortcut handler', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));
    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.keyDown(document, { key: 'd' });

    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('preserves a pending global chord while the local queue state changes', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuickSortMode />);

    fireEvent.keyDown(document, { key: 'g' });
    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));
    fireEvent.keyDown(document, { key: 'd' });

    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('ignores repeated desktop shortcut keydown events', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));
    fireEvent.keyDown(document, { key: '2', repeat: true });

    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });

  it('does not intercept repeated unrelated keys', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open priority queue' }));
    const event = new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      repeat: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('renders the remaining queue count with the animated counter', () => {
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));

    expect(screen.getByText('left')).toContainElement(screen.getByTestId('animated-counter'));
    expect(screen.getByTestId('animated-counter')).toHaveTextContent('1');
  });

  it('surfaces background queue refresh failures', async () => {
    mocks.refreshQueue.mockRejectedValueOnce(new Error('offline'));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'View task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Simulate tag update' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Failed to refresh Quick Sort');
    });
  });

  it('revalidates badge counts while the queue selector is open', () => {
    const intervalSpy = vi.spyOn(window, 'setInterval');
    render(<QuickSortMode />);

    const revalidationInterval = intervalSpy.mock.calls
      .filter(([, delay]) => delay === 60 * 1000)
      .at(-1);
    if (!revalidationInterval) throw new Error('Expected count revalidation interval');
    revalidationInterval[0]();

    expect(mocks.refreshCounts).toHaveBeenCalledOnce();
    expect(mocks.reloadQueue).not.toHaveBeenCalled();
  });

  it('only reloads the queue in the background when no card is focused', () => {
    mocks.hasTasks = false;
    const intervalSpy = vi.spyOn(window, 'setInterval');
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    const revalidationInterval = intervalSpy.mock.calls
      .filter(([, delay]) => delay === 60 * 1000)
      .at(-1);
    if (!revalidationInterval) throw new Error('Expected queue revalidation interval');
    revalidationInterval[0]();

    expect(mocks.reloadQueue).toHaveBeenCalledOnce();
    expect(mocks.refreshCounts).toHaveBeenCalledOnce();
  });

  it('snoozes skipped tasks for 30 minutes before dismissing them', async () => {
    const now = Date.now();
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ success: true })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { unmount } = render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip task' }));

    await waitFor(() => expect(mocks.dismiss).toHaveBeenCalledWith('task-1'));
    const patchCall = fetchMock.mock.calls.find(([url]) => url === '/api/tasks/task-1');
    if (!patchCall) throw new Error('Expected task snooze request');
    const body = JSON.parse(String(patchCall[1]?.body));
    const snoozedUntil = new Date(body.snoozedUntil).getTime();
    expect(snoozedUntil).toBeGreaterThanOrEqual(now + 30 * 60 * 1000);
    expect(snoozedUntil).toBeLessThanOrEqual(Date.now() + 30 * 60 * 1000);
    expect(mocks.refreshCounts).toHaveBeenCalledOnce();

    unmount();
  });

  it('keeps a task visible when snoozing it fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));
    render(<QuickSortMode />);

    fireEvent.click(screen.getByRole('button', { name: 'Open no-tags queue' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip task' }));

    await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Failed to skip task'));
    expect(mocks.dismiss).not.toHaveBeenCalled();
  });
});
