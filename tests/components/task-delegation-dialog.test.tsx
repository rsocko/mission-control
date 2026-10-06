import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDelegationDialog } from '@/components/task-delegation/TaskDelegationDialog';
import { openTaskDelegation } from '@/components/task-delegation/events';

function response(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  });
}

const workerContext = {
  taskIds: ['task-1'],
  tasks: [{ id: 'task-1', title: 'Background task', connectorType: 'local' }],
  targets: [{
    id: 'worker-queue',
    name: 'Worker queue',
    type: 'pull-queue',
    description: null,
    alwaysInstructions: '',
    executionLocality: 'mission-control-host',
    allowedActions: ['write_code'],
    hasCredential: true,
    paperclipBinding: null,
    repositories: [],
    eligibility: [{
      taskId: 'task-1',
      title: 'Background task',
      connectorType: 'local',
      ready: true,
      blocker: null,
      repository: null,
      repositoryLocked: false,
    }],
  }],
  assignments: [],
  syncErrors: [],
};

const workerPreview = {
  previews: [{
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    previewHash: 'preview-hash',
    processingLocation: 'mission-control-host',
    dataClassification: 'standard',
    disclosedFields: ['tasks.title'],
    allowedActions: ['write_code'],
    payloadPreview: { tasks: [{ id: 'task-1', title: 'Background task' }] },
  }],
  blocked: [],
  readyCount: 1,
  blockedCount: 0,
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TaskDelegationDialog disclosure review', () => {
  it('only allows destinations with at least one eligible selected task', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      taskIds: ['task-1'],
      tasks: [{ id: 'task-1', title: 'Restricted task', connectorType: 'scout' }],
      targets: [
        {
          id: 'public-cloud',
          name: 'Public Cloud',
          type: 'copilot-cloud',
          description: null,
          alwaysInstructions: '',
          executionLocality: 'github-hosted',
          allowedActions: ['write_code'],
          hasCredential: true,
          paperclipBinding: null,
          repositories: [],
          eligibility: [{
            taskId: 'task-1',
            title: 'Restricted task',
            connectorType: 'scout',
            ready: false,
            blocker: 'Agent policy does not allow restricted data',
            repository: null,
            repositoryLocked: false,
          }],
        },
        {
          id: 'private-runner',
          name: 'Private Runner',
          type: 'pull-queue',
          description: null,
          alwaysInstructions: '',
          executionLocality: 'mission-control-host',
          allowedActions: ['write_code'],
          hasCredential: true,
          paperclipBinding: null,
          repositories: [],
          eligibility: [{
            taskId: 'task-1',
            title: 'Restricted task',
            connectorType: 'scout',
            ready: true,
            blocker: null,
            repository: null,
            repositoryLocked: false,
          }],
        },
      ],
      assignments: [],
      syncErrors: [],
    })));

    render(<TaskDelegationDialog />);
    openTaskDelegation(['task-1']);

    const blockedTarget = await screen.findByRole('radio', { name: /Public Cloud/ });
    expect(blockedTarget).toBeDisabled();
    expect(blockedTarget).toHaveAttribute(
      'title',
      'Agent policy does not allow restricted data',
    );
    expect(screen.getByText('Agent policy does not allow restricted data')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Private Runner/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Configure' })).toBeEnabled();
  });

  it('shows configured and per-dispatch instructions with the exact rich payload', async () => {
    const payloadPreview = {
      instruction: 'Fix the parser and add coverage.',
      alwaysInstructions: 'Run focused tests before handoff.',
      tasks: [{
        id: 'task-1',
        title: 'Canonical parser task',
        description: 'The complete canonical description.',
        status: 'todo',
        priority: 'high',
        tags: ['parser'],
        subtasks: [{
          id: 'subtask-1',
          title: 'Add regression coverage',
          description: 'Cover escaped delimiters.',
          status: 'todo',
          siblingOrder: 1,
        }],
      }],
    };
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/tasks/delegation?') && !init?.method) {
        return response({
          taskIds: ['task-1'],
          tasks: [{ id: 'task-1', title: 'Canonical parser task', connectorType: 'github-issues' }],
          targets: [{
            id: 'github-cloud',
            name: 'GitHub Cloud',
            type: 'copilot-cloud',
            description: null,
            alwaysInstructions: 'Run focused tests before handoff.',
            executionLocality: 'github-hosted',
            allowedActions: ['write_code'],
            hasCredential: true,
            paperclipBinding: null,
            repositories: [],
            eligibility: [{
              taskId: 'task-1',
              title: 'Canonical parser task',
              connectorType: 'github-issues',
              ready: true,
              blocker: null,
              repository: 'octo/example',
              repositoryLocked: true,
            }],
          }],
          assignments: [],
          syncErrors: [],
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
            classificationExplanation: 'Standard because GitHub Issues uses the active policy default',
            classificationSources: [{
              connectorType: 'github-issues',
              connectorInstanceId: 'github-primary',
              connectorName: 'GitHub Issues',
              baseline: 'standard',
              effective: 'standard',
              override: null,
            }],
            disclosedFields: [
              'instruction',
              'alwaysInstructions',
              'tasks.description',
              'tasks.subtasks',
            ],
            allowedActions: ['write_code'],
            payloadPreview,
          }],
          blocked: [],
          readyCount: 1,
          blockedCount: 0,
        }, 201);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationDialog />);
    openTaskDelegation(['task-1']);

    expect(await screen.findByText('GitHub Cloud')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    expect(screen.getByText('Run focused tests before handoff.')).toBeInTheDocument();
    const instructionInput = screen.getByLabelText('Per-dispatch instructions');
    const reviewButton = screen.getByRole('button', { name: 'Review 1 delegation' });
    expect(instructionInput).not.toBeRequired();
    expect(instructionInput).toHaveAccessibleDescription(
      'Add guidance only when the task details do not fully describe the desired outcome.',
    );
    expect(reviewButton).toBeEnabled();
    fireEvent.change(instructionInput, {
      target: { value: 'Fix the parser and add coverage.' },
    });
    expect(reviewButton).toBeEnabled();
    fireEvent.click(reviewButton);

    expect(await screen.findByText('Task brief')).toBeInTheDocument();
    expect(screen.queryByText('Disclosed fields')).not.toBeInTheDocument();
    expect(screen.getByText('Request')).toBeInTheDocument();
    expect(screen.getByText('Fix the parser and add coverage.')).toBeInTheDocument();
    expect(screen.getByText('Destination instructions')).toBeInTheDocument();
    expect(screen.getByText(/Standard because GitHub Issues uses the active policy default/))
      .toBeInTheDocument();
    fireEvent.click(screen.getByText('View technical dispatch data'));
    await waitFor(() => {
      expect(screen.getByText((_, element) =>
        element?.tagName === 'PRE'
        && element.textContent?.includes('"alwaysInstructions": "Run focused tests before handoff."')
        && element.textContent?.includes('"description": "The complete canonical description."')
        && element.textContent?.includes('"title": "Add regression coverage"') === true,
      )).toBeInTheDocument();
    });
  });

  it('uses destination Paperclip bindings as overridable dispatch defaults', async () => {
      let previewRequest: Record<string, unknown> | null = null;
      const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('/api/tasks/delegation?') && !init?.method) {
          return response({
            taskIds: ['task-1'],
            tasks: [{ id: 'task-1', title: 'Paperclip task', connectorType: 'local' }],
            targets: [{
              id: 'paperclip-route',
              name: 'Paperclip',
              type: 'paperclip',
              description: null,
              alwaysInstructions: '',
              executionLocality: 'external',
              allowedActions: ['write_code'],
              hasCredential: true,
              paperclipBinding: {
                companyId: '11111111-1111-4111-8111-111111111111',
                projectId: null,
                assigneeAgentId: '33333333-3333-4333-8333-333333333333',
                requiredAdapterType: 'claude-local',
              },
              repositories: [],
              eligibility: [{
                taskId: 'task-1',
                title: 'Paperclip task',
                connectorType: 'local',
                ready: true,
                blocker: null,
                repository: null,
                repositoryLocked: false,
              }],
            }],
            assignments: [],
            syncErrors: [],
          });
        }
        if (url === '/api/external-agents/paperclip/discover' && init?.method === 'POST') {
          return response({
            companies: [{
              id: '11111111-1111-4111-8111-111111111111',
              name: 'Acme',
              status: 'active',
            }],
            projects: [{
              id: '22222222-2222-4222-8222-222222222222',
              name: 'Project Alpha',
              status: 'active',
            }],
            agents: [{
              id: '33333333-3333-4333-8333-333333333333',
              name: 'Engineer',
              title: 'Software Engineer',
              role: 'engineer',
              status: 'idle',
              adapterType: 'claude-local',
            }],
          });
        }
        if (url === '/api/tasks/delegation' && init?.method === 'POST') {
          previewRequest = JSON.parse(String(init.body)) as Record<string, unknown>;
          return response({
            previews: [{
              taskId: 'task-1',
              dispatchId: 'dispatch-1',
              previewHash: 'preview-hash',
              processingLocation: 'external',
              dataClassification: 'standard',
              disclosedFields: ['instruction'],
              allowedActions: ['write_code'],
              payloadPreview: { instruction: 'Implement the change.' },
            }],
            blocked: [],
            readyCount: 1,
            blockedCount: 0,
          }, 201);
        }
        throw new Error(`Unexpected request: ${url}`);
      });
      vi.stubGlobal('fetch', fetcher);

      render(<TaskDelegationDialog />);
      openTaskDelegation(['task-1']);
      expect(await screen.findByText('Paperclip')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
      expect(await screen.findByRole('combobox', { name: 'Paperclip project' }))
        .toBeInTheDocument();
      fireEvent.click(screen.getByRole('combobox', { name: 'Paperclip project' }));
      fireEvent.click(screen.getByRole('option', { name: 'Project Alpha' }));
      fireEvent.change(screen.getByLabelText('Per-dispatch instructions'), {
        target: { value: 'Implement the change.' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Review 1 delegation' }));

      await waitFor(() => expect(previewRequest).toMatchObject({
        paperclipBinding: {
          companyId: '11111111-1111-4111-8111-111111111111',
          projectId: '22222222-2222-4222-8222-222222222222',
          assigneeAgentId: '33333333-3333-4333-8333-333333333333',
          requiredAdapterType: 'claude-local',
        },
      }));
  });

  it('releases the modal pointer lock when closed during worker handoff', async () => {
    type MockResponse = Awaited<ReturnType<typeof response>>;
    let resolveConfirmation!: (value: MockResponse) => void;
    const pendingConfirmation = new Promise<MockResponse>((resolve) => {
      resolveConfirmation = resolve;
    });
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/tasks/delegation?') && !init?.method) {
        return response(workerContext);
      }
      if (url === '/api/tasks/delegation' && init?.method === 'POST') {
        return response(workerPreview, 201);
      }
      if (url === '/api/external-agents/dispatch' && init?.method === 'POST') {
        return pendingConfirmation;
      }
      if (url === '/api/tasks/task-1' && init?.method === 'PATCH') {
        return response({ id: 'task-1', status: 'in_progress' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationDialog />);
    openTaskDelegation(['task-1']);
    expect(await screen.findByText('Worker queue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 delegation' }));
    expect(await screen.findByRole('button', { name: 'Confirm and delegate 1' }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and delegate 1' }));

    expect(await screen.findByText('Queueing work with Worker queue')).toBeInTheDocument();
    expect(screen.getByText(
      'Sending delegation 1 of 1 to the Mission Control worker.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'You can close this window. Queued work continues in the background.',
    )).toBeInTheDocument();
    const progress = screen.getByRole('progressbar', {
      name: 'Delegation handoff progress',
    });
    expect(progress).toHaveAttribute('aria-valuenow', '0');
    expect(progress).toHaveAttribute('aria-valuetext', '0 of 1 queued');
    expect(progress.firstElementChild).toHaveClass('motion-reduce:transition-none');
    expect(screen.getByRole('button', { name: 'Queueing 1 of 1…' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Close delegation' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(document.body.style.pointerEvents).not.toBe('none');
    });

    await act(async () => {
      resolveConfirmation(await response({ dispatch: { status: 'queued' } }, 202));
      await pendingConfirmation;
    });
    expect(fetcher).toHaveBeenCalledWith('/api/tasks/task-1', expect.objectContaining({
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lets the user keep delegated task statuses unchanged', async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/tasks/delegation?') && !init?.method) {
        return response(workerContext);
      }
      if (url === '/api/tasks/delegation' && init?.method === 'POST') {
        return response(workerPreview, 201);
      }
      if (url === '/api/external-agents/dispatch' && init?.method === 'POST') {
        return response({ dispatch: { status: 'queued' } }, 202);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationDialog />);
    openTaskDelegation(['task-1']);
    expect(await screen.findByText('Worker queue')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Configure' }));

    const statusPreference = screen.getByRole('checkbox', {
      name: /Mark delegated tasks as In Progress/,
    });
    expect(statusPreference).toBeChecked();
    fireEvent.click(statusPreference);

    fireEvent.click(screen.getByRole('button', { name: 'Review 1 delegation' }));
    expect(await screen.findByText('Leave unchanged')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm and delegate 1' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(fetcher).not.toHaveBeenCalledWith(
      '/api/tasks/task-1',
      expect.objectContaining({ method: 'PATCH' }),
    );
  });
});
