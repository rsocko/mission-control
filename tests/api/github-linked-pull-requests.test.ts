import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  getTask: vi.fn(),
  getConnector: vi.fn(),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({ ancillary: { getTask: mocks.getTask } }),
}));
vi.mock('@/lib/connectors/management-service', () => ({
  getConnectorManagementPersistence: async () => ({ getConnector: mocks.getConnector }),
}));

const pullRequest = {
  number: 42,
  url: 'https://github.com/owner/repo/pull/42',
  title: 'Fix the issue',
  state: 'OPEN',
  isDraft: false,
  baseRefName: 'main',
  repository: { nameWithOwner: 'owner/repo', defaultBranchRef: { name: 'main' } },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  mergeCommit: null,
};

function upstream(nodes: unknown[] = [pullRequest], hasNextPage = false, byNode = false) {
  const issue = { closedByPullRequestsReferences: { nodes, pageInfo: { hasNextPage } } };
  return new Response(JSON.stringify({ data: byNode ? { issue } : { repository: { issue } } }));
}

async function invoke() {
  const { GET } = await import('@/app/api/tasks/[id]/pull-requests/route');
  return GET(new Request('http://localhost/api/tasks/task-1/pull-requests'), {
    params: Promise.resolve({ id: 'task-1' }),
  });
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
  mocks.getTask.mockResolvedValue({
    id: 'task-1',
    connectorType: 'github-issues',
    connectorInstanceId: 'github-1',
    sourceId: 'owner/repo:1086',
    metadata: null,
  });
  mocks.getConnector.mockResolvedValue({
    id: 'github-1',
    type: 'github-issues',
    enabled: true,
    deletedAt: null,
    credentials: { token: 'test-token' },
    settings: {},
  });
  mocks.fetch.mockImplementation(async () => upstream());
});

describe('GitHub issue linked pull requests', () => {
  it('returns multiple PRs and requests only a bounded page and check rollups', async () => {
    mocks.fetch.mockResolvedValue(upstream([
      pullRequest,
      { ...pullRequest, number: 43, url: 'https://github.com/other/repo/pull/43', state: 'CLOSED' },
      null,
    ], true));

    const response = await invoke();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toMatchObject({
      hasMore: true,
      pullRequests: [
        { number: 42, state: 'OPEN', checks: 'SUCCESS', defaultBranch: 'main' },
        { number: 43, state: 'CLOSED' },
      ],
    });
    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [url, options] = mocks.fetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/graphql');
    const { query, variables } = JSON.parse(options.body);
    expect(query).toContain('first: 20, includeClosedPrs: true');
    expect(query).toContain('commits(last: 1)');
    expect(query).not.toContain('contexts');
    expect(variables).toEqual({ owner: 'owner', name: 'repo', number: 1086 });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.cache).toBe('no-store');
    expect(options.redirect).toBe('error');
  });

  it('uses a stable issue node ID rather than a potentially stale locator', async () => {
    mocks.getTask.mockResolvedValue({
      connectorType: 'github-issues',
      connectorInstanceId: 'github-1',
      sourceId: 'old/repo:1086',
      metadata: JSON.stringify({ nodeId: 'I_stable' }),
    });
    mocks.fetch.mockResolvedValue(upstream([pullRequest], false, true));
    expect((await invoke()).status).toBe(200);
    const { query, variables } = JSON.parse(mocks.fetch.mock.calls[0][1].body);
    expect(query).toContain('node(id: $id)');
    expect(variables).toEqual({ id: 'I_stable' });
  });

  it('uses merge-commit checks for merged PRs and never substitutes passing head checks', async () => {
    mocks.fetch.mockResolvedValue(upstream([
      { ...pullRequest, state: 'MERGED', mergeCommit: { statusCheckRollup: { state: 'FAILURE' } } },
      { ...pullRequest, number: 43, state: 'MERGED', mergeCommit: null },
    ]));
    expect((await (await invoke()).json()).pullRequests.map((pr: { checks: string | null }) => pr.checks))
      .toEqual(['FAILURE', null]);
  });

  it('preserves PR links when GitHub returns partial data with unavailable checks', async () => {
    const response = upstream([{ ...pullRequest, commits: null, repository: { nameWithOwner: 'owner/repo', defaultBranchRef: null } }]);
    const body = await response.json();
    body.errors = [{ message: 'Checks not accessible' }];
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify(body)));
    expect((await (await invoke()).json()).pullRequests[0]).toMatchObject({
      number: 42, checks: null, defaultBranch: null,
    });
  });

  it('returns an empty result when no closing PRs are linked', async () => {
    mocks.fetch.mockResolvedValue(upstream([]));
    expect(await (await invoke()).json()).toEqual({ pullRequests: [], hasMore: false });
  });

  it('shares concurrent requests and caches results when reopening details', async () => {
    const responses = await Promise.all([invoke(), invoke()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await invoke();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('refreshes after the short cache expires', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
      await invoke();
      now.mockReturnValue(61_001);
      await invoke();
      expect(mocks.fetch).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it('does not reuse cached results after credentials change', async () => {
    await invoke();
    mocks.getConnector.mockResolvedValue({
      type: 'github-issues', enabled: true, deletedAt: null,
      credentials: { pat: 'different-test-token' }, settings: {},
    });
    await invoke();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
  });

  it.each(['local', 'github-notifications'])('does not query GitHub for %s tasks', async (connectorType) => {
    mocks.getTask.mockResolvedValue({ connectorType, sourceId: 'owner/repo:1086' });
    expect(await (await invoke()).json()).toEqual({ pullRequests: [], hasMore: false });
    expect(mocks.getConnector).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each(['checklist:owner/repo:1086:0', 'notification-1', 'owner/repo:not-a-number', null])(
    'does not query GitHub for non-issue source IDs: %s', async (sourceId) => {
      mocks.getTask.mockResolvedValue({ connectorType: 'github-issues', sourceId });
      expect(await (await invoke()).json()).toEqual({ pullRequests: [], hasMore: false });
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );

  it('rejects missing tasks and inactive connectors without an upstream request', async () => {
    mocks.getTask.mockResolvedValueOnce(null);
    expect((await invoke()).status).toBe(404);
    mocks.getConnector.mockResolvedValueOnce({
      type: 'github-issues', enabled: false, deletedAt: null,
    });
    expect((await invoke()).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('requires configured connector credentials', async () => {
    mocks.getConnector.mockResolvedValue({
      type: 'github-issues', enabled: true, deletedAt: null,
      credentials: {}, settings: {},
    });
    expect((await invoke()).status).toBe(401);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it('uses the configured Enterprise host and validates returned PR URLs', async () => {
    mocks.getConnector.mockResolvedValue({
      type: 'github-issues', enabled: true, deletedAt: null,
      credentials: { token: 'test-token' }, settings: { apiOrigin: 'https://github.example.com/api/v3' },
    });
    mocks.fetch.mockResolvedValueOnce(upstream([{
      ...pullRequest, url: 'https://github.example.com/owner/repo/pull/42',
    }]));
    expect((await invoke()).status).toBe(200);
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://github.example.com/api/graphql');
  });

  it.each(['javascript:alert(1)', 'https://untrusted.example/owner/repo/pull/42'])(
    'rejects unsafe upstream PR links: %s', async (url) => {
      mocks.fetch.mockResolvedValue(upstream([{ ...pullRequest, url }]));
      expect((await invoke()).status).toBe(502);
    },
  );

  it('reports failures without upstream error bodies or credentials and briefly caches them', async () => {
    mocks.fetch.mockResolvedValue(new Response('private upstream details', { status: 403 }));
    const response = await invoke();
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(JSON.stringify({ error: 'GitHub pull requests could not be loaded' }));
    await invoke();
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it('does not treat GraphQL errors as an empty PR list', async () => {
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ errors: [{ message: 'Permission denied' }] })));
    expect((await invoke()).status).toBe(502);
  });

  it('keeps the timeout signal active while consuming a stalled response body', async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    mocks.fetch.mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(stream) {
        options.signal.addEventListener('abort', () => stream.error(options.signal.reason), { once: true });
      },
    })));
    try {
      const pending = invoke();
      await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledOnce());
      expect(timeout).toHaveBeenCalledWith(8_000);
      controller.abort(new DOMException('Timed out', 'TimeoutError'));
      expect((await pending).status).toBe(502);
    } finally {
      timeout.mockRestore();
    }
  });
});
