import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDelegationSection } from '@/components/task-detail/TaskDelegationSection';
import { TaskDelegationDialog } from '@/components/task-delegation/TaskDelegationDialog';
import {
  openTaskDelegation,
  TASK_DELEGATION_OPEN_EVENT,
} from '@/components/task-delegation/events';
import { TASKS_REFRESH_REQUESTED_EVENT } from '@/lib/tasks/task-refresh-events';
import { toast } from '@/lib/toast';
import type {
  TaskDelegationContext,
  TaskDelegationSummary,
} from '@/lib/external-agents/task-delegation';

vi.mock('@/lib/toast', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function response(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function assignment(
  overrides: Partial<TaskDelegationSummary> = {},
): TaskDelegationSummary {
  return {
    dispatchId: 'dispatch-1',
    targetId: 'github-cloud',
    targetName: 'GitHub Cloud',
    targetType: 'copilot-cloud',
    companyId: null,
    responsibleAgent: null,
    responsibleAgentId: null,
    issueIdentifier: null,
    issueUrl: null,
    runId: null,
    runUrl: null,
    providerTaskId: 'agent-task-1',
    locality: 'github-hosted',
    canonicalState: 'in_progress',
    displayState: 'running',
    latestProgress: 'Running focused reconciliation tests.',
    blocker: null,
    pendingApproval: false,
    repository: 'octo/repo',
    baseRef: 'main',
    model: 'auto',
    createPullRequest: true,
    attemptCount: 1,
    maxAttempts: 3,
    branchRef: 'copilot/reconciliation',
    pullRequestUrl: null,
    commitSha: null,
    checks: [],
    artifacts: [],
    disclosedFields: ['tasks.title'],
    allowedActions: ['write_code', 'create_pull_request'],
    errorMessage: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    canCancel: false,
    canStopTracking: true,
    canRetry: false,
    cancellationLimitation: 'GitHub Agent Tasks does not expose cancellation. Mission Control can stop tracking, but provider work may continue.',
    ...overrides,
  };
}

function context(
  assignments: Array<TaskDelegationSummary & { taskId: string }>,
): TaskDelegationContext {
  return {
    taskIds: ['task-1'],
    tasks: [{ id: 'task-1', title: 'Fix parser', connectorType: 'github-issues' }],
    targets: [],
    assignments,
    syncErrors: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TaskDelegationSection', () => {
  it('keeps the empty state compact and opens the shared delegation wizard', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response(context([]))));
    const opened = vi.fn();
    window.addEventListener(TASK_DELEGATION_OPEN_EVENT, opened);

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="panel" />);

    expect(await screen.findByText(/No destination is assigned/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delegate' }));
    expect(opened).toHaveBeenCalledOnce();
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({
      taskIds: ['task-1'],
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    window.removeEventListener(TASK_DELEGATION_OPEN_EVENT, opened);
  });

  it('shows compact progress and truthful GitHub stop-tracking details', async () => {
    const current = assignment();
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tasks/task-1/delegation')) {
        return response(context([{ taskId: 'task-1', ...current }]));
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1') && !init?.method) {
        return response({
          dispatch: {
            id: 'dispatch-1',
            providerTaskId: 'agent-task-1',
            providerDetail: null,
            attempts: [{
              id: 'attempt-1',
              attemptNumber: 1,
              status: 'in_progress',
              startedAt: '2026-10-01T00:00:00.000Z',
              completedAt: null,
              errorMessage: null,
            }],
            events: [{
              id: 1,
              eventType: 'provider_started',
              detail: {},
              createdAt: '2026-10-01T00:00:00.000Z',
            }],
          },
        });
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1') && init?.method === 'PATCH') {
        return response({ stoppedTracking: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="dialog" />);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('· GitHub Cloud')).toBeInTheDocument();
    expect(screen.getByText('Running focused reconciliation tests.')).toBeInTheDocument();
    expect(screen.getByText('Base main')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    const dialog = await screen.findByRole('dialog', { name: 'GitHub Cloud run' });
    expect(await within(dialog).findByText('provider started')).toBeInTheDocument();
    expect(within(dialog).getByText(/provider work may continue/i)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop tracking' }));
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(
        '/api/external-agents/dispatches/dispatch-1',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ action: 'stop_tracking' }),
        }),
      );
    });
    expect(toast.success).toHaveBeenCalledWith(
      'Mission Control stopped tracking the provider task',
    );
  });

  it('keeps approvals, outputs, and retry controls available after failure', async () => {
    const current = assignment({
      targetId: 'paperclip-route',
      targetName: 'Paperclip build route',
      targetType: 'paperclip',
      locality: 'external',
      canonicalState: 'failed',
      displayState: 'failed',
      latestProgress: null,
      errorMessage: 'Worker exited before publishing results',
      pendingApproval: true,
      providerTaskId: 'paperclip-issue-1',
      pullRequestUrl: 'https://github.com/octo/repo/pull/42',
      commitSha: '1234567890abcdef',
      checks: [{ name: 'CI', status: 'failed', url: 'https://example.test/ci' }],
      artifacts: [{ name: 'Log', url: 'https://example.test/log' }],
      canCancel: false,
      canStopTracking: false,
      canRetry: true,
      cancellationLimitation: null,
    });
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tasks/task-1/delegation')) {
        return response(context([{ taskId: 'task-1', ...current }]));
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1') && !init?.method) {
        return response({
          dispatch: {
            id: 'dispatch-1',
            providerTaskId: 'paperclip-issue-1',
            providerDetail: { pendingApprovals: [{ id: 'approval-1' }] },
            attempts: [],
            events: [],
          },
        });
      }
      if (init?.method === 'PATCH') return response({ retried: true });
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="panel" />);
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Pull request/ })).toHaveAttribute(
      'href',
      'https://github.com/octo/repo/pull/42',
    );

    fireEvent.click(screen.getByRole('button', { name: 'More details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Paperclip build route run' });
    expect(within(dialog).getByText('1234567890abcdef')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Check: CI/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Artifact: Log/ })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

describe('TaskDelegationDialog', () => {
  it('links the empty state directly to AI & Agents destination setup', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response(context([]))));
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1']));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate task' });
    expect(within(dialog).getByText('No execution destinations configured')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Configure AI & Agents' })).toHaveAttribute(
      'href',
      '/settings/ai-provider?setting=Execution%20Destinations',
    );
  });

  it('ignores a stale context response after the selected tasks change', async () => {
    const first = deferred<Awaited<ReturnType<typeof response>>>();
    const second = deferred<Awaited<ReturnType<typeof response>>>();
    let firstSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('taskId=task-1')) {
        firstSignal = init?.signal ?? null;
        return first.promise;
      }
      if (url.includes('taskId=task-2')) return second.promise;
      throw new Error(`Unexpected request: ${url}`);
    }));
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1']));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    act(() => openTaskDelegation(['task-2']));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSignal).toHaveProperty('aborted', true);

    second.resolve(await response({
      taskIds: ['task-2'],
      tasks: [{ id: 'task-2', title: 'Current task', connectorType: 'github-issues' }],
      assignments: [],
      syncErrors: [],
      targets: [{
        id: 'current-target',
        name: 'Current destination',
        type: 'copilot-cloud',
        description: null,
        executionLocality: 'github-hosted',
        allowedActions: ['write_code'],
        hasCredential: true,
        paperclipBinding: null,
        repositories: [],
        eligibility: [],
      }],
    }));
    expect(await screen.findByText('Current destination')).toBeInTheDocument();

    first.resolve(await response({
      taskIds: ['task-1'],
      tasks: [{ id: 'task-1', title: 'Stale task', connectorType: 'github-issues' }],
      assignments: [],
      syncErrors: [],
      targets: [{
        id: 'stale-target',
        name: 'Stale destination',
        type: 'copilot-cloud',
        description: null,
        executionLocality: 'github-hosted',
        allowedActions: ['analyze_code'],
        hasCredential: true,
        paperclipBinding: null,
        repositories: [],
        eligibility: [],
      }],
    }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Current destination')).toBeInTheDocument();
    expect(screen.queryByText('Stale destination')).not.toBeInTheDocument();
  });

  it('refreshes accepted tasks when bulk confirmation partially succeeds', async () => {
    const refreshed = vi.fn();
    window.addEventListener(TASKS_REFRESH_REQUESTED_EVENT, refreshed);
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/tasks/delegation?')) {
        return response({
          taskIds: ['task-1', 'task-2'],
          tasks: [
            { id: 'task-1', title: 'First task', connectorType: 'github-issues' },
            { id: 'task-2', title: 'Second task', connectorType: 'github-issues' },
          ],
          assignments: [],
          syncErrors: [],
          targets: [{
            id: 'github-cloud',
            name: 'GitHub Cloud',
            type: 'copilot-cloud',
            description: null,
            executionLocality: 'github-hosted',
            allowedActions: ['write_code'],
            hasCredential: true,
            paperclipBinding: null,
            repositories: [],
            eligibility: [
              {
                taskId: 'task-1',
                title: 'First task',
                connectorType: 'github-issues',
                ready: true,
                blocker: null,
                repository: 'octo/repo',
                repositoryLocked: true,
              },
              {
                taskId: 'task-2',
                title: 'Second task',
                connectorType: 'github-issues',
                ready: true,
                blocker: null,
                repository: 'octo/repo',
                repositoryLocked: true,
              },
            ],
          }],
        });
      }
      if (url === '/api/tasks/delegation' && init?.method === 'POST') {
        return response({
          previews: [
            {
              taskId: 'task-1',
              dispatchId: 'dispatch-1',
              previewHash: 'preview-1',
              disclosedFields: ['tasks.title'],
              allowedActions: ['write_code'],
            },
            {
              taskId: 'task-2',
              dispatchId: 'dispatch-2',
              previewHash: 'preview-2',
              disclosedFields: ['tasks.title'],
              allowedActions: ['write_code'],
            },
          ],
          blocked: [],
          readyCount: 2,
          blockedCount: 0,
          requiresConfirmation: true,
        }, 201);
      }
      if (url === '/api/external-agents/dispatch' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { dispatchId: string };
        return body.dispatchId === 'dispatch-1'
          ? response({ dispatch: { status: 'queued' } })
          : response({ error: 'Provider rejected the task' }, 502);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1', 'task-2']));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate 2 tasks' });
    await within(dialog).findByRole('radio', { name: /GitHub Cloud/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure' }));
    fireEvent.change(within(dialog).getByLabelText('Instruction'), {
      target: { value: 'Implement both tasks' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review 2 delegations' }));
    const confirm = await within(dialog).findByRole('button', {
      name: 'Confirm and delegate 2',
    });
    fireEvent.click(confirm);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      '1 delegation confirmed. 1 failed',
    );
    expect(refreshed).toHaveBeenCalledOnce();
    expect((refreshed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      taskIds: ['task-1'],
    });
    window.removeEventListener(TASKS_REFRESH_REQUESTED_EVENT, refreshed);
  });

  it('does not materialize a preview before Review and confirms each durable assignment', async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/tasks/delegation?')) {
        return response({
          taskIds: ['task-1'],
          tasks: [{ id: 'task-1', title: 'Fix parser', connectorType: 'github-issues' }],
          assignments: [],
          syncErrors: [],
          targets: [{
            id: 'github-cloud',
            name: 'GitHub Cloud',
            type: 'copilot-cloud',
            description: null,
            executionLocality: 'github-hosted',
            allowedActions: ['write_code', 'create_pull_request'],
            hasCredential: true,
            paperclipBinding: null,
            repositories: [],
            eligibility: [{
              taskId: 'task-1',
              title: 'Fix parser',
              connectorType: 'github-issues',
              ready: true,
              blocker: null,
              repository: 'octo/repo',
              repositoryLocked: true,
            }],
          }],
        });
      }
      if (url === '/api/tasks/delegation' && init?.method === 'POST') {
        return response({
          previews: [{
            taskId: 'task-1',
            dispatchId: 'dispatch-1',
            previewHash: 'preview-hash',
            processingLocation: 'github-hosted',
            dataClassification: 'standard',
            disclosedFields: ['tasks.id', 'tasks.title'],
            allowedActions: ['write_code', 'create_pull_request'],
            payloadPreview: { tasks: [{ id: 'task-1', title: 'Fix parser' }] },
          }],
          blocked: [],
          readyCount: 1,
          blockedCount: 0,
          requiresConfirmation: true,
        }, 201);
      }
      if (url === '/api/external-agents/dispatch' && init?.method === 'POST') {
        return response({ dispatch: { status: 'queued' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1']));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate task' });
    expect(within(dialog).getByText('Destination')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /GitHub Cloud/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure' }));

    fireEvent.change(within(dialog).getByLabelText('Instruction'), {
      target: { value: 'Implement and test the parser fix' },
    });
    expect(fetcher).not.toHaveBeenCalledWith(
      '/api/tasks/delegation',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.click(within(dialog).getByRole('button', { name: /Review/ }));
    const confirmButton = await within(dialog).findByRole('button', {
      name: 'Confirm and delegate 1',
    });
    expect(fetcher).toHaveBeenCalledWith(
      '/api/tasks/delegation',
      expect.objectContaining({ method: 'POST' }),
    );

    fireEvent.click(confirmButton);
    await waitFor(() => {
      expect(fetcher).toHaveBeenCalledWith(
        '/api/external-agents/dispatch',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            confirm: true,
            dispatchId: 'dispatch-1',
            previewHash: 'preview-hash',
          }),
        }),
      );
    });
    expect(toast.success).toHaveBeenCalledWith('1 task delegated to GitHub Cloud');
  });
});
