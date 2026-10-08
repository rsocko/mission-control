import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitHubPullRequests } from '@/components/task-detail/GitHubPullRequests';

const pr = {
  number: 42,
  url: 'https://github.com/owner/repo/pull/42',
  title: 'Fix issue',
  repository: 'owner/repo',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  defaultBranch: 'main',
  checks: 'SUCCESS',
};

function json(pullRequests: unknown[], hasMore = false) {
  return new Response(JSON.stringify({ pullRequests, hasMore }));
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('GitHub pull requests in task details', () => {
  it('shows a loading state followed by external PR links and status for multiple PRs', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([
      pr,
      { ...pr, number: 43, url: 'https://github.com/owner/repo/pull/43', isDraft: true, checks: 'PENDING' },
      { ...pr, number: 44, url: 'https://github.com/owner/repo/pull/44', state: 'CLOSED', checks: null },
    ], true)));
    render(<GitHubPullRequests taskId="task-1" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading pull requests');
    const link = await screen.findByRole('link', { name: 'owner/repo pull request #42: Fix issue' });
    expect(link).toHaveAttribute('href', pr.url);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Open')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.getByText('Target: main (default branch) · PR checks: passed')).toBeInTheDocument();
    expect(screen.getByText(/PR checks: pending/)).toBeInTheDocument();
    expect(screen.getByText(/PR checks: unavailable/)).toBeInTheDocument();
    expect(screen.getByText(/Showing the first 20/)).toBeInTheDocument();
  });

  it.each([
    ['main', 'main', 'Merged into main (default branch) · Merge checks: passed'],
    ['release', 'main', 'Merged into release · Merge checks: passed'],
    ['master', 'master', 'Merged into master (default branch) · Merge checks: passed'],
  ])('shows the actual merge target %s, not just whether main was targeted', async (baseRefName, defaultBranch, label) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([{ ...pr, state: 'MERGED', baseRefName, defaultBranch }])));
    render(<GitHubPullRequests taskId="task-1" />);
    expect(await screen.findByText(label)).toBeInTheDocument();
    expect(screen.getByText('Merged')).toBeInTheDocument();
  });

  it('distinguishes no linked PRs from a failed lookup', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json([])));
    render(<GitHubPullRequests taskId="task-1" />);
    expect(await screen.findByText('No linked pull requests.')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps lookup failures non-blocking with a GitHub fallback', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 502 })));
    render(<GitHubPullRequests taskId="task-1" />);
    expect(await screen.findByText('Pull requests unavailable. Open the issue in GitHub to check.')).toBeInTheDocument();
    expect(screen.queryByText('No linked pull requests.')).not.toBeInTheDocument();
  });

  it('aborts on task changes and ignores a late response for the previous task', async () => {
    let resolveFirst!: (response: Response) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(json([]));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender, unmount } = render(<GitHubPullRequests taskId="task-1" />);
    rerender(<GitHubPullRequests taskId="task-2" />);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    await screen.findByText('No linked pull requests.');
    await act(async () => { resolveFirst(json([pr])); });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    unmount();
    await waitFor(() => expect(fetchMock.mock.calls[1][1].signal.aborted).toBe(true));
  });
});
