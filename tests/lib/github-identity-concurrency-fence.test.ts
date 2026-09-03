import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

describe('GitHub identity persistence concurrency fences', () => {
  beforeEach(() => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.LOG_LEVEL = 'silent';
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
  });

  afterEach(() => {
    delete process.env.MC_DB_PATH;
  });

  it('rejects stale identity writes and records, then cancels stale run completion', async () => {
    const [{ default: db }, schema, identity, { eq }] = await Promise.all([
      importInitializedSqliteDatabase(),
      import('@/db/schema'),
      import('@/lib/external-identities'),
      import('drizzle-orm'),
    ]);
    const now = '2026-08-10T16:00:00.000Z';
    db.insert(schema.connectorConfigs).values({
      id: 'identity-fence',
      type: 'github-issues',
      name: 'Identity fence',
      capabilities: {},
      credentials: {},
      settings: {},
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityMigrations).values({
      connectorInstanceId: 'identity-fence',
      phase: 'complete',
      updatedAt: now,
    }).run();
    db.insert(schema.githubIdentityControls).values({
      connectorInstanceId: 'identity-fence',
      modeRevision: 2,
      updatedAt: now,
    }).run();
    db.insert(schema.tasks).values({
      id: 'identity-task',
      sourceId: 'owner/repo:1',
      connectorType: 'github-issues',
      connectorInstanceId: 'identity-fence',
      title: 'Identity task',
      status: 'todo',
      createdAt: now,
      updatedAt: now,
      lastSyncedAt: now,
      metadata: {},
    }).run();
    const snapshot = identity.getGitHubIdentityModeSnapshot('identity-fence');
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'identity-fence',
      modeSnapshot: snapshot,
      syncKind: 'full',
    });

    db.update(schema.githubIdentityControls).set({
      modeRevision: 3,
      updatedAt: now,
    }).where(eq(schema.githubIdentityControls.connectorInstanceId, 'identity-fence')).run();

    expect(() => identity.persistExternalIdentityBatch([{
      target: {
        connectorInstanceId: 'identity-fence',
        bindingType: 'task',
        localId: 'identity-task',
        legacyIdentity: 'owner/repo:1',
      },
      evidence: {
        repository: {
          identity: {
            provider: 'github',
            hostKey: 'github.com',
            entityType: 'repository',
            stableId: 'R_fenced',
          },
          locator: { owner: 'owner', repository: 'repo' },
          observationSource: 'graphql',
          observedAt: now,
        },
        entity: {
          identity: {
            provider: 'github',
            hostKey: 'github.com',
            entityType: 'issue',
            stableId: 'I_fenced',
          },
          locator: { owner: 'owner', repository: 'repo', issueNumber: 1 },
          observationSource: 'graphql',
          observedAt: now,
        },
      },
    }], snapshot)).toThrow('revision changed');
    expect(db.select().from(schema.externalEntities).all()).toEqual([]);

    // The stable runtime writes no evidence, so the only durable fence is the
    // identity epoch: a resolution attempt after the bump must fail closed.
    await expect(runtime.assertCurrentMode())
      .rejects.toThrow('GitHub identity runtime revision is stale');
    runtime.complete('cancelled', 'identity_context_changed');
  });
});
