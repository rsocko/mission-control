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
    targetName: 'GitHub Copilot Cloud',
    targetType: 'copilot-cloud',
    companyId: null,
    responsibleAgent: null,
    responsibleAgentId: null,
    issueIdentifier: null,
    issueUrl: null,
    runId: null,
    runUrl: null,
    providerTaskId: 'agent-task-1',
    providerTaskUrl: null,
    locality: 'github-hosted',
    canonicalState: 'in_progress',
    displayState: 'running',
    providerState: 'in_progress',
    providerUpdatedAt: '2026-10-01T00:00:00.000Z',
    outputWarning: null,
    pullRequestState: null,
    pullRequestNumber: null,
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
    const delegateButton = screen.getByRole('button', { name: 'Delegate' });
    expect(delegateButton.querySelector('svg')).toBeInTheDocument();
    fireEvent.click(delegateButton);
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
      if (url.includes('/api/tasks/task-1/delegation')) {
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
        const action = JSON.parse(String(init.body)).action;
        if (action === 'refresh') {
          return response({
            dispatch: {
              id: 'dispatch-1',
              providerTaskId: 'agent-task-1',
              providerDetail: null,
              attempts: [],
              events: [{
                id: 1,
                eventType: 'provider_started',
                detail: {},
                createdAt: '2026-10-01T00:00:00.000Z',
              }],
            },
          });
        }
        return response({ stoppedTracking: true });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="dialog" />);

    expect(await screen.findByText('Running')).toBeInTheDocument();
    expect(screen.getByText('· GitHub Copilot Cloud')).toBeInTheDocument();
    expect(screen.getByText('Running focused reconciliation tests.')).toBeInTheDocument();
    expect(screen.getByText('Base main')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'GitHub Copilot Cloud run' });
    expect(await within(dialog).findByText('provider started')).toBeInTheDocument();
    expect(within(dialog).getAllByText('in_progress')).not.toHaveLength(0);
    expect(within(dialog).getByText(/Last synced/)).toBeInTheDocument();
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

  it('queues a provider refresh and polls persisted state', async () => {
    let refreshed = false;
    const queued = assignment({
      canonicalState: 'queued',
      displayState: 'queued',
      providerState: 'queued',
      latestProgress: null,
    });
    const completed = assignment({
      canonicalState: 'completed',
      displayState: 'completed',
      providerState: 'completed',
      pullRequestState: 'merged',
      pullRequestNumber: 42,
      pullRequestUrl: 'https://github.com/octo/repo/pull/42',
      providerTaskUrl: 'https://github.com/copilot/tasks/agent-task-1',
      latestProgress: null,
      canStopTracking: false,
      cancellationLimitation: null,
    });
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/tasks/task-1/delegation')) {
        const current = refreshed ? completed : queued;
        return response(context([{ taskId: 'task-1', ...current }]));
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1') && init?.method === 'PATCH') {
        refreshed = true;
        return response({
          accepted: true,
          dispatch: {
            id: 'dispatch-1',
            providerTaskId: 'agent-task-1',
            providerDetail: { state: 'completed' },
            attempts: [],
            events: [],
          },
        });
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1') && !init?.method) {
        return response({
          dispatch: {
            id: 'dispatch-1',
            providerTaskId: 'agent-task-1',
            providerDetail: refreshed ? { state: 'completed' } : { state: 'queued' },
            attempts: [],
            events: [],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="dialog" />);

    expect(await screen.findByText('Queued')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'GitHub Copilot Cloud run' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Request refresh' }));
    expect(await within(dialog).findByText('Completed')).toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith('Provider refresh queued');
    expect(within(dialog).getByText(
      'The provider completed the run and its pull request was merged.',
    )).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close run details' }));
    expect(screen.getByRole('link', { name: 'View PR' }))
      .toHaveAttribute('href', 'https://github.com/octo/repo/pull/42');
    expect(screen.getByRole('link', { name: 'Cloud Agent' }))
      .toHaveAttribute('href', 'https://github.com/copilot/tasks/agent-task-1');
    expect(screen.getByText('PR #42 merged')).toBeInTheDocument();
    expect(screen.queryByText('Attempt 1/3')).not.toBeInTheDocument();
    expect(screen.queryByText(
      'The provider completed the run and its pull request was merged.',
    )).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const refreshedDialog = await screen.findByRole('dialog', { name: 'GitHub Copilot Cloud run' });
    expect(within(refreshedDialog).getByRole('link', { name: /Pull request #42 · Merged/ }))
      .toHaveAttribute('href', 'https://github.com/octo/repo/pull/42');
    expect(within(refreshedDialog).getByRole('link', { name: 'Open Cloud Agent session' }))
      .toHaveAttribute('href', 'https://github.com/copilot/tasks/agent-task-1');
  });

  it('links to the Cloud Agent when pull request details are unavailable', async () => {
    const current = assignment({
      canonicalState: 'completed',
      displayState: 'completed',
      providerState: 'completed',
      outputWarning: 'GitHub reported a pull request output, but its details are unavailable.',
      providerTaskUrl: 'https://github.com/copilot/tasks/agent-task-1',
      latestProgress: null,
      canStopTracking: false,
      cancellationLimitation: null,
    });
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/api/tasks/task-1/delegation')) {
        return response(context([{ taskId: 'task-1', ...current }]));
      }
      if (url.endsWith('/api/external-agents/dispatches/dispatch-1')) {
        return response({
          dispatch: {
            id: 'dispatch-1',
            providerTaskId: 'agent-task-1',
            providerDetail: {
              state: 'completed',
              taskUrl: 'https://github.com/copilot/tasks/agent-task-1',
            },
            attempts: [],
            events: [],
          },
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="dialog" />);

    expect(await screen.findByRole('link', { name: 'Cloud Agent' }))
      .toHaveAttribute('href', 'https://github.com/copilot/tasks/agent-task-1');
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    const dialog = await screen.findByRole('dialog', { name: 'GitHub Copilot Cloud run' });
    expect(within(dialog).getByRole('link', { name: 'Open Cloud Agent session' }))
      .toHaveAttribute('href', 'https://github.com/copilot/tasks/agent-task-1');
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
    expect(screen.getByRole('link', { name: 'Review PR' })).toHaveAttribute(
      'href',
      'https://github.com/octo/repo/pull/42',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
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
    const dialog = await screen.findByRole('dialog', { name: 'Delegate task: Fix parser' });
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
    expect(await screen.findByRole('dialog', { name: 'Delegate task: Current task' }))
      .toBeInTheDocument();

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
    expect(screen.getByRole('dialog', { name: 'Delegate task: Current task' }))
      .toBeInTheDocument();
    expect(screen.queryByText('Delegate task: Stale task')).not.toBeInTheDocument();
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
            name: 'GitHub Copilot Cloud',
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
              processingLocation: 'github-hosted',
              dataClassification: 'standard',
              disclosedFields: ['tasks.title'],
              allowedActions: ['write_code'],
              payloadPreview: { tasks: [{ id: 'task-1', title: 'First task' }] },
            },
            {
              taskId: 'task-2',
              dispatchId: 'dispatch-2',
              previewHash: 'preview-2',
              processingLocation: 'github-hosted',
              dataClassification: 'standard',
              disclosedFields: ['tasks.title'],
              allowedActions: ['write_code'],
              payloadPreview: { tasks: [{ id: 'task-2', title: 'Second task' }] },
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
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return response({ id: 'task-1', status: 'in_progress' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1', 'task-2']));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate 2 tasks' });
    await within(dialog).findByRole('radio', { name: /GitHub Copilot Cloud/ });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure' }));
    fireEvent.change(within(dialog).getByLabelText('Per-dispatch instructions'), {
      target: { value: 'Implement both tasks' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Review 2 delegations' }));
    const confirm = await within(dialog).findByRole('button', {
      name: 'Confirm and delegate 2',
    });
    fireEvent.click(confirm);

    const recovery = await within(dialog).findByRole('alert', {
      name: 'Some delegation work needs attention',
    });
    expect(recovery).toHaveTextContent('Second task');
    expect(recovery).toHaveTextContent('Assignment failed: Provider rejected the task');
    expect(within(recovery).getByRole('button', { name: 'Retry assignment' }))
      .toBeInTheDocument();
    expect(refreshed).toHaveBeenCalledOnce();
    expect((refreshed.mock.calls[0][0] as CustomEvent).detail).toEqual({
      taskIds: ['task-1'],
    });
    expect(fetcher).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    }));
    window.removeEventListener(TASKS_REFRESH_REQUESTED_EVENT, refreshed);
  });

  it('does not materialize a preview before Review and confirms each durable assignment', async () => {
    const confirmation = deferred<Awaited<ReturnType<typeof response>>>();
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
            name: 'GitHub Copilot Cloud',
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
        return confirmation.promise;
      }
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return response({ id: 'task-1', status: 'in_progress' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<TaskDelegationDialog />);

    act(() => openTaskDelegation(['task-1']));
    const dialog = await screen.findByRole('dialog', { name: 'Delegate task: Fix parser' });
    expect(within(dialog).getByText('Choose provider')).toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /GitHub Copilot Cloud/ })).toBeChecked();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Configure' }));

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
    expect(await within(dialog).findByRole('button', {
      name: 'Queueing 1 of 1…',
    })).toBeDisabled();
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
    confirmation.resolve(await response({ dispatch: { status: 'queued' } }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        '1 task queued in 1 assignment for GitHub Copilot Cloud',
      );
    });
    expect(fetcher).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    }));
  });
});
