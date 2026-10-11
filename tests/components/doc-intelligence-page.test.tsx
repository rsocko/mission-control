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
    documentFocusedLayout,
    onClose,
    onModeChange,
  }: {
    taskId: string;
    mode: string;
    documentFocusedLayout?: boolean;
    onClose: () => void;
    onModeChange: (mode: 'panel' | 'dialog' | 'workspace') => void;
  }) => (
    <div aria-label={`Mock task detail ${taskId}`}>
      <span>{mode}</span>
      <span>{documentFocusedLayout ? 'document-focused' : 'standard-layout'}</span>
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
    expect(screen.getByLabelText('Mock task detail task-1')).toHaveTextContent('document-focused');

    fireEvent.click(screen.getByRole('button', { name: 'Expand mock task' }));
    expect(screen.getByLabelText('Mock task detail task-1')).toHaveTextContent('workspace');

    fireEvent.click(screen.getByRole('button', { name: 'Close mock task' }));
    await waitFor(() => {
      expect(screen.queryByLabelText('Mock task detail task-1')).not.toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sign second document/ }));
    expect(screen.getByLabelText('Mock task detail task-2')).toHaveTextContent('panel');
  });

  it('loads every task and review-notification page', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/notifications')) {
        const cursor = new URL(url, 'http://localhost').searchParams.get('cursor');
        return new Response(JSON.stringify(cursor
          ? {
              notifications: [{
                id: 'review-2',
                title: 'Review second document',
                templateKey: 'owl_needs_review',
                metadata: { reviewUrl: 'https://owl.example/review/2' },
              }],
              hasMore: false,
              cursor: null,
            }
          : {
              notifications: [{
                id: 'review-1',
                title: 'Review first document',
                templateKey: 'owl_needs_review',
                metadata: { reviewUrl: 'https://owl.example/review/1' },
              }],
              hasMore: true,
              cursor: 'next-review-page',
            }), { status: 200 });
      }

      const offset = new URL(url, 'http://localhost').searchParams.get('offset');
      return new Response(JSON.stringify(offset === '1'
        ? { tasks: [tasks[1]], hasMore: false }
        : { tasks: [tasks[0]], hasMore: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DocIntelligencePage />);

    expect(await screen.findByRole('button', { name: /Pay first invoice/ })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Sign second document/ })).toBeInTheDocument();
    expect(await screen.findByText('2 items need review in OWL')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=0'), undefined);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('offset=1'), undefined);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('cursor=next-review-page'));
  });

  it('renders large result sets in bounded pages', async () => {
    const manyTasks = Array.from({ length: 101 }, (_, index) => ({
      ...tasks[0],
      id: `task-${index + 1}`,
      sourceId: `owl:task-${index + 1}`,
      title: `Document action ${index + 1}`,
    }));
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/notifications')) {
        return new Response(JSON.stringify({ notifications: [], hasMore: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: manyTasks, hasMore: false }), { status: 200 });
    }));

    render(<DocIntelligencePage />);

    expect(await screen.findAllByRole('button', { name: /Document action/ })).toHaveLength(100);
    expect(screen.getByText('1–100 of 101')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Document action/ })).toHaveLength(1);
    });
    expect(screen.getByText('101–101 of 101')).toBeInTheDocument();
  });

  it('syncs every enabled OWL connector before reloading actions and review alerts', async () => {
    let taskRequestCount = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/connectors') {
        return new Response(JSON.stringify({
          connectors: [
            { id: 'owl-1', type: 'document-intelligence', enabled: true },
            { id: 'owl-disabled', type: 'document-intelligence', enabled: false },
          ],
          sourceLists: [],
          classificationDefaults: {},
        }), { status: 200 });
      }
      if (url === '/api/sync') {
        expect(JSON.parse(String(init?.body))).toEqual({ connectorId: 'owl-1' });
        return new Response(JSON.stringify({ results: [{ connectorId: 'owl-1', success: true }] }), { status: 200 });
      }
      if (url.startsWith('/api/notifications')) {
        return new Response(JSON.stringify({ notifications: [], hasMore: false }), { status: 200 });
      }
      taskRequestCount += 1;
      return new Response(JSON.stringify({
        tasks: taskRequestCount === 1 ? [tasks[0]] : [tasks[1]],
        hasMore: false,
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DocIntelligencePage />);
    expect(await screen.findByRole('button', { name: /Pay first invoice/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync OWL document actions' }));

    expect(await screen.findByRole('button', { name: /Sign second document/ })).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/sync', expect.objectContaining({
      method: 'POST',
    }));
    expect(screen.queryByRole('button', { name: /Pay first invoice/ })).not.toBeInTheDocument();
  });

  it('keeps existing actions visible and explains a failed OWL sync', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/connectors') {
        return new Response(JSON.stringify({
          connectors: [{ id: 'owl-1', type: 'document-intelligence', enabled: true }],
          sourceLists: [],
          classificationDefaults: {},
        }), { status: 200 });
      }
      if (url === '/api/sync') {
        return new Response(JSON.stringify({
          results: [{ connectorId: 'owl-1', success: false, errors: ['OWL is unavailable'] }],
        }), { status: 200 });
      }
      if (url.startsWith('/api/notifications')) {
        return new Response(JSON.stringify({ notifications: [], hasMore: false }), { status: 200 });
      }
      return new Response(JSON.stringify({ tasks: [tasks[0]], hasMore: false }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<DocIntelligencePage />);
    expect(await screen.findByRole('button', { name: /Pay first invoice/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Sync OWL document actions' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'OWL sync failed: OWL is unavailable. Displayed document actions were not reloaded.',
    );
    expect(screen.getByRole('button', { name: /Pay first invoice/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sync OWL document actions' })).toBeEnabled();
  });

  it('does not render tasks explicitly marked as non-ready', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/notifications')) {
        return new Response(JSON.stringify({ notifications: [], hasMore: false }), { status: 200 });
      }
      return new Response(JSON.stringify({
        tasks: [
          tasks[0],
          {
            ...tasks[1],
            metadata: {
              actionType: 'sign',
              urgency: 'medium',
              actionReady: false,
            },
          },
        ],
        hasMore: false,
      }), { status: 200 });
    }));

    render(<DocIntelligencePage />);

    expect(await screen.findByRole('button', { name: /Pay first invoice/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign second document/ })).not.toBeInTheDocument();
  });
});
