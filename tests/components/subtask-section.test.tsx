import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SubtaskSection } from '@/components/task-detail/SubtaskSection';
import { toast } from 'sonner';

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('SubtaskSection', () => {
  it('shows concise accessible reorder handles without a persistent ordering notice', () => {
    render(
      <SubtaskSection
        taskId="task-1"
        subtasks={[
          { id: 'subtask-1', title: 'First', status: 'todo' },
          { id: 'subtask-2', title: 'Second', status: 'todo' },
        ]}
        onSubtasksChange={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Reorder "First"' })).toHaveAttribute(
      'title',
      'Reorder subtask',
    );
    expect(screen.queryByText(/saved in Mission Control only/i)).not.toBeInTheDocument();
  });

  it('hides reorder controls when subtasks are read-only', () => {
    render(
      <SubtaskSection
        taskId="task-1"
        subtasks={[
          { id: 'subtask-1', title: 'First', status: 'todo' },
          { id: 'subtask-2', title: 'Second', status: 'todo' },
        ]}
        onSubtasksChange={vi.fn()}
        canEdit={false}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Reorder "First"' })).not.toBeInTheDocument();
  });

  it('completes a subtask without refreshing the parent view', async () => {
    const onSubtasksChange = vi.fn();
    const onUpdate = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SubtaskSection
        taskId="task-1"
        subtasks={[{ id: 'subtask-1', title: 'Ship the fix', status: 'todo' }]}
        onSubtasksChange={onSubtasksChange}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Ship the fix" complete' }));

    expect(onSubtasksChange).toHaveBeenCalledWith([
      { id: 'subtask-1', title: 'Ship the fix', status: 'done' },
    ]);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/tasks/subtask-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }));
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('reverts a failed completion without refreshing the parent view', async () => {
    const subtask = { id: 'subtask-1', title: 'Ship the fix', status: 'todo' };
    const onSubtasksChange = vi.fn();
    const onUpdate = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

    render(
      <SubtaskSection
        taskId="task-1"
        subtasks={[subtask]}
        onSubtasksChange={onSubtasksChange}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Mark "Ship the fix" complete' }));

    await waitFor(() => expect(onSubtasksChange).toHaveBeenLastCalledWith([subtask]));
    expect(onSubtasksChange).toHaveBeenNthCalledWith(1, [{ ...subtask, status: 'done' }]);
    expect(toast.error).toHaveBeenCalledWith('Failed to toggle subtask');
    expect(onUpdate).not.toHaveBeenCalled();
  });
});
