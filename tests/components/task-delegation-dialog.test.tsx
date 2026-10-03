import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TaskDelegationDialog disclosure review', () => {
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
    fireEvent.change(screen.getByLabelText('Per-dispatch instructions'), {
      target: { value: 'Fix the parser and add coverage.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review 1 delegation' }));

    expect(await screen.findByText('Effective reviewed context')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Canonical parser task'));
    await waitFor(() => {
      expect(screen.getByText((_, element) =>
        element?.tagName === 'PRE'
        && element.textContent?.includes('"alwaysInstructions": "Run focused tests before handoff."')
        && element.textContent?.includes('"description": "The complete canonical description."')
        && element.textContent?.includes('"title": "Add regression coverage"') === true,
      )).toBeInTheDocument();
    });
  });
});
