import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DuplicateTaskPreview } from '@/components/task-detail/DuplicateTaskPreview';

const candidate = {
  id: 'duplicate-1',
  title: 'Create task_dependencies schema table',
  status: 'todo',
  sourceId: 'owner/repo:42',
  connectorType: 'github-issues',
  score: 1,
  reasoning: 'Exact title match - almost certainly a duplicate.',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DuplicateTaskPreview', () => {
  it('loads and displays read-only task context when previewed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        task: {
          ...candidate,
          description: 'Create the join table and migration.',
          priority: 'high',
          dueDate: '2026-08-02',
          sourceListName: 'Mission Control',
          sourceUrl: 'https://github.com/owner/repo/issues/42',
        },
      }),
    }));

    render(<DuplicateTaskPreview candidate={candidate} />);
    fireEvent.mouseEnter(screen.getByRole('button', { name: /create task_dependencies/i }).parentElement!);

    expect(await screen.findByText('Create the join table and migration.')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText(/Aug 2/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /open in github/i })).toHaveAttribute(
      'href',
      'https://github.com/owner/repo/issues/42',
    );
    expect(screen.getByRole('link', { name: 'Permalink' })).toHaveAttribute(
      'href',
      '/?taskId=duplicate-1',
    );
  });

  it('opens the duplicate in the current task detail view', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { ...candidate, description: null, priority: 'none', dueDate: null, sourceListName: null, sourceUrl: null } }),
    }));
    const listener = vi.fn((event: Event) => event.preventDefault());
    window.addEventListener('mc:select-task', listener);

    render(<DuplicateTaskPreview candidate={candidate} />);
    fireEvent.click(screen.getByRole('button', { name: /create task_dependencies/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open task' }));

    await waitFor(() => expect(listener).toHaveBeenCalledOnce());
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ taskId: 'duplicate-1' });
    expect((listener.mock.calls[0][0] as CustomEvent).defaultPrevented).toBe(true);
    window.removeEventListener('mc:select-task', listener);
  });

  it('closes only the preview when Escape is pressed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { ...candidate, description: null, priority: 'none', dueDate: null, sourceListName: null, sourceUrl: null } }),
    }));
    const parentKeyDown = vi.fn();

    render(
      <div onKeyDown={parentKeyDown}>
        <DuplicateTaskPreview candidate={candidate} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: /create task_dependencies/i }));
    const preview = await screen.findByRole('dialog');
    fireEvent.keyDown(preview, { key: 'Escape' });

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(parentKeyDown).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /create task_dependencies/i })).toHaveFocus();
  });

  it('moves focus into the preview when opened from the keyboard', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task: { ...candidate, description: null, priority: 'none', dueDate: null, sourceListName: null, sourceUrl: null } }),
    }));

    render(<DuplicateTaskPreview candidate={candidate} />);
    const trigger = screen.getByRole('button', { name: /create task_dependencies/i });
    trigger.focus();
    fireEvent.click(trigger, { detail: 0 });

    await waitFor(() => expect(screen.getByRole('button', { name: 'Open task' })).toHaveFocus());
  });

  it('shows a load error and retries the next time it opens', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          task: {
            ...candidate,
            description: 'Loaded after retry.',
            priority: 'none',
            dueDate: null,
            sourceListName: null,
            sourceUrl: null,
          },
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    render(<DuplicateTaskPreview candidate={candidate} />);
    const trigger = screen.getByRole('button', { name: /create task_dependencies/i });
    fireEvent.click(trigger);
    expect(await screen.findByText('Task details could not be loaded.')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(trigger);

    expect(await screen.findByText('Loaded after retry.')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
