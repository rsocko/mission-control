import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DocIntelligencePage from '@/app/doc-intelligence/page';

vi.mock('@/lib/hooks/useHistoryParamSelection', async () => {
  const React = await import('react');
  return {
    useHistoryParamSelection: () => React.useState<string | null>(null),
  };
});

vi.mock('@/components/task-detail/TaskDetailPanel', () => ({
  TaskDetailPanel: ({
    taskId,
    mode,
    onClose,
    onModeChange,
  }: {
    taskId: string;
    mode: string;
    onClose: () => void;
    onModeChange: (mode: 'panel' | 'dialog' | 'workspace') => void;
  }) => (
    <div aria-label={`Mock task detail ${taskId}`}>
      <span>{mode}</span>
      <button type="button" onClick={() => onModeChange('workspace')}>Expand mock task</button>
      <button type="button" onClick={onClose}>Close mock task</button>
    </div>
  ),
}));

const tasks = [
  {
    id: 'task-1',
    title: 'Pay first invoice',
    description: null,
    status: 'todo',
    priority: 'high',
    dueDate: null,
    connectorType: 'document-intelligence',
    connectorInstanceId: 'owl',
    sourceId: 'owl:task-1',
    sourceUrl: null,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    metadata: { actionType: 'pay', urgency: 'high', correspondent: 'Acme' },
  },
  {
    id: 'task-2',
    title: 'Sign second document',
    description: null,
    status: 'todo',
    priority: 'medium',
    dueDate: null,
    connectorType: 'document-intelligence',
    connectorInstanceId: 'owl',
    sourceId: 'owl:task-2',
    sourceUrl: null,
    createdAt: '2026-10-02T12:00:00.000Z',
    updatedAt: '2026-10-02T12:00:00.000Z',
    metadata: { actionType: 'sign', urgency: 'medium', correspondent: 'Beta' },
  },
];

describe('Document Actions task detail lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/notifications')) {
        return new Response(JSON.stringify({ notifications: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks }), { status: 200 });
    }));
  });

  it('returns to panel mode after closing an expanded task before opening another', async () => {
    render(<DocIntelligencePage />);

    fireEvent.click(await screen.findByRole('button', { name: /Pay first invoice/ }));
    expect(screen.getByLabelText('Mock task detail task-1')).toHaveTextContent('panel');

    fireEvent.click(screen.getByRole('button', { name: 'Expand mock task' }));
    expect(screen.getByLabelText('Mock task detail task-1')).toHaveTextContent('workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Close mock task' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Mock task detail task-1')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sign second document/ }));
    expect(screen.getByLabelText('Mock task detail task-2')).toHaveTextContent('panel');
  });
});
