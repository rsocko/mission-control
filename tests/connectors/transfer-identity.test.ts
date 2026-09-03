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

    expect(await canTransferGitHubIssueSafely(
      'github-targeted',
      'acme/source:7',
      'acme/target',
    )).toBe(true);
  });

  it('rejects an oversized legacy batch before ever opening a transaction', async () => {
    // Replaces `runTransaction` with a spy (preserving every other real export
    // via `importOriginal`) so this test can assert it is never called, then
    // forces `vi.resetModules()` so `transfer-identity.ts` re-imports `@/db`
    // and binds to this mocked `runTransaction`, not a prior test's cached one.
    const runTransactionSpy = vi.fn();
    vi.doMock('@/db', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@/db')>();
      return { ...actual, runTransaction: runTransactionSpy };
    });
    vi.resetModules();

    const [
      { default: db },
      schema,
      { reconcileTransferIdentity },
    ] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/connectors/transfer-identity'),
    ]);
    const now = '2026-08-09T21:00:00.000Z';
    const connectorInstanceId = 'oversized-batch-connector';

    // 500 source-list writes + 1 task write = 501, one past the ceiling.
    const sourceListRows: (typeof schema.sourceLists.$inferInsert)[] = [];
    const refreshSourceLists: { sourceId: string; evidence: { entity: ReturnType<typeof repositoryEvidence> } }[] = [];
    for (let index = 0; index < 500; index += 1) {
      const sourceId = `acme/repo-${index}`;
      sourceListRows.push({
        id: `oversized-list-${index}`,
        connectorInstanceId,
        sourceId,
        name: sourceId,
        type: 'repo',
      });
      refreshSourceLists.push({
        sourceId,
        evidence: { entity: repositoryEvidence(`R_oversized_${index}`, 'acme', `repo-${index}`, now) },
      });
    }
    await db.insert(schema.sourceLists).values(sourceListRows);

    const issueEvidence = {
      entity: {
        identity: {
          provider: 'github',
          hostKey: 'github.com',
          entityType: 'issue' as const,
          stableId: 'I_oversized',
        },
        locator: {
          owner: 'acme',
          repository: 'repo-0',
          issueNumber: 1,
          apiUrl: 'https://api.github.com/repos/acme/repo-0/issues/1',
          webUrl: 'https://github.com/acme/repo-0/issues/1',
        },
        observationSource: 'rest' as const,
        observedAt: now,
      },
    };

    expect(() => reconcileTransferIdentity('oversized-task', connectorInstanceId, {
      task: {
        id: 'remote-placeholder',
        sourceId: 'acme/repo-0:1',
        connectorType: 'github-issues',
        connectorInstanceId,
        title: 'Oversized batch task',
        description: undefined,
        status: 'todo',
        priority: 'none',
        createdAt: now,
        updatedAt: now,
        parentId: undefined,
        childIds: [],
        depth: 0,
        isChecklistItem: false,
        sourceListId: undefined,
        sourceListName: undefined,
        hubProjectIds: [],
        tags: [],
        metadata: {},
        externalIdentity: issueEvidence,
        syncStatus: 'synced',
        lastSyncedAt: now,
      },
      sourceLists: refreshSourceLists,
    })).toThrow('External identity batch exceeds the maximum of 500');

    // The ceiling must reject before any transaction is opened - no partial
    // effects, and no unnecessary write-lock acquisition for an oversized
    // batch that will never be persisted.
    expect(runTransactionSpy).not.toHaveBeenCalled();

    vi.doUnmock('@/db');
    vi.resetModules();
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
