import { describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig, TaskItem } from '@/types';
import type { GraphQLIssue, GitHubClient } from '@/lib/connectors/github-issues/github-client';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: vi.fn(() => crypto.randomUUID()) };
});

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

const config: ConnectorConfig = {
  id: 'github-hierarchy',
  type: 'github-issues',
  name: 'GitHub hierarchy',
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
  },
  credentials: { token: 'test-token' },
  settings: { repos: ['acme/app', 'other/repo'] },
  syncedLists: ['acme/app', 'other/repo'],
};

function issue(
  number: number,
  parentRepository?: string,
): GraphQLIssue {
  return {
    id: `I_${number}`,
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'OPEN',
    stateReason: null,
    createdAt: '2026-08-09T00:00:00.000Z',
    updatedAt: '2026-08-09T00:00:00.000Z',
    closedAt: null,
    url: `https://github.com/acme/app/issues/${number}`,
    labels: { nodes: [] },
    assignees: { nodes: [] },
    milestone: null,
    parent: parentRepository
      ? {
          id: 'I_parent',
          number: 1,
          title: 'Parent',
          url: `https://github.com/${parentRepository}/issues/1`,
          repository: {
            id: `R_${parentRepository}`,
            nameWithOwner: parentRepository,
            url: `https://github.com/${parentRepository}`,
          },
        }
      : null,
  };
}

describe('GitHub sub-issue canonical ingestion', () => {
  it('qualifies cross-repository parents without assigning a temporary local parent', async () => {
    const { mapGraphQLIssueToTask } = await import(
      '@/lib/connectors/github-issues/issue-transformer'
    );
    const task = mapGraphQLIssueToTask(
      issue(42, 'other/repo'),
      'acme/app',
      'github-hierarchy',
    );

    expect(task.parentId).toBeUndefined();
    expect(task.depth).toBe(0);
    expect(task.childIds).toEqual([]);
    expect(task.metadata.githubParent).toEqual({
      sourceId: 'other/repo:1',
      repository: 'other/repo',
      issueNumber: 1,
      nodeId: 'I_parent',
      title: 'Parent',
      url: 'https://github.com/other/repo/issues/1',
    });
  });

  it('represents more than 20 children across issue pages without synthetic duplicates', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);

    const firstPage = [
      issue(1),
      ...Array.from({ length: 49 }, (_, index) => issue(index + 2, 'acme/app')),
    ];
    const secondPage = Array.from(
      { length: 6 },
      (_, index) => issue(index + 51, 'acme/app'),
    );
    const queries: string[] = [];
    const cursors: unknown[] = [];
    const client: GitHubClient = {
      origin: {
        hostKey: 'github.com',
        restBaseUrl: 'https://api.github.com',
        graphqlUrl: 'https://api.github.com/graphql',
      },
      restFetch: vi.fn(),
      graphqlFetch: vi.fn(async (query, variables) => {
        queries.push(query);
        cursors.push(variables?.cursor);
        const isSecondPage = variables?.cursor === 'page-2';
        return {
          data: {
            repository: {
              id: 'R_app',
              nameWithOwner: 'acme/app',
              url: 'https://github.com/acme/app',
              issues: {
                pageInfo: {
                  hasNextPage: !isSecondPage,
                  endCursor: isSecondPage ? '' : 'page-2',
                },
                nodes: isSecondPage ? secondPage : firstPage,
              },
            },
          },
        };
      }),
      graphqlFetchAny: vi.fn(),
    };
    const internal = connector as unknown as {
      client: GitHubClient;
      fetchIssuesFromRepo: (
        repo: string,
      ) => AsyncGenerator<TaskItem[]>;
    };
    internal.client = client;

    const tasks = [];
    for await (const page of internal.fetchIssuesFromRepo('acme/app')) {
      tasks.push(...page);
    }

    expect(tasks).toHaveLength(56);
    expect(new Set(tasks.map((task) => task.sourceId)).size).toBe(56);
    expect(tasks.filter((task) => task.metadata.githubParent)).toHaveLength(55);
    expect(tasks.filter((task) => task.githubParentIdentity)).toHaveLength(55);
    expect(queries[0]).toMatch(/repository\s*\{\s*id\s+nameWithOwner\s+url\s*\}/);
    expect(queries[0]).not.toContain('subIssues(');
    expect(cursors).toEqual([undefined, 'page-2']);
  });

  it('treats REST fallback and incomplete parent node metadata as ineligible observations', async () => {
    const {
      mapGraphQLIssueToTask,
      mapRestIssueToTask,
    } = await import('@/lib/connectors/github-issues/issue-transformer');
    const { readGitHubHierarchyObservation } = await import(
      '@/lib/sync/github-hierarchy-reconciliation'
    );
    const missingParentNode = issue(42, 'other/repo');
    missingParentNode.parent!.id = '';
    expect(readGitHubHierarchyObservation(mapGraphQLIssueToTask(
      missingParentNode,
      'acme/app',
      'github-hierarchy',
    ))).toEqual({
      kind: 'incomplete',
      reasonCode: 'sub_issue_parent_metadata_incomplete',
    });

    const restTask = mapRestIssueToTask({
      number: 42,
      title: 'REST fallback',
      body: '',
      state: 'open',
      state_reason: null,
      created_at: '2026-08-09T00:00:00.000Z',
      updated_at: '2026-08-09T00:00:00.000Z',
      closed_at: null,
      html_url: 'https://github.com/acme/app/issues/42',
      labels: [],
    }, 'acme/app', 'github-hierarchy');
    expect(readGitHubHierarchyObservation(restTask)).toEqual({
      kind: 'incomplete',
      reasonCode: 'sub_issue_graphql_evidence_unavailable',
    });
  });

  it('deduplicates identical hierarchy observations and rejects conflicting duplicates', async () => {
    const {
      mergeGitHubHierarchyObservation,
    } = await import('@/lib/sync/github-hierarchy-reconciliation');
    const observations = new Map();
    const first = {
      childSourceId: 'acme/app:42',
      parent: {
        sourceId: 'acme/app:1',
        repository: 'acme/app',
        issueNumber: 1,
        nodeId: 'I_parent',
        title: 'Parent',
        url: 'https://github.com/acme/app/issues/1',
      },
    };
    expect(mergeGitHubHierarchyObservation(observations, first)).toBe(true);
    expect(mergeGitHubHierarchyObservation(observations, { ...first })).toBe(true);
    expect(mergeGitHubHierarchyObservation(observations, {
      ...first,
      parent: null,
    })).toBe(false);
    expect(observations.size).toBe(1);
    expect(observations.get('acme/app:42')).toEqual(first);
  });
});
