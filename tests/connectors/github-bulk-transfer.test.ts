import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
} from '@/lib/external-identities';
import type {
  GitHubRepositoryRepointRemote,
} from '@/lib/connectors/github-issues/repoint-service';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-bulk-transfer-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');
process.env.LOG_LEVEL = 'silent';

const now = new Date('2026-08-12T15:00:00.000Z');
let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let identities: typeof import('@/lib/external-identities');
let service: typeof import('@/lib/connectors/github-issues/bulk-transfer-service');

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  identities = await import('@/lib/external-identities');
  service = await import('@/lib/connectors/github-issues/bulk-transfer-service');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub bulk issue transfer', () => {
  it('previews every open and closed issue without mutating state', async () => {
    const seeded = seedConnector('bulk-preview');
    const remote = createRemote(seeded);
    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote,
      now: () => now,
    });

    expect(preview).toMatchObject({
      go: true,
      sourceIssueCount: 2,
      destinationIssueCount: 0,
      openIssueCount: 1,
      closedIssueCount: 1,
      localTaskCount: 2,
      planHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(preview.items.map((item) => item.taskId)).toEqual(seeded.taskIds);
    expect(database.default.select().from(schema.githubBulkTransferRuns).all()).toEqual([]);
    expect(database.default.select().from(schema.tasks).all()
      .filter((task) => seeded.taskIds.includes(task.id))
      .map((task) => task.sourceId)).toEqual([
      'owner/source:1',
      'owner/source:2',
    ]);
  });

  it('checkpoints verified transfers and reconciles unchanged local metadata', async () => {
    const seeded = seedConnector('bulk-execute');
    const remote = createRemote(seeded);
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const result = await service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-execute-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
      concurrency: 2,
    }, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      phase: 'completed',
      totalCount: 2,
      transferredCount: 2,
      pendingCount: 0,
      ambiguousCount: 0,
      reconciledCount: 2,
      connectorEnabled: true,
    });
    expect(database.default.select().from(schema.tasks).all()
      .filter((task) => seeded.taskIds.includes(task.id))
      .map((task) => task.sourceId)).toEqual([
      'owner/target:101',
      'owner/target:102',
    ]);
    expect(database.default.select().from(schema.githubBulkTransferItems)
      .where((await import('drizzle-orm')).eq(
        schema.githubBulkTransferItems.runId,
        result.id,
      )).all().map((item) => item.state)).toEqual(['transferred', 'transferred']);
    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-execute-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, { remote, now: () => now })).resolves.toMatchObject({
      id: result.id,
      phase: 'completed',
    });
  });

  it('leaves the connector disabled and blocks replay after an ambiguous dispatch', async () => {
    const seeded = seedConnector('bulk-interrupted');
    const remote = createRemote(seeded, { failAfterDispatch: true });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const execute = {
      ...common,
      idempotencyKey: 'bulk-interrupted-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    };

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('simulated post-dispatch interruption');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      ambiguousCount: 1,
      connectorEnabled: false,
    });
    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
    })).rejects.toThrow('unresolved post-dispatch item');

    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
    }, { remote, now: () => now })).resolves.toMatchObject({
      phase: 'failed',
      ambiguousCount: 0,
      transferredCount: 1,
      connectorEnabled: false,
    });
    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
      connectorEnabled: true,
    });
  });

  it('marks pre-dispatch failures as retryable rather than ambiguous', async () => {
    const seeded = seedConnector('bulk-pre-dispatch');
    const remote = createRemote(seeded, { failSourceResolutionOnce: true });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const execute = {
      ...common,
      idempotencyKey: 'bulk-pre-dispatch-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    };

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
    })).rejects.toThrow('source issue identity verification failed');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where((await import('drizzle-orm')).eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      failedCount: 1,
      ambiguousCount: 0,
      connectorEnabled: false,
    });
    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
    });
  });
});

function input(connectorInstanceId: string) {
  return {
    connectorInstanceId,
    sourceRepository: 'owner/source',
    targetRepository: 'owner/target',
    actor: 'test-operator',
    backupProof: {
      path: join(directory, `${connectorInstanceId}.backup.db`),
      sha256: 'a'.repeat(64),
      sizeBytes: 1024,
      modifiedAt: now.toISOString(),
      integrityCheck: 'ok' as const,
      verifiedAt: now.toISOString(),
    },
  };
}

function seedConnector(connectorId: string) {
  const taskIds = [`${connectorId}-1`, `${connectorId}-2`];
  database.default.insert(schema.connectorConfigs).values({
    id: connectorId,
    type: 'github-issues',
    name: connectorId,
    enabled: true,
    syncMode: 'manual',
    capabilities: { read: true, write: true },
    credentials: { token: 'test-token' },
    settings: { repos: ['owner/source', 'owner/target'] },
    syncedLists: ['owner/source', 'owner/target'],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: connectorId,
    phase: 'stable_primary',
    updatedAt: now.toISOString(),
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
    stablePrimaryEnabled: true,
    modeRevision: 5,
    updatedAt: now.toISOString(),
  }).run();
  database.default.insert(schema.sourceLists).values([
    {
      id: `${connectorId}-source-list`,
      connectorInstanceId: connectorId,
      sourceId: 'owner/source',
      name: 'owner/source',
      type: 'repo',
    },
    {
      id: `${connectorId}-target-list`,
      connectorInstanceId: connectorId,
      sourceId: 'owner/target',
      name: 'owner/target',
      type: 'repo',
    },
  ]).run();
  database.default.insert(schema.tasks).values(taskIds.map((id, index) => ({
    id,
    sourceId: `owner/source:${index + 1}`,
    sourceListId: 'owner/source',
    sourceListName: 'owner/source',
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: `Issue ${index + 1}`,
    description: `Body ${index + 1}`,
    status: index === 0 ? 'todo' as const : 'done' as const,
    metadata: { issueNumber: index + 1, retained: true },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
  }))).run();
  identities.persistExternalIdentityBatch([
    {
      target: {
        connectorInstanceId: connectorId,
        bindingType: 'source_list',
        localId: `${connectorId}-source-list`,
        legacyIdentity: 'owner/source',
      },
      evidence: { entity: repositoryObservation(connectorId, 'source', 'R_source') },
    },
    {
      target: {
        connectorInstanceId: connectorId,
        bindingType: 'source_list',
        localId: `${connectorId}-target-list`,
        legacyIdentity: 'owner/target',
      },
      evidence: { entity: repositoryObservation(connectorId, 'target', 'R_target') },
    },
    ...taskIds.map((taskId, index) => ({
      target: {
        connectorInstanceId: connectorId,
        bindingType: 'task' as const,
        localId: taskId,
        legacyIdentity: `owner/source:${index + 1}`,
      },
      evidence: issueEvidence(connectorId, 'source', index + 1, `I_${connectorId}_${index + 1}`),
    })),
  ], 'stable_primary');
  return { connectorId, taskIds };
}

function createRemote(
  seeded: ReturnType<typeof seedConnector>,
  options: {
    failAfterDispatch?: boolean;
    failSourceResolutionOnce?: boolean;
  } = {},
): GitHubRepositoryRepointRemote {
  const locations = new Map([
    [`I_${seeded.connectorId}_1`, { repository: 'owner/source', number: 1 }],
    [`I_${seeded.connectorId}_2`, { repository: 'owner/source', number: 2 }],
  ]);
  let transferCalls = 0;
  let sourceResolutionFailed = false;
  return {
    async resolveRepository(repository) {
      if (repository === 'owner/source') {
        return repositoryObservation(seeded.connectorId, 'source', 'R_source');
      }
      if (repository === 'owner/target') {
        return repositoryObservation(seeded.connectorId, 'target', 'R_target');
      }
      return null;
    },
    async listIssues(repository) {
      const sourceIssues = [
        restIssue(1, `I_${seeded.connectorId}_1`, 'open'),
        restIssue(2, `I_${seeded.connectorId}_2`, 'closed'),
      ];
      if (repository === 'owner/source') {
        return sourceIssues.filter((issue) => (
          locations.get(issue.node_id!)?.repository === 'owner/source'
        ));
      }
      return [...locations.entries()]
        .filter(([, location]) => location.repository === 'owner/target')
        .map(([stableId, location]) => restIssue(location.number, stableId, 'open'));
    },
    async resolveIssue(repository, issueNumber) {
      if (
        options.failSourceResolutionOnce
        && repository === 'owner/source'
        && !sourceResolutionFailed
      ) {
        sourceResolutionFailed = true;
        return null;
      }
      const match = [...locations.entries()].find(([, location]) => (
        location.repository === repository && location.number === issueNumber
      ));
      return match
        ? issueEvidence(
            seeded.connectorId,
            repository.endsWith('source') ? 'source' : 'target',
            issueNumber,
            match[0],
          )
        : null;
    },
    async transferIssue(issueStableId) {
      transferCalls++;
      const targetNumber = 100 + transferCalls;
      locations.set(issueStableId, { repository: 'owner/target', number: targetNumber });
      if (options.failAfterDispatch && transferCalls === 1) {
        throw new Error('simulated post-dispatch interruption');
      }
      return targetNumber;
    },
  };
}

function repositoryObservation(
  connectorId: string,
  repository: 'source' | 'target',
  stableId: string,
): ExternalIdentityObservation {
  return {
    identity: {
      provider: 'github',
      hostKey: `${connectorId}.github.test`,
      entityType: 'repository',
      stableId,
    },
    locator: { owner: 'owner', repository },
    observationSource: 'rest',
    observedAt: now.toISOString(),
  };
}

function issueEvidence(
  connectorId: string,
  repository: 'source' | 'target',
  issueNumber: number,
  stableId: string,
): ExternalIdentityEvidence {
  return {
    repository: repositoryObservation(
      connectorId,
      repository,
      repository === 'source' ? 'R_source' : 'R_target',
    ),
    entity: {
      identity: {
        provider: 'github',
        hostKey: `${connectorId}.github.test`,
        entityType: 'issue',
        stableId,
      },
      locator: { owner: 'owner', repository, issueNumber },
      observationSource: 'rest',
      observedAt: now.toISOString(),
    },
  };
}

function restIssue(number: number, nodeId: string, state: string) {
  return {
    number,
    node_id: nodeId,
    title: `Issue ${number}`,
    body: `Body ${number}`,
    state,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    closed_at: state === 'closed' ? now.toISOString() : null,
    html_url: `https://github.test/owner/source/issues/${number}`,
    labels: [],
  };
}
