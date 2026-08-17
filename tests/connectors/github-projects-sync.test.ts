import { describe, expect, it, vi } from 'vitest';
import type { ExternalIdentityObservation } from '@/lib/external-identities/types';
import type {
  GitHubClient,
  GraphQLAnyResponse,
  GitHubProjectV2,
} from '@/lib/connectors/github-issues/github-client';
import {
  GitHubProjectsSyncService,
  type GitHubProjectsSyncContext,
} from '@/lib/connectors/github-issues/projects-sync-service';

vi.unmock('crypto');

/** Minimal trusted-origin fixture matching the shape produced by identity.ts. */
const origin = {
  hostKey: 'github.com',
  restBaseUrl: 'https://api.github.com',
  graphqlUrl: 'https://api.github.com/graphql',
};

/**
 * Builds a fake `GitHubClient` whose `graphqlFetchAny` is a router keyed off
 * distinguishing substrings in the query text, so each of the sync service's
 * internal queries (viewer / repo / org / project-items) can be scripted
 * independently and paginated deterministically.
 */
function createFakeClient(
  handlers: Partial<{
    viewer: (variables: Record<string, unknown>) => GraphQLAnyResponse;
    repo: (variables: Record<string, unknown>) => GraphQLAnyResponse;
    org: (variables: Record<string, unknown>) => GraphQLAnyResponse;
    items: (variables: Record<string, unknown>, query: string) => GraphQLAnyResponse;
  }>,
  restFetchImpl?: (path: string) => Promise<Response>,
): GitHubClient {
  const graphqlFetchAny = vi.fn(async (
    query: string,
    variables: Record<string, unknown> = {},
  ): Promise<GraphQLAnyResponse> => {
    if (query.includes('viewer {') && handlers.viewer) return handlers.viewer(variables);
    if (query.includes('repository(owner:') && handlers.repo) return handlers.repo(variables);
    if (query.includes('organization(login: $login)') && !query.includes('projectV2(number') && handlers.org) {
      return handlers.org(variables);
    }
    if (query.includes('projectV2(number: $projectNumber)') && handlers.items) return handlers.items(variables, query);
    return { data: {} };
  });

  return {
    origin,
    restFetch: restFetchImpl ?? (async () => new Response(JSON.stringify({ login: 'fallback-user' }), { status: 200 })),
    graphqlFetch: vi.fn(),
    graphqlFetchAny,
  };
}

function project(overrides: Partial<GitHubProjectV2> & { id: string; number: number }): GitHubProjectV2 {
  return {
    title: `Project ${overrides.number}`,
    shortDescription: null,
    url: `https://github.com/orgs/acme/projects/${overrides.number}`,
    closed: false,
    items: { totalCount: 0 },
    ...overrides,
  };
}

function baseContext(overrides: Partial<GitHubProjectsSyncContext> = {}): GitHubProjectsSyncContext {
  return {
    client: createFakeClient({}),
    repos: ['acme/app'],
    connectorId: 'github-1',
    connectorType: 'github-issues',
    repositoryEvidenceBySourceId: new Map<string, ExternalIdentityObservation>(),
    ...overrides,
  };
}

describe('GitHubProjectsSyncService', () => {
  it('paginates viewer, repo, and org project queries and dedupes repeated projects', async () => {
    const service = new GitHubProjectsSyncService();

    const client = createFakeClient({
      viewer: (vars) => {
        if (!vars.cursor) {
          return {
            data: {
              viewer: {
                login: 'octocat',
                projectsV2: {
                  pageInfo: { hasNextPage: true, endCursor: 'viewer-page-2' },
                  nodes: [project({ id: 'P_viewer_1', number: 1 }), project({ id: 'P_closed', number: 99, closed: true })],
                },
              },
            },
          };
        }
        expect(vars.cursor).toBe('viewer-page-2');
        return {
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [project({ id: 'P_viewer_2', number: 2 })],
              },
            },
          },
        };
      },
      repo: (vars) => {
        if (!vars.cursor) {
          return {
            data: {
              repository: {
                projectsV2: {
                  pageInfo: { hasNextPage: true, endCursor: 'repo-page-2' },
                  nodes: [
                    { ...project({ id: 'P_repo_1', number: 3 }), owner: { __typename: 'Organization', login: 'acme' } },
                  ],
                },
              },
            },
          };
        }
        expect(vars.cursor).toBe('repo-page-2');
        return {
          data: {
            repository: {
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                // Duplicate of a project already discovered via the viewer query —
                // must not produce a second association.
                nodes: [
                  { ...project({ id: 'P_viewer_1', number: 1 }), owner: { __typename: 'User', login: 'octocat' } },
                ],
              },
            },
          },
        };
      },
      org: () => ({
        data: {
          organization: {
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [project({ id: 'P_org_1', number: 4 })],
            },
          },
        },
      }),
      items: (_vars, query) => {
        const ownerField = query?.includes('organization(login: $login)') ? 'organization' : 'user';
        return {
          data: { [ownerField]: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } },
        };
      },
    });

    const context = baseContext({ client });
    const result = await service.fetchProjectTaskContext(context);

    expect(result.draftTasks).toEqual([]);
    const associations = service.getLastAssociations();
    // P_viewer_1, P_viewer_2, P_repo_1, P_org_1 — P_closed excluded (closed) and
    // the repo-query's duplicate of P_viewer_1 excluded (already seen).
    expect(associations.map((a) => a.project.id).sort()).toEqual([
      'P_org_1', 'P_repo_1', 'P_viewer_1', 'P_viewer_2',
    ]);
    expect(associations.every((a) => a.membershipState === 'complete')).toBe(true);
  });

  it('maps GraphQL Issue items into metadataBySourceId with identity evidence, marks partial on redacted content, and maps draft issues to tasks', async () => {
    const service = new GitHubProjectsSyncService();
    const repositoryEvidence: ExternalIdentityObservation = {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'repository',
        stableId: 'R_app',
      },
      locator: { owner: 'acme', repository: 'app' },
      observationSource: 'graphql',
      observedAt: '2026-08-10T00:00:00.000Z',
    };

    const client = createFakeClient({
      viewer: () => ({
        data: {
          viewer: {
            login: 'octocat',
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [project({ id: 'P_roadmap', number: 7, title: 'Roadmap' })],
            },
          },
        },
      }),
      repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
      org: () => ({ data: {} }),
      items: (vars) => {
        if (!vars.cursor) {
          return {
            data: {
              user: {
                projectV2: {
                  items: {
                    pageInfo: { hasNextPage: true, endCursor: 'items-page-2' },
                    nodes: [
                      {
                        id: 'item-issue-1',
                        type: 'ISSUE',
                        fieldValues: {
                          nodes: [
                            { __typename: 'ProjectV2ItemFieldSingleSelectValue', field: { name: 'Status' }, name: 'In Progress' },
                          ],
                        },
                        content: {
                          __typename: 'Issue',
                          id: 'I_42',
                          number: 42,
                          title: 'Project issue',
                          body: '',
                          state: 'OPEN',
                          createdAt: '2026-08-01T00:00:00.000Z',
                          updatedAt: '2026-08-02T00:00:00.000Z',
                          closedAt: null,
                          url: 'https://github.com/acme/app/issues/42',
                          repository: { nameWithOwner: 'acme/app' },
                        },
                      },
                      {
                        // Redacted item: no readable content — must flip membership to 'partial'.
                        id: 'item-redacted',
                        type: 'ISSUE',
                        fieldValues: { nodes: [] },
                        content: null,
                      },
                    ],
                  },
                },
              },
            },
          };
        }
        expect(vars.cursor).toBe('items-page-2');
        return {
          data: {
            user: {
              projectV2: {
                items: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: [
                    {
                      id: 'item-draft-1',
                      type: 'DRAFT_ISSUE',
                      fieldValues: { nodes: [] },
                      content: {
                        __typename: 'DraftIssue',
                        title: 'Draft idea',
                        body: 'notes',
                        createdAt: '2026-08-03T00:00:00.000Z',
                        updatedAt: '2026-08-03T00:00:00.000Z',
                      },
                    },
                  ],
                },
              },
            },
          },
        };
      },
    });

    const repositoryEvidenceBySourceId = new Map<string, ExternalIdentityObservation>([
      ['acme/app', repositoryEvidence],
    ]);
    const context = baseContext({ client, repositoryEvidenceBySourceId });
    const result = await service.fetchProjectTaskContext(context);

    // Issue item merged onto metadataBySourceId keyed by "<repo>:<issueNumber>".
    const metadata = result.metadataBySourceId.get('acme/app:42');
    expect(metadata).toEqual([{
      projectNumber: 7,
      projectTitle: 'Roadmap',
      sourceId: 'project:7',
      fields: { Status: 'In Progress' },
    }]);

    // Draft issue produced as a standalone task with no source repo.
    expect(result.draftTasks).toHaveLength(1);
    const draftTask = result.draftTasks[0];
    expect(draftTask.sourceId).toBe('project:7:draft:item-draft-1');
    expect(draftTask.sourceListId).toBeUndefined();
    expect(draftTask.title).toBe('Draft idea');
    expect(draftTask.metadata).toMatchObject({
      draftIssueId: 'item-draft-1',
      isDraft: true,
      githubProjects: [{ projectNumber: 7, projectTitle: 'Roadmap', sourceId: 'project:7' }],
    });

    const [association] = service.getLastAssociations();
    expect(association.project).toMatchObject({ id: 'P_roadmap', number: 7 });
    // Redacted item flips completeness to 'partial' even though pagination itself succeeded.
    expect(association.membershipState).toBe('partial');
    expect(association.taskSourceIds).toEqual(['acme/app:42', 'project:7:draft:item-draft-1']);
    expect(association.taskIdentityEvidence).toHaveLength(1);
    expect(association.taskIdentityEvidence[0]).toMatchObject({
      sourceId: 'acme/app:42',
      evidence: {
        repository: { identity: { hostKey: 'github.com', stableId: 'R_app' } },
        entity: {
          identity: { hostKey: 'github.com', entityType: 'issue', stableId: 'I_42' },
          locator: { owner: 'acme', repository: 'app', issueNumber: 42 },
        },
      },
    });
  });

  it('ignores items for repositories outside the configured repo list', async () => {
    const service = new GitHubProjectsSyncService();
    const client = createFakeClient({
      viewer: () => ({
        data: {
          viewer: {
            login: 'octocat',
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [project({ id: 'P_1', number: 1 })],
            },
          },
        },
      }),
      repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
      org: () => ({ data: {} }),
      items: () => ({
        data: {
          user: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [{
                  id: 'item-other-repo',
                  type: 'ISSUE',
                  fieldValues: { nodes: [] },
                  content: {
                    __typename: 'Issue',
                    id: 'I_other',
                    number: 5,
                    repository: { nameWithOwner: 'someone-else/other-repo' },
                  },
                }],
              },
            },
          },
        },
      }),
    });

    const result = await service.fetchProjectTaskContext(baseContext({ client }));
    expect(result.metadataBySourceId.size).toBe(0);
    // Item content was present and well-formed, just out of scope for this connector's repos.
    expect(service.getLastAssociations()[0].membershipState).toBe('complete');
    expect(service.getLastAssociations()[0].taskSourceIds).toEqual([]);
  });

  it('resets associations between fetchProjectTaskContext calls instead of accumulating', async () => {
    const service = new GitHubProjectsSyncService();
    let call = 0;
    const client = createFakeClient({
      viewer: () => {
        call += 1;
        return {
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: call === 1 ? [project({ id: 'P_first', number: 1 })] : [],
              },
            },
          },
        };
      },
      repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
      org: () => ({ data: {} }),
      items: () => ({ data: { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } }),
    });
    const context = baseContext({ client });

    await service.fetchProjectTaskContext(context);
    expect(service.getLastAssociations()).toHaveLength(1);

    await service.fetchProjectTaskContext(context);
    expect(service.getLastAssociations()).toHaveLength(0);
  });

  describe('fetchProjectItemsForProject pagination failure handling (via fetchProjectTaskContext)', () => {
    it('marks membership inaccessible when the very first page errors', async () => {
      const service = new GitHubProjectsSyncService();
      const client = createFakeClient({
        viewer: () => ({
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [project({ id: 'P_err', number: 9 })],
              },
            },
          },
        }),
        repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
        org: () => ({ data: {} }),
        items: () => ({ errors: [{ message: 'rate limited' }] }),
      });

      await service.fetchProjectTaskContext(baseContext({ client }));
      expect(service.getLastAssociations()[0].membershipState).toBe('inaccessible');
    });

    it('marks membership partial when pagination errors after some items were already collected', async () => {
      const service = new GitHubProjectsSyncService();
      let page = 0;
      const client = createFakeClient({
        viewer: () => ({
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [project({ id: 'P_partial', number: 10 })],
              },
            },
          },
        }),
        repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
        org: () => ({ data: {} }),
        items: () => {
          page += 1;
          if (page === 1) {
            return {
              data: {
                user: {
                  projectV2: {
                    items: {
                      pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
                      nodes: [{ id: 'item-1', type: 'ISSUE', fieldValues: { nodes: [] }, content: null }],
                    },
                  },
                },
              },
            };
          }
          return { errors: [{ message: 'secondary rate limit' }] };
        },
      });

      await service.fetchProjectTaskContext(baseContext({ client }));
      expect(service.getLastAssociations()[0].membershipState).toBe('partial');
    });

    it('marks membership partial when a page reports hasNextPage without an endCursor', async () => {
      const service = new GitHubProjectsSyncService();
      const client = createFakeClient({
        viewer: () => ({
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [project({ id: 'P_no_cursor', number: 11 })],
              },
            },
          },
        }),
        repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
        org: () => ({ data: {} }),
        items: () => ({
          data: {
            user: {
              projectV2: {
                items: {
                  // Malformed page: says there's more, but gives no cursor to continue from.
                  pageInfo: { hasNextPage: true, endCursor: null },
                  nodes: [],
                },
              },
            },
          },
        }),
      });

      await service.fetchProjectTaskContext(baseContext({ client }));
      expect(service.getLastAssociations()[0].membershipState).toBe('partial');
    });

    it('marks membership inaccessible when the owner connection is missing entirely', async () => {
      const service = new GitHubProjectsSyncService();
      const client = createFakeClient({
        viewer: () => ({
          data: {
            viewer: {
              login: 'octocat',
              projectsV2: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [project({ id: 'P_missing', number: 12 })],
              },
            },
          },
        }),
        repo: () => ({ data: { repository: { projectsV2: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } }),
        org: () => ({ data: {} }),
        items: () => ({ data: { user: null } }),
      });

      await service.fetchProjectTaskContext(baseContext({ client }));
      expect(service.getLastAssociations()[0].membershipState).toBe('inaccessible');
    });

    it('falls back to the authenticated user login via REST when no owner type was recorded', async () => {
      // fetchProjectTaskContext always records ownership via fetchProjectsV2's
      // addProjects(), so the REST fallback only triggers when
      // fetchProjectItemsForProject() is invoked directly for a project the
      // owner map has never seen — exercised here the same way the pagination
      // failure test above reaches this private method.
      const service = new GitHubProjectsSyncService();
      const restFetch = vi.fn(async () => new Response(JSON.stringify({ login: 'fallback-user' }), { status: 200 }));
      let capturedLogin: unknown;
      const client = createFakeClient({
        items: (vars) => {
          capturedLogin = vars.login;
          return { data: { user: { projectV2: { items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } };
        },
      }, restFetch);

      const internal = service as unknown as {
        fetchProjectItemsForProject: (
          context: GitHubProjectsSyncContext,
          project: { id: string; number: number },
        ) => Promise<{ items: unknown[]; state: string }>;
      };
      const result = await internal.fetchProjectItemsForProject(
        baseContext({ client }),
        { id: 'P_never_seen', number: 13 },
      );

      expect(restFetch).toHaveBeenCalledWith('/user');
      expect(capturedLogin).toBe('fallback-user');
      expect(result.state).toBe('complete');
    });
  });
});
