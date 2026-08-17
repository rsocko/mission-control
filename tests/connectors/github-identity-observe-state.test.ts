import { describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';
import type { ExternalIdentityObservation } from '@/lib/external-identities';

process.env.LOG_LEVEL = 'silent';

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn() })) })),
  },
}));

const config: ConnectorConfig = {
  id: 'github-observe',
  type: 'github-issues',
  name: 'GitHub observe',
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

describe('GitHub identity observation state', () => {
  it('distinguishes partial and inaccessible issue fetches', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const partial = new GitHubIssuesConnector();
    await partial.initialize(config);
    const partialInternal = partial as unknown as {
      projectsSync: {
        fetchProjectTaskContext: () => Promise<{
          metadataBySourceId: Map<string, unknown>;
          draftTasks: never[];
        }>;
      };
      fetchIssuesFromRepo: () => AsyncGenerator<never[]>;
    };
    partialInternal.projectsSync.fetchProjectTaskContext = async () => ({
      metadataBySourceId: new Map(),
      draftTasks: [],
    });
    partialInternal.fetchIssuesFromRepo = async function* () {
      yield [];
      throw new Error('second page failed');
    };
    const partialPages = partial.fetchTasks();
    expect((await partialPages.next()).value).toEqual([]);
    expect((await partialPages.next()).done).toBe(true);
    expect(partial.getIdentityObservationState()).toEqual([{
      sourceId: 'acme/app',
      state: 'partial',
      reasonCode: 'issue_fetch_failed',
    }]);

    const inaccessible = new GitHubIssuesConnector();
    await inaccessible.initialize(config);
    const inaccessibleInternal = inaccessible as unknown as typeof partialInternal;
    inaccessibleInternal.projectsSync.fetchProjectTaskContext = partialInternal.projectsSync.fetchProjectTaskContext;
    inaccessibleInternal.fetchIssuesFromRepo = async function* () {
      throw new Error('first page failed');
    };
    expect((await inaccessible.fetchTasks().next()).done).toBe(true);
    expect(inaccessible.getIdentityObservationState()).toEqual([{
      sourceId: 'acme/app',
      state: 'inaccessible',
      reasonCode: 'issue_fetch_failed',
    }]);
  });

  it('carries trusted issue node IDs into Projects V2 association evidence', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const repositoryEvidence: ExternalIdentityObservation = {
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'repository',
        stableId: 'R_project_repo',
      },
      locator: { owner: 'acme', repository: 'app' },
      observationSource: 'graphql',
      observedAt: '2026-08-10T00:00:00.000Z',
    };
    const internal = connector as unknown as {
      repositoryEvidenceBySourceId: Map<string, ExternalIdentityObservation>;
      projectsSync: {
        fetchProjectsV2: () => Promise<Array<{
          id: string;
          number: number;
          title: string;
          shortDescription: string | null;
          url: string;
        }>>;
        fetchProjectItemsForProject: () => Promise<{
          items: Array<{
            id: string;
            content: {
              __typename: 'Issue';
              id: string;
              number: number;
              title: string;
              body: string;
              state: string;
              createdAt: string;
              updatedAt: string;
              closedAt: null;
              url: string;
              repository: { nameWithOwner: string };
            };
            fieldValues: { nodes: never[] };
          }>;
          state: 'complete';
        }>;
      };
      fetchRepoTaskPages: () => AsyncGenerator<never[]>;
    };
    internal.repositoryEvidenceBySourceId.set('acme/app', repositoryEvidence);
    internal.projectsSync.fetchProjectsV2 = async () => [{
      id: 'P_project_7',
      number: 7,
      title: 'Roadmap',
      shortDescription: null,
      url: 'https://github.com/orgs/acme/projects/7',
    }];
    internal.projectsSync.fetchProjectItemsForProject = async () => ({
      items: [{
        id: 'project-item-1',
        content: {
          __typename: 'Issue',
          id: 'I_project_issue',
          number: 42,
          title: 'Project issue',
          body: '',
          state: 'OPEN',
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:00.000Z',
          closedAt: null,
          url: 'https://github.com/acme/app/issues/42',
          repository: { nameWithOwner: 'acme/app' },
        },
        fieldValues: { nodes: [] },
      }],
      state: 'complete',
    });
    internal.fetchRepoTaskPages = async function* () {};

    expect((await connector.fetchTasks().next()).done).toBe(true);
    expect(await connector.fetchProjectAssociations()).toMatchObject([{
      project: { id: 'P_project_7', number: 7 },
      membershipState: 'complete',
      taskSourceIds: ['acme/app:42'],
      taskIdentityEvidence: [{
        sourceId: 'acme/app:42',
        evidence: {
          repository: {
            identity: {
              hostKey: 'github.com',
              stableId: 'R_project_repo',
            },
          },
          entity: {
            identity: {
              hostKey: 'github.com',
              entityType: 'issue',
              stableId: 'I_project_issue',
            },
          },
        },
      }],
    }]);
  });

  it('marks project membership incomplete when pagination fails', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const internal = connector as unknown as {
      projectsSync: {
        projectOwnerMap: Map<string, { type: 'organization'; login: string }>;
        fetchProjectItemsForProject: (
          context: {
            client: { graphqlFetchAny: ReturnType<typeof vi.fn> };
            repos: string[];
            connectorId: string;
            connectorType: string;
            repositoryEvidenceBySourceId: Map<string, ExternalIdentityObservation>;
          },
          project: { id: string; number: number },
        ) => Promise<{
          items: Array<{ id: string }>;
          state: 'complete' | 'partial' | 'inaccessible';
        }>;
      };
      client: {
        graphqlFetchAny: ReturnType<typeof vi.fn>;
      };
    };
    internal.projectsSync.projectOwnerMap.set('P_project_7', { type: 'organization', login: 'acme' });
    internal.client.graphqlFetchAny = vi.fn()
      .mockResolvedValueOnce({
        data: {
          organization: {
            projectV2: {
              items: {
                pageInfo: { hasNextPage: true, endCursor: 'next-page' },
                nodes: [{ id: 'project-item-1' }],
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        errors: [{ type: 'RATE_LIMITED' }],
      });

    await expect(internal.projectsSync.fetchProjectItemsForProject({
      client: internal.client,
      repos: [],
      connectorId: config.id,
      connectorType: config.type,
      repositoryEvidenceBySourceId: new Map(),
    }, {
      id: 'P_project_7',
      number: 7,
    })).resolves.toEqual({
      items: [{ id: 'project-item-1' }],
      state: 'partial',
    });
  });

  it('marks complete pagination partial when project item content is redacted', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(config);
    const internal = connector as unknown as {
      projectsSync: {
        fetchProjectsV2: () => Promise<Array<{
          id: string;
          number: number;
          title: string;
          shortDescription: null;
          url: string;
        }>>;
        fetchProjectItemsForProject: () => Promise<{
          items: Array<{
            id: string;
            content: null;
            fieldValues: { nodes: never[] };
          }>;
          state: 'complete';
        }>;
      };
      fetchRepoTaskPages: () => AsyncGenerator<never[]>;
    };
    internal.projectsSync.fetchProjectsV2 = async () => [{
      id: 'P_redacted',
      number: 8,
      title: 'Redacted',
      shortDescription: null,
      url: 'https://github.com/orgs/acme/projects/8',
    }];
    internal.projectsSync.fetchProjectItemsForProject = async () => ({
      items: [{
        id: 'project-item-redacted',
        content: null,
        fieldValues: { nodes: [] },
      }],
      state: 'complete',
    });
    internal.fetchRepoTaskPages = async function* () {};

    await expect(connector.fetchTasks().next()).rejects.toThrow(
      'membership observation is partial',
    );
    expect(await connector.fetchProjectAssociations()).toMatchObject([{
      project: { id: 'P_redacted', number: 8 },
      membershipState: 'partial',
      taskSourceIds: [],
    }]);
  });
});
