import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TaskDelegationBadge } from '@/components/task-list/TaskDelegationBadge';
import type { TaskDelegationSummary } from '@/lib/external-agents/task-delegation';

function delegation(
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
    locality: 'github-hosted',
    canonicalState: 'completed',
    displayState: 'completed',
    providerState: 'completed',
    providerUpdatedAt: '2026-10-01T00:00:00.000Z',
    outputWarning: null,
    pullRequestState: null,
    pullRequestNumber: null,
    latestProgress: null,
    blocker: null,
    pendingApproval: false,
    repository: 'octo/repo',
    baseRef: 'main',
    model: 'auto',
    createPullRequest: true,
    attemptCount: 1,
    maxAttempts: 3,
    branchRef: 'copilot/fix-parser',
    pullRequestUrl: 'https://github.com/octo/repo/pull/42',
    commitSha: null,
    checks: [],
    artifacts: [],
    disclosedFields: ['tasks.title'],
    allowedActions: ['write_code', 'create_pull_request'],
    errorMessage: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    canCancel: false,
    canStopTracking: false,
    canRetry: false,
    cancellationLimitation: null,
    ...overrides,
  };
}

describe('TaskDelegationBadge', () => {
  it('describes a completed run with a pull request without claiming the PR is still ready', () => {
    render(<TaskDelegationBadge delegation={delegation()} />);

    expect(screen.getByLabelText('Delegation Completed · PR created')).toBeInTheDocument();
    expect(screen.queryByText(/PR ready/i)).not.toBeInTheDocument();
  });

  it('keeps the review label while a pull request is awaiting completion', () => {
    render(<TaskDelegationBadge delegation={delegation({
      canonicalState: 'in_progress',
      displayState: 'running',
      providerState: 'in_progress',
      pullRequestState: 'open',
    })} />);

    expect(screen.getByLabelText('Delegation Review · PR ready')).toBeInTheDocument();
  });

  it('shows the reconciled lifecycle state when the pull request is merged', () => {
    render(<TaskDelegationBadge delegation={delegation({
      pullRequestState: 'merged',
      pullRequestNumber: 42,
    })} />);

    expect(screen.getByLabelText('Delegation Merged · PR')).toBeInTheDocument();
  });
});
