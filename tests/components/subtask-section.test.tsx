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
