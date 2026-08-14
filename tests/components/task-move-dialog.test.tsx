import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskMoveDialog } from '@/components/task-detail/TaskMoveDialog';
import { ApiRequestError } from '@/lib/api/tasks';

const mockPreviewTaskMove = vi.hoisted(() => vi.fn());
const mockExecuteTaskMove = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api/tasks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/tasks')>();
  return {
    ...actual,
    previewTaskMove: mockPreviewTaskMove,
    executeTaskMove: mockExecuteTaskMove,
  };
});

describe('TaskMoveDialog errors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreviewTaskMove.mockResolvedValue({
      task: {
        id: 'task-1',
        title: 'Private task title',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListId: 'inbox',
      },
      targetConnector: {
        id: 'inst-2',
        type: 'microsoft-todo',
        name: 'Microsoft To Do',
      },
      targetLists: [{ id: 'list-row-1', name: 'Tasks', sourceId: 'list-1' }],
      fieldMappings: [],
      subtasks: null,
      hasLossyFields: false,
      isNativeTransfer: false,
      nativeTransferNote: null,
      sourceActions: [{
        action: 'move',
        label: 'Move',
        description: 'Delete the original after creating the destination.',
      }],
      suggestion: null,
    });
    mockExecuteTaskMove.mockRejectedValue(new ApiRequestError(
      'Server detail that must stay hidden',
      500,
      'INTERNAL_ERROR',
      'd1a109ab',
    ));
  });

  it('shows a generic move error with a compact trace reference', async () => {
    render(
      <TaskMoveDialog
        taskId="task-1"
        taskTitle="Private task title"
        sourceConnectorType="local"
        writableConnectors={[{
          id: 'inst-2',
          type: 'microsoft-todo',
          name: 'Microsoft To Do',
        }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Microsoft To Do/i }));
    await screen.findByRole('button', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(mockPreviewTaskMove).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Review field mapping/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Move Task/i }));

    expect(await screen.findByText(/Move failed\. Please try again\./i)).toBeInTheDocument();
    expect(screen.getByText('d1a109ab')).toBeInTheDocument();
    expect(screen.queryByText(/Server detail that must stay hidden/i)).not.toBeInTheDocument();
  });

  it('disables the current source as a destination', async () => {
    mockPreviewTaskMove.mockResolvedValueOnce({
      task: {
        id: 'task-1',
        title: 'GitHub issue',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-1',
        sourceListId: 'rsocko/mission-control',
      },
      targetConnector: {
        id: 'github-1',
        type: 'github-issues',
        name: 'GitHub',
      },
      targetLists: [
        { id: 'current-repo', name: 'rsocko/mission-control', sourceId: 'rsocko/mission-control' },
        { id: 'other-repo', name: 'rsocko/other', sourceId: 'rsocko/other' },
      ],
      fieldMappings: [],
      subtasks: null,
      hasLossyFields: false,
      isNativeTransfer: false,
      nativeTransferNote: null,
      sourceActions: [],
      suggestion: null,
    });

    render(
      <TaskMoveDialog
        taskId="task-1"
        taskTitle="GitHub issue"
        sourceConnectorType="github-issues"
        writableConnectors={[{
          id: 'github-1',
          type: 'github-issues',
          name: 'GitHub',
        }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /GitHub/i }));

    expect(await screen.findByRole('button', {
      name: /rsocko\/mission-control Current source/i,
    })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'rsocko/other' })).toBeEnabled();
    expect(mockPreviewTaskMove).toHaveBeenCalledTimes(1);
  });

  it('explains a same-source conflict returned during execution', async () => {
    mockExecuteTaskMove.mockRejectedValueOnce(new ApiRequestError(
      'This task is already in the selected destination',
      409,
      'SAME_SOURCE_DESTINATION',
    ));

    render(
      <TaskMoveDialog
        taskId="task-1"
        taskTitle="Private task title"
        sourceConnectorType="local"
        writableConnectors={[{
          id: 'inst-2',
          type: 'microsoft-todo',
          name: 'Microsoft To Do',
        }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Microsoft To Do/i }));
    await screen.findByRole('button', { name: 'Tasks' });
    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }));
    await waitFor(() => expect(mockPreviewTaskMove).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: /Review field mapping/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Continue/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Move Task/i }));

    expect(await screen.findByText(
      /This task is already in that destination\. Choose a different source\./i,
    )).toBeInTheDocument();
  });

  it('normalizes a legacy Document Intelligence instance name to OWL', () => {
    render(
      <TaskMoveDialog
        taskId="task-1"
        taskTitle="Private task title"
        sourceConnectorType="local"
        writableConnectors={[{
          id: 'owl-1',
          type: 'document-intelligence',
          name: 'Document Intelligence',
        }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'OWL' })).toBeInTheDocument();
    expect(screen.queryByText('Document Intelligence')).not.toBeInTheDocument();
  });

  it('uses a single scroll region for connectors and destination lists', async () => {
    mockPreviewTaskMove.mockResolvedValueOnce({
      task: {
        id: 'task-1',
        title: 'Private task title',
        connectorType: 'local',
        connectorInstanceId: 'local',
      },
      targetConnector: {
        id: 'inst-2',
        type: 'microsoft-todo',
        name: 'Microsoft To Do',
      },
      targetLists: Array.from({ length: 8 }, (_, index) => ({
        id: `list-row-${index}`,
        name: `List ${index}`,
        sourceId: `list-${index}`,
      })),
      fieldMappings: [],
      subtasks: null,
      hasLossyFields: false,
      isNativeTransfer: false,
      nativeTransferNote: null,
      sourceActions: [{
        action: 'move',
        label: 'Move',
        description: 'Delete the original after creating the destination.',
      }],
      suggestion: null,
    });

    const { container } = render(
      <TaskMoveDialog
        taskId="task-1"
        taskTitle="Private task title"
        sourceConnectorType="local"
        writableConnectors={[{
          id: 'inst-2',
          type: 'microsoft-todo',
          name: 'Microsoft To Do',
        }]}
        onClose={vi.fn()}
        onSuccess={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /Microsoft To Do/i }));
    await screen.findByRole('button', { name: 'List 7' });

    expect(container.querySelectorAll('.overflow-y-auto')).toHaveLength(1);
    expect(container.querySelector('.overflow-y-auto .overflow-y-auto')).not.toBeInTheDocument();
  });
});
