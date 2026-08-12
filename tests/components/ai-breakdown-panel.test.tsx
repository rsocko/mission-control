import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AiBreakdownPanel } from '@/components/task-detail/AiBreakdownPanel';
import { SubtaskSection } from '@/components/task-detail/SubtaskSection';

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AiBreakdownPanel', () => {
  it('hides creation controls when the connector does not support subtasks', () => {
    render(
      <SubtaskSection
        taskId="task-1"
        subtasks={[]}
        onSubtasksChange={vi.fn()}
        canEdit
        canCreateSubtasks={false}
      />,
    );

    expect(screen.queryByPlaceholderText('Add subtask…')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'AI breakdown' })).not.toBeInTheDocument();
  });

  it('dismisses proposals without persistence and accepts one through the subtask route', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        contextVersion: 'a'.repeat(64),
        proposals: [
          { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'Write tests', description: 'Cover failures.', effort: 2 },
          { id: 'e86bf658-c528-456b-84b5-f1fa01bc1760', title: 'Update docs', description: '', effort: 1 },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        subtask: { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'Write tests', status: 'todo', effort: 2 },
        contextVersion: 'b'.repeat(64),
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onAccepted = vi.fn();

    render(<AiBreakdownPanel taskId="task-1" onAccepted={onAccepted} onClose={vi.fn()} />);
    expect(await screen.findByText('Write tests')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss Update docs' }));
    expect(screen.queryByText('Update docs')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Accept Write tests' }));
    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith([
      { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'Write tests', status: 'todo', effort: 2 },
    ]));

    expect(fetchMock.mock.calls[1][0]).toBe('/api/tasks/task-1/subtasks');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      title: 'Write tests',
      effort: 2,
      proposalId: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898',
      expectedContextVersion: 'a'.repeat(64),
    });
  });

  it('keeps unaccepted proposals and reports a stale-task error during accept all', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        contextVersion: 'a'.repeat(64),
        proposals: [
          { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', description: '', effort: 1 },
          { id: 'e86bf658-c528-456b-84b5-f1fa01bc1760', title: 'Second step', description: '', effort: 2 },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        subtask: { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', status: 'todo', effort: 1 },
        contextVersion: 'b'.repeat(64),
      }))
      .mockResolvedValueOnce(jsonResponse({
        error: 'This task changed after the breakdown was generated. Generate a fresh breakdown.',
      }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const onAccepted = vi.fn();

    render(<AiBreakdownPanel taskId="task-1" onAccepted={onAccepted} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This task changed');
    expect(onAccepted).toHaveBeenCalledWith([
      { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', status: 'todo', effort: 1 },
    ]);
    expect(screen.queryByText('First step')).not.toBeInTheDocument();
    expect(screen.getByText('Second step')).toBeInTheDocument();
  });

  it('chains refreshed context versions while accepting all proposals', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        contextVersion: 'a'.repeat(64),
        proposals: [
          { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', description: '', effort: 1 },
          { id: 'e86bf658-c528-456b-84b5-f1fa01bc1760', title: 'Second step', description: '', effort: 2 },
        ],
      }))
      .mockResolvedValueOnce(jsonResponse({
        subtask: { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', status: 'todo', effort: 1 },
        contextVersion: 'b'.repeat(64),
      }))
      .mockResolvedValueOnce(jsonResponse({
        subtask: { id: 'e86bf658-c528-456b-84b5-f1fa01bc1760', title: 'Second step', status: 'todo', effort: 2 },
        contextVersion: 'c'.repeat(64),
      }));
    vi.stubGlobal('fetch', fetchMock);
    const onAccepted = vi.fn();

    render(<AiBreakdownPanel taskId="task-1" onAccepted={onAccepted} onClose={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept all' }));

    await waitFor(() => expect(onAccepted).toHaveBeenCalledWith([
      { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'First step', status: 'todo', effort: 1 },
      { id: 'e86bf658-c528-456b-84b5-f1fa01bc1760', title: 'Second step', status: 'todo', effort: 2 },
    ]));
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual(expect.objectContaining({
      expectedContextVersion: 'b'.repeat(64),
    }));
    expect(screen.getByText('All suggestions handled.')).toBeInTheDocument();
  });

  it('shows generation failures and supports retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'AI provider is not configured' }, 503))
      .mockResolvedValueOnce(jsonResponse({
        contextVersion: 'a'.repeat(64),
        proposals: [
          { id: '3d188f4c-7eca-4d17-8cbe-601cc9d6a898', title: 'Recovered step', description: '', effort: null },
        ],
      }));
    vi.stubGlobal('fetch', fetchMock);

    render(<AiBreakdownPanel taskId="task-1" onAccepted={vi.fn()} onClose={vi.fn()} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('AI provider is not configured');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Recovered step')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
