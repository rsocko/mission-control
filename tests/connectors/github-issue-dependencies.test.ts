import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFencedGitHubWrite } from '../fixtures/github-write-fence';
import type {
  ConnectorConfig,
  SourceTaskDependencyGenerationWriter,
  SourceTaskDependencySnapshot,
} from '@/types';

vi.unmock('crypto');

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

vi.mock('@/lib/external-identities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/external-identities')>();
  return {
    ...actual,
    getGitHubIdentityModeSnapshot: () => ({
      revision: 1,
    }),
  };
});

const config: ConnectorConfig = {
  id: 'github-1',
  type: 'github-issues',
  name: 'GitHub',
  enabled: true,
  syncMode: 'manual',
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
    dependencyRead: true,
    dependencyWrite: true,
  },
  credentials: { token: 'test-token' },
  settings: { repos: ['acme/app'] },
  syncedLists: ['acme/app'],
};

function githubIssue(repo: string, number: number, id: number) {
  return {
    id,
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    created_at: '2026-07-30T00:00:00.000Z',
    updated_at: '2026-07-30T00:00:00.000Z',
    closed_at: null,
    html_url: `https://github.com/${repo}/issues/${number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    labels: [],
  };
}

function graphQLIssue(
  number: number,
  blockers: Array<{ repo: string; number: number }> = [],
  hasNextPage = false,
) {
  return {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'OPEN',
    stateReason: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    updatedAt: '2026-07-30T00:00:00.000Z',
    closedAt: null,
    url: `https://github.com/acme/app/issues/${number}`,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    milestone: null,
    parent: null,
    subIssues: { nodes: [] },
    blockedBy: {
      totalCount: blockers.length + (hasNextPage ? 1 : 0),
      pageInfo: { hasNextPage, endCursor: hasNextPage ? 'cursor-100' : null },
      nodes: blockers.map((blocker) => ({
        id: `I_${blocker.repo}_${blocker.number}`,
        number: blocker.number,
        url: `https://github.com/${blocker.repo}/issues/${blocker.number}`,
        repository: {
          id: `R_${blocker.repo}`,
          nameWithOwner: blocker.repo,
          url: `https://github.com/${blocker.repo}`,
        },
      })),
    },
  };
}

function projectDiscoveryResponse(query: string) {
  if (query.includes('viewer {')) {
    return {
      data: {
        viewer: {
          login: 'octocat',
          projectsV2: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [],
          },
        },
      },
    };
  }
  if (query.includes('organization(login:')) {
    return { data: { organization: null } };
  }
  return {
    data: {
      repository: {
        projectsV2: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [],
        },
      },
    },
  };
}

function generationWriter(
  failureMode?: SourceTaskDependencyGenerationWriter['failureMode'],
) {
  const pages: SourceTaskDependencySnapshot[] = [];
  const writer: SourceTaskDependencyGenerationWriter = {
    failureMode,
    stagePage: vi.fn(async (snapshot) => {
      pages.push(snapshot);
    }),
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
  };
  return { pages, writer };
}

describe('GitHub issue dependencies', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('stages repository-qualified GraphQL edges with empty issues in one issue-page request', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url !== 'https://api.github.com/graphql') {
        throw new Error(`Unexpected REST request: ${url}`);
      }
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (!query.includes('issues(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                graphQLIssue(10, [
                  { repo: 'other/repo', number: 7 },
                  { repo: 'ACME/APP', number: 8 },
                ]),
                graphQLIssue(11),
              ],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const generation = generationWriter();

    const tasks = [];
    for await (const page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      tasks.push(...page);
    }

    expect(tasks.map((task) => task.sourceId)).toEqual(['acme/app:10', 'acme/app:11']);
    expect(generation.pages).toHaveLength(1);
    expect(generation.pages[0]).toMatchObject({
      dependencies: [{
        blockerSourceId: 'other/repo:7',
        blockedSourceId: 'acme/app:10',
        blockerIdentityEvidenceState: 'verified',
        blockerIdentityEvidence: {
          entity: {
            identity: { stableId: 'I_other/repo_7' },
          },
          repository: {
            identity: { stableId: 'R_other/repo' },
          },
        },
      }, {
        blockerSourceId: 'acme/app:8',
        blockedSourceId: 'acme/app:10',
        blockerIdentityEvidenceState: 'verified',
      }],
      completeBlockedSourceIds: ['acme/app:10', 'acme/app:11'],
      blockedIdentityEvidence: [
        expect.objectContaining({
          sourceId: 'acme/app:10',
          state: 'verified',
          evidence: expect.objectContaining({
            entity: expect.objectContaining({
              identity: expect.objectContaining({ stableId: 'I_10' }),
            }),
          }),
        }),
        expect.objectContaining({
          sourceId: 'acme/app:11',
          state: 'verified',
        }),
      ],
    });
    expect(generation.writer.stagePage).toHaveBeenCalledWith(
      expect.any(Object),
      'graphql-bulk',
    );
    expect(generation.writer.complete).toHaveBeenCalledWith('graphql-bulk');
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes('blockedBy(first: 100)'))).toHaveLength(1);
  });

  it('keeps configured source IDs for cross-repository blockers after repository renames', async () => {
    let dependencyCanonicalRepository = 'modern/dependency';
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/repos/legacy/dependency')) {
        return new Response(JSON.stringify({
          id: 2,
          node_id: 'R_dependency',
          full_name: dependencyCanonicalRepository,
          html_url: `https://github.com/${dependencyCanonicalRepository}`,
        }), { status: 200 });
      }
      if (url !== 'https://api.github.com/graphql') {
        throw new Error(`Unexpected REST request: ${url}`);
      }
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { owner?: string; name?: string };
      };
      if (!query.includes('issues(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      const dependencyRepository = variables?.name === 'dependency';
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: dependencyRepository ? 'R_dependency' : 'R_app',
            nameWithOwner: dependencyRepository ? dependencyCanonicalRepository : 'acme/app',
            url: dependencyRepository
              ? `https://github.com/${dependencyCanonicalRepository}`
              : 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: dependencyRepository
                ? []
                : [graphQLIssue(10, [{
                  repo: dependencyCanonicalRepository,
                  number: 7,
                }])],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      ...config,
      settings: { repos: ['legacy/app', 'legacy/dependency'] },
      syncedLists: ['legacy/app', 'legacy/dependency'],
    });
    const generation = generationWriter();
    const tasks = [];

    for await (const page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      tasks.push(...page);
    }

    expect(tasks.map((task) => task.sourceId)).toEqual(['legacy/app:10']);
    expect(generation.pages.flatMap((page) => page.dependencies)).toEqual([
      expect.objectContaining({
        blockerSourceId: 'legacy/dependency:7',
        blockedSourceId: 'legacy/app:10',
        blockerIdentityEvidenceState: 'verified',
        blockerIdentityEvidence: expect.objectContaining({
          entity: expect.objectContaining({
            identity: expect.objectContaining({
              hostKey: 'github.com',
              stableId: 'I_modern/dependency_7',
            }),
            locator: expect.objectContaining({
              owner: 'modern',
              repository: 'dependency',
              issueNumber: 7,
            }),
          }),
        }),
      }),
    ]);

    dependencyCanonicalRepository = 'newer/dependency';
    const nextGeneration = generationWriter();
    for await (const _page of connector.fetchTasks(undefined, {
      dependencyGeneration: nextGeneration.writer,
    })) {
      void _page;
    }
    expect(nextGeneration.pages.flatMap((page) => page.dependencies)).toEqual([
      expect.objectContaining({
        blockerSourceId: 'legacy/dependency:7',
        blockedSourceId: 'legacy/app:10',
        blockerIdentityEvidenceState: 'verified',
        blockerIdentityEvidence: expect.objectContaining({
          entity: expect.objectContaining({
            identity: expect.objectContaining({
              hostKey: 'github.com',
              stableId: 'I_newer/dependency_7',
            }),
            locator: expect.objectContaining({
              owner: 'newer',
              repository: 'dependency',
              issueNumber: 7,
            }),
          }),
        }),
      }),
    ]);
  });

  it('does not complete dependency snapshots when a configured repository alias is unresolved', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/repos/legacy/dependency')) {
        return new Response(null, { status: 404 });
      }
      if (url !== 'https://api.github.com/graphql') {
        throw new Error(`Unexpected REST request: ${url}`);
      }
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { name?: string };
      };
      if (!query.includes('issues(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      if (variables?.name === 'dependency') {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return new Response(JSON.stringify({
          data: {
            repository: {
              id: 'R_dependency',
              nameWithOwner: 'modern/dependency',
              url: 'https://github.com/modern/dependency',
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [],
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQLIssue(10, [{ repo: 'modern/dependency', number: 7 }])],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      ...config,
      settings: { repos: ['legacy/app', 'legacy/dependency'] },
      syncedLists: ['legacy/app', 'legacy/dependency'],
    });
    const generation = generationWriter();

    await expect(async () => {
      for await (const _page of connector.fetchTasks(undefined, {
        dependencyGeneration: generation.writer,
      })) {
        void _page;
      }
    }).rejects.toThrow('Cannot resolve GitHub dependency repository aliases');
    expect(generation.writer.complete).not.toHaveBeenCalled();
    expect(generation.writer.fail.mock.calls.some(
      ([error]) => error instanceof Error
        && error.message ===
          'Cannot resolve GitHub dependency repository aliases for: legacy/dependency',
    )).toBe(true);
  });

  it('scales dependency reads with repository pages instead of 1,257 issues', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url !== 'https://api.github.com/graphql') {
        throw new Error(`Unexpected REST request: ${url}`);
      }
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { cursor?: string };
      };
      if (!query.includes('issues(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      const page = variables?.cursor
        ? Number(variables.cursor.replace('page-', ''))
        : 0;
      const pageStart = page * 50;
      const pageSize = Math.min(50, 1257 - pageStart);
      const hasNextPage = pageStart + pageSize < 1257;
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: {
                hasNextPage,
                endCursor: hasNextPage ? `page-${page + 1}` : null,
              },
              nodes: Array.from(
                { length: pageSize },
                (_, index) => graphQLIssue(pageStart + index + 1),
              ),
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const generation = generationWriter();

    for await (const _page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      void _page;
    }

    expect(generation.pages.reduce(
      (count, page) => count + page.completeBlockedSourceIds.length,
      0,
    )).toBe(1257);
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes('issues('))).toHaveLength(26);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/dependencies/blocked_by'))).toHaveLength(0);
  });

  it('targets GraphQL overflow pagination only for an issue with more than 100 blockers', async () => {
    const firstBlockers = Array.from({ length: 100 }, (_, index) => ({
      repo: 'acme/dependency',
      number: index + 1,
    }));
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (!query.includes('blockedBy(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      if (query.includes('issue(number: $number)')) {
        return new Response(JSON.stringify({
          data: {
            repository: {
              id: 'R_app',
              nameWithOwner: 'acme/app',
              url: 'https://github.com/acme/app',
              issue: {
                number: 200,
                blockedBy: {
                  totalCount: 101,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    id: 'I_overflow',
                    number: 101,
                     url: 'https://github.com/other/repo/issues/101',
                     repository: {
                       id: 'R_other',
                       nameWithOwner: 'other/repo',
                       url: 'https://github.com/other/repo',
                     },
                  }],
                },
              },
            },
          },
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [graphQLIssue(200, firstBlockers, true)],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const generation = generationWriter();

    for await (const _page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      void _page;
    }

    expect(generation.pages[0].dependencies).toHaveLength(101);
    expect(generation.pages[0].dependencies[100]).toMatchObject({
      blockerSourceId: 'other/repo:101',
      blockedSourceId: 'acme/app:200',
      blockerIdentityEvidenceState: 'verified',
    });
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes('blockedBy('))).toHaveLength(2);
  });

  it('does not add project drafts to dependency discovery', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const { query } = JSON.parse(String(init?.body)) as { query: string };
      if (query.includes('items(first: 50')) {
        return new Response(JSON.stringify({
          data: {
            user: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [{
                    id: 'PVTI_draft',
                    type: 'DRAFT_ISSUE',
                    fieldValues: { nodes: [] },
                    content: {
                      __typename: 'DraftIssue',
                      title: 'Draft task',
                      body: '',
                      createdAt: '2026-07-30T00:00:00.000Z',
                      updatedAt: '2026-07-30T00:00:00.000Z',
                    },
                  }],
                },
              },
            },
          },
        }), { status: 200 });
      }
      if (query.includes('viewer {')) {
        return new Response(JSON.stringify({
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'PVT_1',
                  number: 1,
                  title: 'Roadmap',
                  shortDescription: null,
                  url: 'https://github.com/users/octocat/projects/1',
                  closed: false,
                  items: { totalCount: 1 },
                }],
              },
            },
          },
        }), { status: 200 });
      }
      if (query.includes('organization(login:')) {
        return new Response(JSON.stringify({ data: { organization: null } }), { status: 200 });
      }
      if (query.includes('projectsV2(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const generation = generationWriter();
    const tasks = [];

    for await (const page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      tasks.push(...page);
    }

    expect(tasks).toHaveLength(1);
    expect(tasks[0].sourceId).toContain(':draft:');
    expect(generation.pages).toEqual([{
      dependencies: [],
      completeBlockedSourceIds: [],
      blockedIdentityEvidence: [],
    }]);
    expect(fetchMock.mock.calls.filter(([, init]) =>
      String(init?.body).includes('blockedBy('))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/dependencies/blocked_by'))).toHaveLength(0);
  });

  it('uses per-issue REST reads only when GHES lacks the GraphQL dependency field', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/graphql')) {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        if (!query.includes('issues(')) {
          return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
        }
        if (query.includes('blockedBy(')) {
          return new Response(JSON.stringify({
            errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          data: {
            repository: {
              id: 'R_app',
              nameWithOwner: 'acme/app',
              url: 'https://ghe.example/acme/app',
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  ...graphQLIssue(20),
                  url: 'https://ghe.example/acme/app/issues/20',
                  parent: {
                    id: 'I_parent',
                    number: 10,
                    title: 'Parent issue',
                    url: 'https://ghe.example/acme/app/issues/10',
                    repository: { nameWithOwner: 'acme/app' },
                  },
                }],
              },
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/repos/acme/app')) {
        return new Response(JSON.stringify({
          id: 1,
          node_id: 'R_app',
          full_name: 'acme/app',
          html_url: 'https://ghe.example/acme/app',
        }), { status: 200 });
      }
      if (url.includes('/issues?state=all')) {
        return new Response(JSON.stringify([githubIssue('acme/app', 20, 5020)]), {
          status: 200,
        });
      }
      if (url.includes('/issues/20/dependencies/blocked_by')) {
        return new Response(JSON.stringify([githubIssue('other/repo', 3, 5003)]), {
          status: 200,
        });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      ...config,
      settings: { repos: ['acme/app'], apiOrigin: 'https://ghe.example' },
    });
    const generation = generationWriter();
    const tasks = [];

    for await (const page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      tasks.push(...page);
    }

    expect(tasks).toHaveLength(1);
    const issueQueries = fetchMock.mock.calls
      .filter(([input]) => String(input).endsWith('/graphql'))
      .map(([, init]) => JSON.parse(String(init?.body)) as { query: string })
      .filter(({ query }) => query.includes('issues('));
    expect(issueQueries).toHaveLength(2);
    expect(issueQueries[1].query).not.toContain('blockedBy(');
    expect(tasks[0].metadata.githubParent).toMatchObject({
      sourceId: 'acme/app:10',
      repository: 'acme/app',
    });
    expect(generation.pages).toEqual([{
      dependencies: [{
        blockerSourceId: 'other/repo:3',
        blockedSourceId: 'acme/app:20',
        blockerIdentityEvidenceState: 'missing',
      }],
      completeBlockedSourceIds: ['acme/app:20'],
      blockedIdentityEvidence: [{
        sourceId: 'acme/app:20',
        state: 'missing',
      }],
    }]);
    expect(generation.writer.complete).toHaveBeenCalledWith('rest-fallback');
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/dependencies/blocked_by'))).toHaveLength(1);
    expect(fetchMock.mock.calls.filter(([input]) =>
      String(input).includes('/issues?state=all'))).toHaveLength(0);
  });

  it('normalizes renamed cross-repository blockers in the GHES REST fallback', async () => {
    const fetchMock = vi.fn(async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(input);
      if (url.endsWith('/graphql')) {
        const { query, variables } = JSON.parse(String(init?.body)) as {
          query: string;
          variables?: { name?: string };
        };
        if (!query.includes('issues(')) {
          return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
        }
        if (query.includes('blockedBy(')) {
          return new Response(JSON.stringify({
            errors: [{ message: "Field 'blockedBy' doesn't exist on type 'Issue'" }],
          }), { status: 200 });
        }
        const dependencyRepository = variables?.name === 'dependency';
        return new Response(JSON.stringify({
          data: {
            repository: {
              id: dependencyRepository ? 'R_dependency' : 'R_app',
              nameWithOwner: dependencyRepository ? 'modern/dependency' : 'acme/app',
              url: dependencyRepository
                ? 'https://ghe.example/modern/dependency'
                : 'https://ghe.example/acme/app',
              issues: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: dependencyRepository ? [] : [graphQLIssue(20)],
              },
            },
          },
        }), { status: 200 });
      }
      if (url.endsWith('/repos/legacy/app')) {
        return new Response(JSON.stringify({
          id: 1,
          node_id: 'R_app',
          full_name: 'acme/app',
          html_url: 'https://ghe.example/acme/app',
        }), { status: 200 });
      }
      if (url.endsWith('/repos/legacy/dependency')) {
        return new Response(JSON.stringify({
          id: 2,
          node_id: 'R_dependency',
          full_name: 'modern/dependency',
          html_url: 'https://ghe.example/modern/dependency',
        }), { status: 200 });
      }
      if (url.includes('/repos/legacy/app/issues?state=all')) {
        return new Response(JSON.stringify([githubIssue('acme/app', 20, 5020)]), {
          status: 200,
        });
      }
      if (url.includes('/repos/legacy/dependency/issues?state=all')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.includes('/issues/20/dependencies/blocked_by')) {
        return new Response(JSON.stringify([
          githubIssue('modern/dependency', 3, 5003),
        ]), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      ...config,
      settings: {
        repos: ['legacy/app', 'legacy/dependency'],
        apiOrigin: 'https://ghe.example',
      },
      syncedLists: ['legacy/app', 'legacy/dependency'],
    });
    const generation = generationWriter();

    for await (const _page of connector.fetchTasks(undefined, {
      dependencyGeneration: generation.writer,
    })) {
      void _page;
    }

    expect(generation.pages.flatMap((page) => page.dependencies)).toEqual([{
      blockerSourceId: 'legacy/dependency:3',
      blockedSourceId: 'legacy/app:20',
      blockerIdentityEvidenceState: 'missing',
    }]);
    expect(generation.writer.complete).toHaveBeenCalledWith('rest-fallback');
  });

  it('never completes a generation after a partial GraphQL page failure', async () => {
    const fetchMock = vi.fn(async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const { query, variables } = JSON.parse(String(init?.body)) as {
        query: string;
        variables?: { cursor?: string };
      };
      if (!query.includes('issues(')) {
        return new Response(JSON.stringify(projectDiscoveryResponse(query)), { status: 200 });
      }
      if (variables?.cursor) {
        return new Response(JSON.stringify({
          errors: [{ message: 'Repository access denied' }],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: {
          repository: {
            id: 'R_app',
            nameWithOwner: 'acme/app',
            url: 'https://github.com/acme/app',
            issues: {
              pageInfo: { hasNextPage: true, endCursor: 'page-2' },
              nodes: [graphQLIssue(1)],
            },
          },
        },
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const generation = generationWriter();

    const consume = async () => {
      for await (const _page of connector.fetchTasks(undefined, {
        dependencyGeneration: generation.writer,
      })) {
        void _page;
      }
    };

    await expect(consume()).rejects.toThrow('Repository access denied');
    expect(generation.writer.stagePage).toHaveBeenCalledTimes(1);
    expect(generation.writer.complete).not.toHaveBeenCalled();
    expect(generation.writer.fail).toHaveBeenCalled();

    const targetedConnector = new GitHubIssuesConnector();
    await targetedConnector.initialize(config);
    const targeted = generationWriter('best-effort');
    const taskPages = [];
    for await (const page of targetedConnector.fetchTasks(undefined, {
      dependencyGeneration: targeted.writer,
    })) {
      taskPages.push(page);
    }
    expect(taskPages).toHaveLength(1);
    expect(targeted.writer.complete).toHaveBeenCalled();
    expect(targeted.writer.fail).not.toHaveBeenCalled();
  });

  it('reads paginated blocked-by edges with normalized direction', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      githubIssue('acme/dependency', index + 1, index + 1000));
    const secondPage = [githubIssue('other/repo', 101, 1101)];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes('page=2') ? secondPage : firstPage), {
        status: 200,
      });

    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    const dependencies = await connector.fetchTaskDependencies(['acme/app:200']);

    expect(dependencies.dependencies).toHaveLength(101);
    expect(dependencies.dependencies[100]).toEqual({
      blockerSourceId: 'other/repo:101',
      blockedSourceId: 'acme/app:200',
    });
    expect(dependencies.completeBlockedSourceIds).toEqual(['acme/app:200']);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('blocked_by?per_page=100&page=2'),
      expect.any(Object),
    );
  });

  it('adds the blocker to the blocked issue and is idempotent', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.includes('/dependencies/blocked_by?')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/repos/acme/app/issues/10')) {
        return new Response(JSON.stringify(githubIssue('acme/app', 10, 5010)), { status: 200 });
      }
      return new Response(null, { status: 201       });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await runFencedDependencyWrite(connector, () =>
      connector.addTaskDependency('acme/app:10', 'acme/app:20'));

    const post = calls.find((call) => call.init?.method === 'POST');
    expect(post?.url).toContain('/repos/acme/app/issues/20/dependencies/blocked_by');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ issue_id: 5010 });

    calls.length = 0;
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify([githubIssue('acme/app', 10, 5010)]), { status: 200 }));
    await runFencedDependencyWrite(connector, () =>
      connector.addTaskDependency('acme/app:10', 'acme/app:20'));
    expect(calls.filter((call) => call.init?.method === 'POST')).toHaveLength(0);
  });

  it('ignores non-native GitHub source IDs without dependency requests', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await expect(connector.fetchTaskDependencies([
      'project:1:draft:PVTI_1',
      'checklist:acme/app:1:item',
    ])).resolves.toEqual({
      dependencies: [],
      completeBlockedSourceIds: [],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('removes an existing edge and treats an absent edge as removed', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return new Response(JSON.stringify([githubIssue('acme/app', 10, 5010)]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await runFencedDependencyWrite(connector, () =>
      connector.removeTaskDependency('acme/app:10', 'acme/app:20'));
    expect(calls.find((call) => call.init?.method === 'DELETE')?.url)
      .toContain('/issues/20/dependencies/blocked_by/5010');

    calls.length = 0;
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify([]), { status: 200 }));
    await runFencedDependencyWrite(connector, () =>
      connector.removeTaskDependency('acme/app:10', 'acme/app:20'));
    expect(calls.filter((call) => call.init?.method === 'DELETE')).toHaveLength(0);
  });

  it('surfaces dependency permission failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })));
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await expect(connector.fetchTaskDependencies(['acme/app:20']))
      .rejects.toThrow('403');
  });

  it('isolates deleted issues without hiding permission failures', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/issues/20/')) {
        return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
      }
      return new Response(JSON.stringify([githubIssue('acme/app', 10, 5010)]), {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await expect(connector.fetchTaskDependencies(['acme/app:20', 'acme/app:30']))
      .resolves.toEqual({
        dependencies: [{
          blockerSourceId: 'acme/app:10',
          blockedSourceId: 'acme/app:30',
        }],
        completeBlockedSourceIds: ['acme/app:30'],
      });
  });

  it('stops scheduling dependency reads after a fatal response', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/issues/1/')) {
        return new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 });
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      return new Response(JSON.stringify([]), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await expect(connector.fetchTaskDependencies(
      Array.from({ length: 20 }, (_, index) => `acme/app:${index + 1}`),
    )).rejects.toThrow('403');
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(5);
  });

  it('aborts dependency reads when the snapshot signal is cancelled', async () => {
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const controller = new AbortController();

    const snapshot = connector.fetchTaskDependencies(
      ['acme/app:20'],
      { signal: controller.signal },
    );
    controller.abort(new Error('snapshot cancelled'));

    await expect(snapshot).rejects.toThrow('snapshot cancelled');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out an unresponsive GitHub dependency request', async () => {
    process.env.MC_GITHUB_REQUEST_TIMEOUT_MS = '5';
    const fetchMock = vi.fn((
      _input: string | URL | Request,
      init?: RequestInit,
    ) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    await expect(connector.fetchTaskDependencies(['acme/app:20']))
      .rejects.toThrow('GitHub request timed out after 5ms');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    delete process.env.MC_GITHUB_REQUEST_TIMEOUT_MS;
  });
});

function runFencedDependencyWrite<T>(
  connector: Parameters<typeof runFencedGitHubWrite>[0],
  write: () => Promise<T>,
): Promise<T> {
  return runFencedGitHubWrite(connector, {
    connectorInstanceId: 'github-1',
    taskId: 'task-10',
    owner: 'acme',
    repository: 'app',
    issueNumber: 10,
    operation: 'dependency',
    targets: [
      { role: 'primary_issue', owner: 'acme', repository: 'app', issueNumber: 20 },
      { role: 'blocker_issue', owner: 'acme', repository: 'app', issueNumber: 10 },
      { role: 'source_repository', owner: 'acme', repository: 'app', issueNumber: null },
    ],
  }, write);
}
