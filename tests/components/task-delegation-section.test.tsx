import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskDelegationSection } from '@/components/task-detail/TaskDelegationSection';
import { toast } from '@/lib/toast';

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('TaskDelegationSection', () => {
  it('shows the empty state and confirms the server-issued disclosure preview', async () => {
    const fetcher = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/api/tasks/task-1/delegation') && !init?.method) {
        return response({
          taskId: 'task-1',
          syncError: null,
          assignments: [],
          eligibleTargets: [{
            id: 'paperclip',
            name: 'Paperclip',
            type: 'paperclip',
            description: 'Coordinated multi-agent execution',
            executionLocality: 'external',
            dataClassification: 'standard',
            allowedActions: ['analyze_code', 'write_code'],
            companyId: 'company-1',
          }],
        });
      }
      if (url.endsWith('/api/tasks/task-1/delegation') && init?.method === 'POST') {
        return response({
          dispatchId: 'dispatch-1',
          previewHash: 'preview-hash',
          processingLocation: 'external',
          dataClassification: 'standard',
          disclosedFields: ['instruction', 'tasks.id', 'tasks.title'],
          allowedActions: ['analyze_code', 'write_code'],
          payloadPreview: {
            instruction: 'Implement the fix',
            tasks: [{ id: 'task-1', title: 'Fix parser' }],
          },
        }, 201);
      }
      if (url.endsWith('/api/external-agents/dispatch')) {
        return response({ dispatch: { status: 'queued' } });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="panel" />);

    expect(await screen.findByText(/No execution target is assigned/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Delegate/ }));
    fireEvent.change(screen.getByLabelText('Instruction'), {
      target: { value: 'Implement the fix' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review disclosure' }));

    expect(await screen.findByRole('heading', { name: 'Confirm delegation' })).toBeInTheDocument();
    expect(screen.getByText('tasks.title')).toBeInTheDocument();
    expect(screen.getByText('analyze_code, write_code')).toBeInTheDocument();
    expect(screen.getByText(/"title": "Fix parser"/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delegation' }));
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith('Delegated "Fix parser" to Paperclip');
    });
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

  it('renders blocked Paperclip details and only authoritative actions', async () => {
    vi.stubGlobal('fetch', vi.fn(() => response({
      taskId: 'task-1',
      syncError: null,
      eligibleTargets: [],
      assignments: [{
        dispatchId: 'dispatch-1',
        targetId: 'paperclip',
        targetName: 'Paperclip',
        targetType: 'paperclip',
        companyId: 'company-1',
        responsibleAgent: 'Release engineer',
        responsibleAgentId: 'agent-1',
        issueIdentifier: 'PAP-42',
        issueUrl: 'https://paperclip.example/issues/issue-1',
        runId: 'run-1',
        runUrl: 'https://paperclip.example/runs/run-1',
        locality: 'external',
        canonicalState: 'waiting_for_user',
        displayState: 'blocked',
        latestProgress: 'Tests passed; deployment approval remains.',
        blocker: 'Production approval required',
        pendingApproval: true,
        pullRequestUrl: 'https://github.com/octo/repo/pull/42',
        commitSha: '1234567890abcdef',
        checks: [{ name: 'CI', status: 'passed' }],
        artifacts: [{ name: 'Test report', url: 'https://example.test/report' }],
        disclosedFields: ['tasks.title'],
        allowedActions: ['write_code'],
        errorMessage: null,
        updatedAt: '2026-10-01T00:00:00.000Z',
        canCancel: true,
        canRetry: false,
      }],
    })));

    render(<TaskDelegationSection taskId="task-1" taskTitle="Fix parser" mode="panel" />);

    expect(await screen.findByText('Blocked')).toBeInTheDocument();
    expect(screen.getByText('Approval pending')).toBeInTheDocument();
    expect(screen.getByText('Release engineer')).toBeInTheDocument();
    expect(screen.getByText(/Tests passed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel execution' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-dispatch' })).not.toBeInTheDocument();
  });
});
