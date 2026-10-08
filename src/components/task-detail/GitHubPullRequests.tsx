'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, GitPullRequest } from 'lucide-react';
import type {
  LinkedPullRequest,
  LinkedPullRequestsResult,
} from '@/lib/connectors/github-issues/linked-pull-requests';

const CHECK_LABELS: Record<NonNullable<LinkedPullRequest['checks']>, string> = {
  SUCCESS: 'passed',
  FAILURE: 'failed',
  ERROR: 'error',
  PENDING: 'pending',
  EXPECTED: 'expected',
};

export function GitHubPullRequests({ taskId }: { taskId: string }) {
  const [result, setResult] = useState<LinkedPullRequestsResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setResult(null);
    setFailed(false);
    void fetch(`/api/tasks/${encodeURIComponent(taskId)}/pull-requests`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Pull requests unavailable');
        const data: LinkedPullRequestsResult = await response.json();
        if (!controller.signal.aborted) setResult(data);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [taskId]);

  return (
    <div className="w-full border-t border-[var(--border-subtle)] pt-3">
      <h4 className="mb-2 flex items-center gap-2 text-xs font-medium text-[var(--text-secondary)]">
        <GitPullRequest size={14} aria-hidden="true" />
        Linked pull requests
      </h4>
      {!result && (
        <p role="status" className="text-xs text-[var(--text-muted)]">
          {failed ? 'Pull requests unavailable. Open the issue in GitHub to check.' : 'Loading pull requests…'}
        </p>
      )}
      {result?.pullRequests.length === 0 && (
        <p className="text-xs text-[var(--text-muted)]">No linked pull requests.</p>
      )}
      {result && (
        <ul className="space-y-2">
          {result.pullRequests.map((pr) => (
            <li key={pr.url} className="text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={pr.title}
                  aria-label={`${pr.repository} pull request #${pr.number}: ${pr.title}`}
                  className="inline-flex min-h-9 items-center gap-1 text-[var(--accent)] underline underline-offset-2 hover:text-[var(--accent-500)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
                >
                  {pr.repository}#{pr.number}
                  <ExternalLink size={11} aria-hidden="true" />
                </a>
                <span className="text-[var(--text-secondary)]">
                  {pr.state === 'MERGED' ? 'Merged' : pr.state === 'CLOSED' ? 'Closed' : pr.isDraft ? 'Draft' : 'Open'}
                </span>
              </div>
              <p className="break-words text-[var(--text-muted)]">
                {pr.state === 'MERGED' ? 'Merged into' : 'Target:'} {pr.baseRefName}
                {pr.baseRefName === pr.defaultBranch ? ' (default branch)' : ''}
                {' · '}{pr.state === 'MERGED' ? 'Merge checks' : 'PR checks'}: {pr.checks ? CHECK_LABELS[pr.checks] : 'unavailable'}
              </p>
            </li>
          ))}
        </ul>
      )}
      {result?.hasMore && (
        <p className="mt-2 text-xs text-[var(--text-muted)]">Showing the first 20. Open the issue in GitHub for all linked pull requests.</p>
      )}
    </div>
  );
}
