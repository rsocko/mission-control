import { beforeAll, describe, expect, it, vi } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('@/db');
vi.unmock('@/db/schema');
vi.unmock('drizzle-orm');

describe('task transfer identity persistence', () => {
  beforeAll(() => {
    vi.resetModules();
  });

  it('binds a newly created issue and both repositories without a full sync', async () => {
    const [
      { default: db },
      schema,
      { reconcileTransferIdentity },
      { canTransferGitHubIssueSafely },
    ] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
      import('@/lib/connectors/github-issues/repoint-service'),
    ]);
    const now = '2026-08-09T20:00:00.000Z';
    await db.insert(schema.connectorConfigs).values({
      id: 'github-targeted',
      type: 'github-issues',
      name: 'GitHub',
      enabled: true,
      syncMode: 'poll',
      capabilities: { read: true, write: true, taskCreate: true },
      credentials: { token: 'test' },
      settings: { repos: ['acme/source', 'acme/target'] },
      syncedLists: ['acme/source', 'acme/target'],
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'github-targeted',
      phase: 'shadow_write',
      updatedAt: now,
    });
    await db.insert(schema.sourceLists).values([
      {
        id: 'source-list',
        connectorInstanceId: 'github-targeted',
        sourceId: 'acme/source',
        name: 'acme/source',
        type: 'repo',
      },
      {
        id: 'target-list',
        connectorInstanceId: 'github-targeted',
        sourceId: 'acme/target',
        name: 'acme/target',
        type: 'repo',
      },
    ]);
    await db.insert(schema.tasks).values({
      id: 'fresh-issue',
      sourceId: 'acme/source:7',
      connectorType: 'github-issues',
      connectorInstanceId: 'github-targeted',
      title: 'Fresh issue',
      sourceListId: 'acme/source',
      sourceListName: 'acme/source',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
    });

    const sourceRepository = repositoryEvidence('R_source', 'acme', 'source', now);
    const targetRepository = repositoryEvidence('R_target', 'acme', 'target', now);
    const issueEvidence = {
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue' as const,
          stableId: 'I_fresh',
        },
        locator: {
          owner: 'acme',
          repository: 'source',
          issueNumber: 7,
          apiUrl: 'https://api.github.com/repos/acme/source/issues/7',
          webUrl: 'https://github.com/acme/source/issues/7',
        },
        observationSource: 'rest' as const,
        observedAt: now,
      },
      repository: sourceRepository,
    };

    reconcileTransferIdentity('fresh-issue', 'github-targeted', {
      task: {
        id: 'remote-placeholder',
        sourceId: 'acme/source:7',
        connectorType: 'github-issues',
        connectorInstanceId: 'github-targeted',
        title: 'Fresh issue, refreshed',
        description: 'Current body',
        status: 'todo',
        priority: 'none',
        createdAt: now,
        updatedAt: now,
        parentId: undefined,
        childIds: [],
        depth: 0,
        isChecklistItem: false,
        sourceListId: 'acme/source',
        sourceListName: 'acme/source',
        hubProjectIds: [],
        tags: [],
        metadata: {},
        externalIdentity: issueEvidence,
        syncStatus: 'synced',
        lastSyncedAt: now,
      },
      sourceLists: [
        { sourceId: 'acme/source', evidence: { entity: sourceRepository } },
        { sourceId: 'acme/target', evidence: { entity: targetRepository } },
      ],
    });

    expect(canTransferGitHubIssueSafely(
      'github-targeted',
      'acme/source:7',
      'acme/target',
    )).toBe(true);
  });
});

function repositoryEvidence(
  stableId: string,
  owner: string,
  repository: string,
  observedAt: string,
) {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository' as const,
      stableId,
    },
    locator: {
      owner,
      repository,
      apiUrl: `https://api.github.com/repos/${owner}/${repository}`,
      webUrl: `https://github.com/${owner}/${repository}`,
    },
    observationSource: 'rest' as const,
    observedAt,
  };
}
