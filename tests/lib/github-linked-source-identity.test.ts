import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-linked-source-identity-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identity: typeof import('@/lib/external-identities');

const now = '2026-08-09T20:00:00.000Z';

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  identity = await import('@/lib/external-identities');
  database.default.insert(schema.connectorConfigs).values([
    connector('github-a'),
    connector('github-b'),
  ]).run();
  database.default.insert(schema.githubIdentityMigrations).values([
    { connectorInstanceId: 'github-a', phase: 'complete', updatedAt: now },
    { connectorInstanceId: 'github-b', phase: 'complete', updatedAt: now },
  ]).run();
  database.default.insert(schema.githubIdentityControls).values([
    control('github-a'),
    control('github-b'),
  ]).run();
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub linked-source stable identity', () => {
  it('associates trusted evidence idempotently and resolves by task ID', async () => {
    addTask('local-task-1', 'local', 'local:1');
    addTask('github-primary-1', 'github-a', 'owner/repo:1');
    addLinkedSource('linked-1', 'local-task-1', 'github-a', 'owner/repo:1');
    const evidence = issueEvidence('I_1', 'R_1', 'owner', 'repo', 1);
    persistPrimary('github-a', 'github-primary-1', evidence);

    expect(await identity.persistGitHubLinkedSourceIdentityBatch('github-a', [{
      linkedSourceId: 'linked-1',
      sourceId: 'owner/repo:1',
      evidence,
    }])).toEqual([{
      linkedSourceId: 'linked-1',
      state: 'associated',
    }]);
    expect(await identity.persistGitHubLinkedSourceIdentityBatch('github-a', [{
      linkedSourceId: 'linked-1',
      sourceId: 'owner/repo:1',
      evidence,
    }])).toEqual([{
      linkedSourceId: 'linked-1',
      state: 'associated',
    }]);

    const resolved = (await identity.resolveGitHubLinkedSourceIdentityBatch('github-a', [{
      candidateKey: 'linked:linked-1',
      linkedSourceId: 'linked-1',
      taskId: 'local-task-1',
      sourceId: 'owner/repo:1',
      evidence,
    }])).resolutions.get('linked:linked-1');
    expect(resolved).toMatchObject({
      selectedLocalIds: ['local-task-1'],
      evidence: 'verified',
      action: 'present',
    });
    expect(resolved?.stableIdDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(resolved)).not.toContain('I_1');
  });

  it('isolates connectors and hosts and rejects duplicate stable associations', async () => {
    addTask('local-task-2', 'local', 'local:2');
    addTask('local-task-3', 'local', 'local:3');
    addTask('github-primary-b', 'github-b', 'owner/repo:1');
    addTask('github-enterprise-primary', 'github-a', 'owner/repo:101');
    addLinkedSource('linked-2', 'local-task-2', 'github-b', 'owner/repo:1');
    addLinkedSource('linked-3', 'local-task-3', 'github-a', 'owner/repo:101');
    const githubEvidence = issueEvidence('I_1', 'R_1', 'owner', 'repo', 1);
    const enterpriseEvidence = issueEvidence(
      'I_1',
      'R_enterprise',
      'owner',
      'repo',
      101,
      'github.example.com',
    );
    persistPrimary('github-b', 'github-primary-b', githubEvidence);
    persistPrimary('github-a', 'github-enterprise-primary', enterpriseEvidence);
    expect((await identity.persistGitHubLinkedSourceIdentityBatch('github-b', [{
      linkedSourceId: 'linked-2',
      sourceId: 'owner/repo:1',
      evidence: githubEvidence,
    }]))[0].state).toBe('associated');
    expect((await identity.persistGitHubLinkedSourceIdentityBatch('github-a', [{
      linkedSourceId: 'linked-3',
      sourceId: 'owner/repo:101',
      evidence: enterpriseEvidence,
    }]))[0].state).toBe('associated');

    addTask('github-primary-duplicate', 'github-a', 'owner/duplicate:2');
    addTask('local-task-duplicate-a', 'local', 'local:duplicate-a');
    addTask('local-task-4', 'local', 'local:4');
    addLinkedSource(
      'linked-duplicate-a',
      'local-task-duplicate-a',
      'github-a',
      'owner/duplicate:2',
    );
    addLinkedSource('linked-4', 'local-task-4', 'github-a', 'Owner/Duplicate:2');
    const duplicateEvidence = issueEvidence(
      'I_duplicate',
      'R_duplicate',
      'owner',
      'duplicate',
      2,
    );
    persistPrimary('github-a', 'github-primary-duplicate', duplicateEvidence);
    expect((await identity.persistGitHubLinkedSourceIdentityBatch('github-a', [{
      linkedSourceId: 'linked-duplicate-a',
      sourceId: 'owner/duplicate:2',
      evidence: duplicateEvidence,
    }]))[0].state).toBe('associated');
    expect((await identity.persistGitHubLinkedSourceIdentityBatch('github-a', [{
      linkedSourceId: 'linked-4',
      sourceId: 'Owner/Duplicate:2',
      evidence: duplicateEvidence,
    }]))[0].state).toBe('collision');
    expect(database.default.select().from(schema.taskLinkedSourceEntities).where(and(
      eq(schema.taskLinkedSourceEntities.connectorInstanceId, 'github-a'),
      eq(schema.taskLinkedSourceEntities.linkedSourceId, 'linked-4'),
    )).get()).toBeUndefined();
  });

  it.each([
    ['missing', 'missing_stable_id'],
    ['partial', 'partial_fetch'],
    ['inaccessible', 'inaccessible'],
  ] as const)('blocks on %s evidence without mutating the linked-source locator', async (state, outcome) => {
    const runtime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-a',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-a'),
      syncKind: 'full',
    });
    const decision = (await runtime.resolveLinkedSourceBatch([{
      candidateKey: `linked:${state}`,
      linkedSourceId: 'linked-1',
      taskId: 'local-task-1',
      sourceId: 'owner/repo:1',
      evidenceState: state,
    }]))[0];
    runtime.complete('succeeded');

    expect(decision).toMatchObject({
      outcome,
      appliedSource: 'blocked',
      selectedLocalId: null,
      selectedAction: 'none',
    });
    expect(database.default.select().from(schema.taskLinkedSources)
      .where(eq(schema.taskLinkedSources.id, 'linked-1')).get()).toMatchObject({
      taskId: 'local-task-1',
      sourceId: 'owner/repo:1',
    });
  });

  it('detects locator change and path replacement without rebinding', async () => {
    const renamedEvidence = issueEvidence('I_1', 'R_1', 'new-owner', 'new-repo', 1);
    const locatorRuntime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-a',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-a'),
      syncKind: 'full',
    });
    expect((await locatorRuntime.resolveLinkedSourceBatch([{
      candidateKey: 'linked:locator-change',
      linkedSourceId: 'linked-1',
      taskId: 'local-task-1',
      sourceId: 'owner/repo:1',
      evidence: renamedEvidence,
    }]))[0]).toMatchObject({
      outcome: 'locator_change',
      selectedLocalId: 'local-task-1',
    });
    locatorRuntime.complete('succeeded');

    identity.upsertExternalEntity({
      identity: {
        provider: 'github',
        hostKey: 'github.com',
        entityType: 'issue',
        stableId: 'I_replacement',
      },
      observedAt: now,
    });
    const replacementRuntime = new identity.GitHubStableIdentityRuntime({
      connectorInstanceId: 'github-a',
      modeSnapshot: identity.getGitHubIdentityModeSnapshot('github-a'),
      syncKind: 'full',
    });
    expect((await replacementRuntime.resolveLinkedSourceBatch([{
      candidateKey: 'linked:path-reuse',
      linkedSourceId: 'linked-1',
      taskId: 'local-task-1',
      sourceId: 'owner/repo:1',
      evidence: issueEvidence('I_replacement', 'R_1', 'owner', 'repo', 1),
    }]))[0]).toMatchObject({
      outcome: 'path_reuse',
      appliedSource: 'blocked',
      selectedLocalId: null,
    });
    replacementRuntime.complete('succeeded');
    expect(database.default.select().from(schema.taskLinkedSourceEntities)
      .where(eq(schema.taskLinkedSourceEntities.linkedSourceId, 'linked-1')).get())
      .toMatchObject({
        linkedSourceId: 'linked-1',
      });
  });

  it('keeps existing legacy-only rows upgrade compatible and bounded', async () => {
    addTask('legacy-task', 'local', 'local:legacy');
    addLinkedSource('linked-legacy', 'legacy-task', 'github-a', 'owner/legacy:9');
    const result = await identity.resolveGitHubLinkedSourceIdentityBatch('github-a', [{
      candidateKey: 'linked:legacy',
      linkedSourceId: 'linked-legacy',
      taskId: 'legacy-task',
      sourceId: 'owner/legacy:9',
      evidenceState: 'missing',
    }]);
    expect(result).toMatchObject({ queryCount: 1 });
    expect(result.resolutions.get('linked:legacy')).toMatchObject({
      selectedLocalIds: [],
      evidence: 'missing',
      action: 'none',
    });
    await expect(identity.resolveGitHubLinkedSourceIdentityBatch(
      'github-a',
      Array.from({ length: 501 }, (_, index) => ({
        candidateKey: `linked:${index}`,
        linkedSourceId: 'linked-legacy',
        taskId: 'legacy-task',
        sourceId: 'owner/legacy:9',
        evidenceState: 'missing' as const,
      })),
    )).rejects.toThrow('maximum of 500');
  });
});

function connector(id: string) {
  return {
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual' as const,
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: {},
    settings: { repos: ['owner/repo'] },
    syncedLists: ['owner/repo'],
    createdAt: now,
    updatedAt: now,
  };
}

function control(connectorInstanceId: string) {
  return {
    connectorInstanceId,
    modeRevision: 1,
    updatedAt: now,
  };
}

function addTask(id: string, connectorInstanceId: string, sourceId: string): void {
  database.default.insert(schema.tasks).values({
    id,
    sourceId,
    connectorType: connectorInstanceId === 'local' ? 'local' : 'github-issues',
    connectorInstanceId,
    title: id,
    status: 'todo',
    syncStatus: 'synced',
    createdAt: now,
    updatedAt: now,
    lastSyncedAt: now,
    metadata: {},
  }).run();
}

function addLinkedSource(
  id: string,
  taskId: string,
  connectorInstanceId: string,
  sourceId: string,
): void {
  database.default.insert(schema.taskLinkedSources).values({
    id,
    taskId,
    connectorType: 'github-issues',
    connectorInstanceId,
    sourceId,
    title: id,
    linkedAt: now,
    metadata: {},
  }).run();
}

function persistPrimary(
  connectorInstanceId: string,
  localId: string,
  evidence: ReturnType<typeof issueEvidence>,
): void {
  identity.persistExternalIdentityBatch([{
    target: {
      connectorInstanceId,
      bindingType: 'task',
      localId,
      legacyIdentity: `${evidence.entity.locator.owner}/${evidence.entity.locator.repository}:${evidence.entity.locator.issueNumber}`,
    },
    evidence,
  }]);
}

function issueEvidence(
  issueStableId: string,
  repositoryStableId: string,
  owner: string,
  repository: string,
  issueNumber: number,
  hostKey = 'github.com',
) {
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'repository' as const,
        stableId: repositoryStableId,
      },
      locator: { owner, repository },
      observationSource: 'graphql' as const,
      observedAt: now,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'issue' as const,
        stableId: issueStableId,
      },
      locator: { owner, repository, issueNumber },
      observationSource: 'graphql' as const,
      observedAt: now,
    },
  };
}
