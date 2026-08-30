import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BulkMoveToSourceButton } from '@/components/bulk-actions/BulkMoveToSourceButton';

const mockPreviewTaskMove = vi.hoisted(() => vi.fn());
const mockExecuteTaskMove = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/tasks', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/api/tasks')>(),
  previewTaskMove: mockPreviewTaskMove,
  executeTaskMove: mockExecuteTaskMove,
}));

describe('BulkMoveToSourceButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses a single scroll region for connectors and destination lists', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        json: async () => ({
          connectors: [{
            id: 'inst-2',
            type: 'microsoft-todo',
            name: 'Microsoft To Do',
            capabilities: { taskCreate: true },
          }],
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          sourceLists: Array.from({ length: 8 }, (_, index) => ({
            id: `list-row-${index}`,
            name: `List ${index}`,
            sourceId: `list-${index}`,
          })),
        }),
      });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(
      <BulkMoveToSourceButton
        selectedTaskIds={['task-1']}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Move to source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Microsoft To Do/i }));
    await screen.findByRole('button', { name: 'List 7' });

    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
    expect(container.querySelector('.overflow-y-auto .overflow-y-auto')).not.toBeInTheDocument();
  });

  it('previews every selected task before showing review and confirmation steps', async () => {
    vi.stubGlobal('fetch', createDestinationFetch());
    mockPreviewTaskMove.mockImplementation(async ({ taskId }: { taskId: string }) => ({
      task: {
        id: taskId,
        title: `Task ${taskId}`,
        connectorType: 'local',
        connectorInstanceId: 'local',
      },
      targetConnector: {
        id: 'inst-2',
        type: 'microsoft-todo',
        name: 'Microsoft To Do',
      },
      targetLists: [{ id: 'list-row-1', name: 'Tasks', sourceId: 'list-1' }],
      fieldMappings: [
        {
          field: 'title',
          status: 'mapped',
          sourceValue: `Task ${taskId}`,
          targetValue: `Task ${taskId}`,
        },
        {
          field: 'planningHorizon',
          status: 'converted',
          sourceValue: 'soon',
          targetValue: '(kept in Mission Control)',
          warning: 'planning horizon is preserved locally on the destination task.',
        },
      ],
      subtasks: taskId === 'task-1'
        ? { count: 2, strategy: 'move-as-subtasks' }
        : null,
      hasLossyFields: false,
      isNativeTransfer: false,
      nativeTransferNote: null,
      sourceActions: [{
        action: 'move',
        label: 'Move',
        description: 'Create in target, then delete from source.',
      }],
      suggestion: null,
    }));

    render(
      <BulkMoveToSourceButton
        selectedTaskIds={['task-1', 'task-2']}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Move to source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Microsoft To Do/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(mockPreviewTaskMove).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole('button', { name: /Review migration details/i }));

    expect(screen.getByText(/Combined migration preview for 2 selected tasks/i)).toBeInTheDocument();
    expect(screen.getByText(/Projects, schedules, reminders, dependencies, linked sources/i)).toBeInTheDocument();
    expect(screen.getByText(/2 subtasks will also be preserved/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));

    expect(screen.getByText(/What happens to the originals/i)).toBeInTheDocument();
    expect(screen.getByText(/created and saved before its original is removed or closed/i)).toBeInTheDocument();
  });

  it('uses each task preview strategy when executing the confirmed bulk move', async () => {
    vi.stubGlobal('fetch', createDestinationFetch());
    mockPreviewTaskMove.mockImplementation(async ({ taskId }: { taskId: string }) => ({
      task: { id: taskId, title: taskId, connectorType: 'local', connectorInstanceId: 'local' },
      targetConnector: { id: 'inst-2', type: 'microsoft-todo', name: 'Microsoft To Do' },
      targetLists: [{ id: 'list-row-1', name: 'Tasks', sourceId: 'list-1' }],
      fieldMappings: [],
      subtasks: {
        count: 1,
        strategy: taskId === 'task-1' ? 'move-as-subtasks' : 'preserve-details-and-steps',
      },
      hasLossyFields: false,
      isNativeTransfer: false,
      nativeTransferNote: null,
      sourceActions: [{
        action: 'move',
        label: 'Move',
        description: 'Create in target, then delete from source.',
      }],
      suggestion: null,
    }));
    mockExecuteTaskMove.mockResolvedValue({
      newTaskId: 'new-task',
      newSourceId: 'new-source',
      sourceAction: 'move',
      subtasksMoved: 1,
      warnings: [],
    });

    render(
      <BulkMoveToSourceButton
        selectedTaskIds={['task-1', 'task-2']}
        onComplete={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Move to source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Microsoft To Do/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(mockPreviewTaskMove).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Review migration details/i }));
    fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
    fireEvent.click(screen.getByRole('button', { name: /Move 2 tasks/i }));

    await waitFor(() => expect(mockExecuteTaskMove).toHaveBeenCalledTimes(2));
    expect(mockExecuteTaskMove).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ taskId: 'task-1', subtaskStrategy: 'move-as-subtasks' }),
    );
    expect(mockExecuteTaskMove).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ taskId: 'task-2', subtaskStrategy: 'preserve-details-and-steps' }),
    );
  });
});

function createDestinationFetch() {
  return vi.fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        connectors: [{
          id: 'inst-2',
          type: 'microsoft-todo',
          name: 'Microsoft To Do',
          capabilities: { taskCreate: true },
        }],
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        sourceLists: [{ id: 'list-row-1', name: 'Tasks', sourceId: 'list-1' }],
      }),
    });
}
