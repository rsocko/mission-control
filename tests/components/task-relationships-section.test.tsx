import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskRelationshipsSection } from '@/components/task-detail/TaskRelationshipsSection';
import type { TaskRelationship } from '@/lib/task-relationships-types';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({
    open,
    message,
    confirmLabel,
    onConfirm,
  }: {
    open: boolean;
    message: string;
    confirmLabel: string;
    onConfirm: () => void;
  }) => open ? (
    <div role="alertdialog">
      <p>{message}</p>
      <button onClick={onConfirm}>{confirmLabel}</button>
    </div>
  ) : null,
}));

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function relationship(
  overrides: {
    id: string;
    direction: TaskRelationship['direction'];
    syncStatus?: TaskRelationship['edge']['syncStatus'];
    syncAction?: TaskRelationship['edge']['syncAction'];
    syncError?: TaskRelationship['edge']['syncError'];
    task?: TaskRelationship['task'];
  },
): TaskRelationship {
  const otherTaskId = overrides.task?.id ?? `other-${overrides.id}`;
  const type = overrides.direction === 'related' ? 'related' : 'blocks';
  return {
    edge: {
      id: `dependency:${overrides.id}`,
      source: overrides.direction === 'incoming' ? `task:${otherTaskId}` : 'task:task-1',
      target: overrides.direction === 'incoming' ? 'task:task-1' : `task:${otherTaskId}`,
      type,
      provenance: 'explicit',
      syncStatus: overrides.syncStatus ?? 'synced',
      syncAction: overrides.syncAction ?? null,
      syncError: overrides.syncError ?? null,
      lastSyncedAt: '2026-07-31T12:00:00.000Z',
    },
    direction: overrides.direction,
    task: overrides.task ?? {
      id: `other-${overrides.id}`,
      title: `${overrides.direction} task`,
      status: 'todo',
      projectIds: ['project-a', 'project-b'],
      projectNames: ['Alpha', 'Beta'],
    },
  };
}

describe('TaskRelationshipsSection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders unmistakable blocking direction, symmetric related links, and sync errors', async () => {
    const relationships = [
      relationship({ id: 'incoming', direction: 'incoming' }),
      relationship({
        id: 'outgoing',
        direction: 'outgoing',
        syncStatus: 'local',
        task: {
          id: 'github-task',
          title: 'outgoing task',
          status: 'todo',
          connectorType: 'github-issues',
          sourceId: 'owner/repo:123',
          projectIds: [],
          projectNames: [],
        },
      }),
      relationship({
        id: 'related',
        direction: 'related',
        syncStatus: 'failed',
        syncAction: 'create',
        syncError: 'GitHub denied the relationship',
      }),
    ];
    global.fetch = vi.fn().mockResolvedValue(jsonResponse({ relationships }));

    render(<TaskRelationshipsSection taskId="task-1" />);

    const blockedBy = await screen.findByRole('list', { name: 'Blocked by' });
    expect(within(blockedBy).getByText('incoming task')).toBeInTheDocument();
    expect(within(blockedBy).getByRole('img', { name: 'Blocked by' })).toBeInTheDocument();
    const blocks = screen.getByRole('list', { name: 'Blocks' });
    expect(within(blocks).getByText('outgoing task')).toBeInTheDocument();
    expect(within(blocks).getByText('#123')).toBeInTheDocument();
    expect(within(blocks).getByRole('img', { name: 'Blocks' })).toBeInTheDocument();
    expect(within(blocks).getByText('Local only')).toBeInTheDocument();
    const related = screen.getByRole('list', { name: 'Related' });
    expect(within(related).getByText('related task')).toBeInTheDocument();
    expect(within(related).getByRole('img', { name: 'Related' })).toBeInTheDocument();
    expect(within(related).getByText('GitHub denied the relationship')).toHaveAttribute(
      'role',
      'status',
    );
    expect(within(related).getByText('Alpha, Beta')).toBeInTheDocument();
  });

  it('searches globally and creates an incoming blocking relationship by keyboard-accessible controls', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('relationship-candidates')) {
        return jsonResponse({
          candidates: [{
            id: 'task-2',
            title: 'Cross-project blocker',
            status: 'todo',
            connectorType: 'github-issues',
            sourceId: 'owner/repo:456',
            sourceListName: null,
            projectIds: ['project-b'],
            projectNames: ['Beta'],
          }],
        });
      }
      if (init?.method === 'POST') {
        return jsonResponse({ dependency: { id: 'relationship-1', syncStatus: 'synced' } }, 201);
      }
      return jsonResponse({ relationships: [] });
    });
    global.fetch = fetchMock as typeof fetch;

    render(<TaskRelationshipsSection taskId="task-1" />);
    await screen.findByText('No task relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.keyDown(screen.getByLabelText('Find a task across all projects'), { key: 'Escape' });
    expect(screen.queryByLabelText('Find a task across all projects')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add' })).toHaveFocus());
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByLabelText('Direction'));
    fireEvent.click(screen.getByRole('option', { name: 'This task is blocked by...' }));
    const candidate = await screen.findByRole('button', {
      name: 'Add relationship with Cross-project blocker',
    });
    expect(within(candidate).getByText('#456')).toBeInTheDocument();
    fireEvent.click(candidate);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/task-1/relationships',
      expect.objectContaining({ method: 'POST' }),
    ));
    const postCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(postCall?.[1]?.body))).toEqual({
      relatedTaskId: 'task-2',
      type: 'blocks',
      direction: 'incoming',
    });
    expect(screen.queryByLabelText('Direction')).not.toBeInTheDocument();
  });

  it('confirms deletion and keeps the failed relationship visible when source removal fails', async () => {
    const existing = relationship({ id: 'relationship-1', direction: 'outgoing' });
    let relationshipLoads = 0;
    global.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ error: 'GitHub rejected dependency removal' }, 502);
      }
      relationshipLoads++;
      return jsonResponse({ relationships: [existing] });
    }) as typeof fetch;

    render(<TaskRelationshipsSection taskId="task-1" />);
    await screen.findByText('outgoing task');
    fireEvent.click(screen.getByRole('button', {
      name: 'Remove relationship with outgoing task',
    }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'Connector-backed relationships will also be removed from their source',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'GitHub rejected dependency removal',
    );
    expect(screen.getByText('outgoing task')).toBeInTheDocument();
    expect(relationshipLoads).toBeGreaterThan(1);
  });

  it('reloads relationships after an ambiguous failed add response', async () => {
    const recovered = relationship({ id: 'recovered', direction: 'related' });
    let relationshipLoads = 0;
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('relationship-candidates')) {
        return jsonResponse({
          candidates: [{
            id: recovered.task.id,
            title: recovered.task.title,
            status: 'todo',
            connectorType: 'local',
            sourceListName: null,
            projectIds: [],
            projectNames: [],
          }],
        });
      }
      if (init?.method === 'POST') return jsonResponse({ error: 'Response lost' }, 502);
      relationshipLoads++;
      return jsonResponse({ relationships: relationshipLoads > 1 ? [recovered] : [] });
    }) as typeof fetch;

    render(<TaskRelationshipsSection taskId="task-1" />);
    await screen.findByText('No task relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', {
      name: `Add relationship with ${recovered.task.title}`,
    }));

    expect(await screen.findByText(recovered.task.title)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Response lost');
    expect(relationshipLoads).toBeGreaterThan(1);
  });

  it('ignores stale relationship responses after switching tasks', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    global.fetch = vi.fn((input: RequestInfo | URL) => {
      if (String(input).includes('/task-1/')) return first;
      return Promise.resolve(jsonResponse({
        relationships: [relationship({
          id: 'fresh',
          direction: 'related',
          task: {
            id: 'fresh-task',
            title: 'Fresh relationship',
            status: 'todo',
            projectIds: [],
            projectNames: [],
          },
        })],
      }));
    }) as typeof fetch;

    const { rerender } = render(<TaskRelationshipsSection taskId="task-1" />);
    rerender(<TaskRelationshipsSection taskId="task-2" />);
    expect(await screen.findByText('Fresh relationship')).toBeInTheDocument();
    resolveFirst?.(jsonResponse({
      relationships: [relationship({
        id: 'stale',
        direction: 'related',
        task: {
          id: 'stale-task',
          title: 'Stale relationship',
          status: 'todo',
          projectIds: [],
          projectNames: [],
        },
      })],
    }));

    await waitFor(() => expect(screen.queryByText('Stale relationship')).not.toBeInTheDocument());
    expect(screen.getByText('Fresh relationship')).toBeInTheDocument();
  });

  it('ignores a stale add completion after switching tasks', async () => {
    let resolveAdd: ((response: Response) => void) | undefined;
    const addResponse = new Promise<Response>((resolve) => {
      resolveAdd = resolve;
    });
    const onUpdate = vi.fn();
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'POST') return addResponse;
      if (url.includes('relationship-candidates')) {
        return Promise.resolve(jsonResponse({
          candidates: url.includes('/task-1/')
            ? [{
                id: 'candidate',
                title: 'Candidate task',
                status: 'todo',
                connectorType: 'local',
                sourceListName: null,
                projectIds: [],
                projectNames: [],
              }]
            : [],
        }));
      }
      return Promise.resolve(jsonResponse({
        relationships: url.includes('/task-2/')
          ? [relationship({ id: 'fresh', direction: 'related' })]
          : [],
      }));
    }) as typeof fetch;

    const { rerender } = render(
      <TaskRelationshipsSection key="task-1" taskId="task-1" onUpdate={onUpdate} />,
    );
    await screen.findByText('No task relationships');
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(await screen.findByRole('button', {
      name: 'Add relationship with Candidate task',
    }));

    rerender(
      <TaskRelationshipsSection key="task-2" taskId="task-2" onUpdate={onUpdate} />,
    );
    expect(await screen.findByText('related task')).toBeInTheDocument();
    expect(screen.queryByLabelText('Find a task across all projects')).not.toBeInTheDocument();

    resolveAdd?.(jsonResponse({ dependency: { syncStatus: 'synced' } }, 201));
    await waitFor(() => expect(onUpdate).not.toHaveBeenCalled());
    expect(screen.getByText('related task')).toBeInTheDocument();
  });

  it('dismisses stale removal state when switching tasks', async () => {
    let resolveDelete: ((response: Response) => void) | undefined;
    const deleteResponse = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    const onUpdate = vi.fn();
    global.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'DELETE') return deleteResponse;
      return Promise.resolve(jsonResponse({
        relationships: url.includes('/task-1/')
          ? [relationship({ id: 'old', direction: 'outgoing' })]
          : [relationship({ id: 'fresh', direction: 'related' })],
      }));
    }) as typeof fetch;

    const { rerender } = render(
      <TaskRelationshipsSection key="task-1" taskId="task-1" onUpdate={onUpdate} />,
    );
    await screen.findByText('outgoing task');
    fireEvent.click(screen.getByRole('button', { name: 'Remove relationship with outgoing task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    rerender(
      <TaskRelationshipsSection key="task-2" taskId="task-2" onUpdate={onUpdate} />,
    );
    expect(await screen.findByText('related task')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();

    resolveDelete?.(jsonResponse({ success: true }));
    await waitFor(() => expect(onUpdate).not.toHaveBeenCalled());
    expect(screen.getByText('related task')).toBeInTheDocument();
  });

  it('shows load errors and retries without closing Task Details', async () => {
    let attempts = 0;
    global.fetch = vi.fn(async () => {
      attempts++;
      return attempts === 1
        ? jsonResponse({ error: 'Relationship service unavailable' }, 503)
        : jsonResponse({ relationships: [] });
    }) as typeof fetch;

    render(<TaskRelationshipsSection taskId="task-1" touch />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Relationship service unavailable',
    );
    const retry = screen.getByRole('button', { name: 'Retry' });
    expect(retry).toHaveClass('min-h-11');
    fireEvent.click(retry);
    expect(await screen.findByText('No task relationships')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });
});
