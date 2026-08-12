import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type {
  GitHubIdentityBackfillResolution,
  GitHubIdentityResolver,
} from '@/lib/external-identities/github-backfill';

vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-github-backfill-'));
process.env.MC_DB_PATH = join(directory, 'mission-control.db');

let database: typeof import('@/db');
let schema: typeof import('@/db/schema');
let backfill: typeof import('@/lib/external-identities/github-backfill');

beforeAll(async () => {
  database = await import('@/db');
  schema = await import('@/db/schema');
  backfill = await import('@/lib/external-identities/github-backfill');
});

afterAll(() => {
  database.sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe('GitHub identity backfill', () => {
  it('resumes at a binary cursor and preserves task relationships', async () => {
    createConnector('resume');
    createSourceList('resume', 'list-a', 'owner/repo');
    createTask('resume', 'task-a', 'owner/repo:1', { nodeId: 'I_1' }, 'pending_push');
    createTask('resume', 'task-b', 'owner/repo:2', {}, 'synced');
    database.default.insert(schema.taskProjects).values({ taskId: 'task-a', projectId: 'project-1' }).run();
    database.default.insert(schema.taskSchedules).values({ taskId: 'task-a', scheduledDate: '2026-08-09' }).run();
    database.default.insert(schema.taskDependencies).values({
      id: 'dep-1',
      taskId: 'task-a',
      dependsOnTaskId: 'task-b',
      type: 'blocks',
      createdAt: now,
    }).run();

    const first = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'resume',
      batchSize: 1,
      maxBatches: 1,
      resolver: resolver({
        'source_list:owner/repo': boundRepository('R_owner_repo'),
      }),
    });
    expect(first.sourceListCursor).toBe('list-a');
    expect(first.taskCursor).toBeNull();

    const second = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'resume',
      batchSize: 1,
      resolver: resolver({
        'source_list:owner/repo': boundRepository('R_owner_repo'),
        'task:owner/repo:1': boundIssue('I_1', 'R_owner_repo', 1),
        'task:owner/repo:2': legacyOnly('issue_node_id_missing'),
      }),
    });
    expect(second.completed).toBe(true);
    expect(second.taskCursor).toBe('task-b');
    expect(database.default.select({
      id: schema.tasks.id,
      sourceId: schema.tasks.sourceId,
      syncStatus: schema.tasks.syncStatus,
    }).from(schema.tasks).where(eq(schema.tasks.connectorInstanceId, 'resume'))
      .orderBy(schema.tasks.id).all()).toEqual([
      { id: 'task-a', sourceId: 'owner/repo:1', syncStatus: 'pending_push' },
      { id: 'task-b', sourceId: 'owner/repo:2', syncStatus: 'synced' },
    ]);
    expect(database.default.select().from(schema.taskProjects)
      .where(eq(schema.taskProjects.taskId, 'task-a')).all()).toHaveLength(1);
    expect(database.default.select().from(schema.taskSchedules)
      .where(eq(schema.taskSchedules.taskId, 'task-a')).all()).toHaveLength(1);
    expect(database.default.select().from(schema.taskDependencies)
      .where(eq(schema.taskDependencies.taskId, 'task-a')).all()).toHaveLength(1);
  });

  it('dry-run reports work without writing any identity or progress rows', async () => {
    createConnector('dry-run');
    createTask('dry-run', 'dry-task', 'owner/repo:3', {}, 'synced');
    const before = identityCounts();
    const statusBefore = backfill.getGitHubIdentityBackfillStatus('dry-run');
    const result = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'dry-run',
      dryRun: true,
      resolver: resolver({ 'task:owner/repo:3': boundIssue('I_3', 'R_owner_repo', 3) }),
    });
    expect(result).toMatchObject({ dryRun: true, processed: 1, bound: 1 });
    expect(identityCounts()).toEqual(before);
    expect(backfill.getGitHubIdentityBackfillStatus('dry-run')).toEqual(statusBefore);
  });

  it('leaves rate-limited batches retryable without advancing the cursor', async () => {
    createConnector('retry');
    createTask('retry', 'retry-task', 'owner/repo:4', {}, 'synced');
    const limited = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'retry',
      resolver: resolver({
        'task:owner/repo:4': {
          state: 'pending',
          reasonCode: 'rate_limited',
          observedAt: now,
          nextAttemptAt: '2026-08-08T13:00:00.000Z',
        },
      }),
    });
    expect(limited).toMatchObject({ taskCursor: null, stoppedReason: 'rate_limited', pending: 1 });
    expect(database.default.select().from(schema.githubIdentityBackfillItems)
      .where(eq(schema.githubIdentityBackfillItems.localId, 'retry-task')).get()).toMatchObject({
      state: 'pending',
      reasonCode: 'rate_limited',
      nextAttemptAt: '2026-08-08T13:00:00.000Z',
    });

    const retried = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'retry',
      resolver: resolver({ 'task:owner/repo:4': boundIssue('I_4', 'R_owner_repo', 4) }),
    });
    expect(retried).toMatchObject({ taskCursor: 'retry-task', completed: true });
    expect(database.default.select().from(schema.githubIdentityBackfillItems)
      .where(eq(schema.githubIdentityBackfillItems.localId, 'retry-task')).get()).toMatchObject({
      state: 'bound',
      attemptCount: 2,
    });
  });

  it('records permission loss and duplicate stable identities without remapping tasks', async () => {
    createConnector('collision');
    createTask('collision', 'collision-a', 'owner/repo:5', {}, 'synced');
    createTask('collision', 'collision-b', 'owner/repo:6', {}, 'synced');
    createTask('collision', 'inaccessible', 'owner/private:7', {}, 'synced');
    const result = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'collision',
      resolver: resolver({
        'task:owner/repo:5': boundIssue('I_shared', 'R_owner_repo', 5),
        'task:owner/repo:6': boundIssue('I_shared', 'R_owner_repo', 6),
        'task:owner/private:7': {
          state: 'inaccessible',
          reasonCode: 'permission_denied',
          observedAt: now,
        },
      }),
    });
    expect(result.completed).toBe(true);
    expect(database.default.select().from(schema.githubIdentityCollisions)
      .where(eq(schema.githubIdentityCollisions.connectorInstanceId, 'collision')).all()).toHaveLength(1);
    expect(database.default.select().from(schema.githubIdentityBackfillItems)
      .where(eq(schema.githubIdentityBackfillItems.localId, 'collision-b')).get()).toMatchObject({
      state: 'collision',
    });
    expect(database.default.select().from(schema.githubIdentityBackfillItems)
      .where(eq(schema.githubIdentityBackfillItems.localId, 'inaccessible')).get()).toMatchObject({
      state: 'inaccessible',
      reasonCode: 'permission_denied',
    });
    expect(database.default.select({ id: schema.tasks.id, sourceId: schema.tasks.sourceId })
      .from(schema.tasks).where(eq(schema.tasks.connectorInstanceId, 'collision'))
      .orderBy(schema.tasks.id).all()).toEqual([
      { id: 'collision-a', sourceId: 'owner/repo:5' },
      { id: 'collision-b', sourceId: 'owner/repo:6' },
      { id: 'inaccessible', sourceId: 'owner/private:7' },
    ]);
  });

  it('previews collisions in dry-run without persisting any rows', async () => {
    createConnector('dry-collision');
    createTask('dry-collision', 'dry-collision-a', 'owner/repo:8', {}, 'synced');
    createTask('dry-collision', 'dry-collision-b', 'owner/repo:9', {}, 'synced');
    const before = identityCounts();
    const result = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'dry-collision',
      dryRun: true,
      resolver: resolver({
        'task:owner/repo:8': boundIssue('I_dry_shared', 'R_owner_repo', 8),
        'task:owner/repo:9': boundIssue('I_dry_shared', 'R_owner_repo', 9),
      }),
    });

    expect(result).toMatchObject({ dryRun: true, processed: 2, bound: 1, collisions: 1 });
    expect(identityCounts()).toEqual(before);
  });

  it('bounds retries and rejects invalid batch controls', async () => {
    createConnector('bounded-retry');
    createTask('bounded-retry', 'bounded-retry-task', 'owner/repo:10', {}, 'synced');
    const pendingResolver = resolver({
      'task:owner/repo:10': {
        state: 'pending',
        reasonCode: 'network_timeout',
        observedAt: now,
        nextAttemptAt: '2000-01-01T00:00:00.000Z',
      },
    });
    for (let attempt = 0; attempt < 4; attempt++) {
      const progress = await backfill.runGitHubIdentityBackfill({
        connectorInstanceId: 'bounded-retry',
        resolver: pendingResolver,
      });
      expect(progress.stoppedReason).toBe('retry_pending');
    }
    const exhausted = await backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'bounded-retry',
      resolver: pendingResolver,
    });
    expect(exhausted).toMatchObject({ completed: true, inaccessible: 1 });
    expect(database.default.select().from(schema.githubIdentityBackfillItems)
      .where(eq(schema.githubIdentityBackfillItems.localId, 'bounded-retry-task')).get())
      .toMatchObject({
        state: 'inaccessible',
        attemptCount: 5,
        reasonCode: 'retry_exhausted_network_timeout',
      });

    await expect(backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'bounded-retry',
      batchSize: 501,
      resolver: pendingResolver,
    })).rejects.toThrow('batchSize');
    await expect(backfill.runGitHubIdentityBackfill({
      connectorInstanceId: 'bounded-retry',
      maxBatches: 1.5,
      resolver: pendingResolver,
    })).rejects.toThrow('maxBatches');
  });
});

const now = '2026-08-08T12:00:00.000Z';

function createConnector(id: string): void {
  database.default.insert(schema.connectorConfigs).values({
    id,
    type: 'github-issues',
    name: id,
    enabled: true,
    syncMode: 'manual',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: { token: 'test-token' },
    settings: { repos: ['owner/repo'] },
    syncedLists: ['owner/repo'],
    createdAt: now,
    updatedAt: now,
  }).run();
  database.default.insert(schema.githubIdentityMigrations).values({
    connectorInstanceId: id,
    phase: 'shadow_write',
    updatedAt: now,
  }).run();
}

function createSourceList(connectorId: string, id: string, sourceId: string): void {
  database.default.insert(schema.sourceLists).values({
    id,
    connectorInstanceId: connectorId,
    sourceId,
    name: sourceId,
    type: 'repo',
    taskCount: 0,
    lastSyncedAt: now,
  }).run();
}

function createTask(
  connectorId: string,
  id: string,
  sourceId: string,
  metadata: Record<string, unknown>,
  syncStatus: 'synced' | 'pending_push',
): void {
  database.default.insert(schema.tasks).values({
    id,
    sourceId,
    connectorType: 'github-issues',
    connectorInstanceId: connectorId,
    title: id,
    status: 'todo',
    priority: 'none',
    createdAt: now,
    updatedAt: now,
    metadata,
    syncStatus,
    lastSyncedAt: now,
  }).run();
}

function resolver(
  resolutions: Record<string, GitHubIdentityBackfillResolution>,
): GitHubIdentityResolver {
  return {
    async resolveSourceList(sourceId) {
      return resolutions[`source_list:${sourceId}`] ?? legacyOnly('missing_fixture');
    },
    async resolveTask(row) {
      return resolutions[`task:${row.sourceId}`] ?? legacyOnly('missing_fixture');
    },
  };
}

function boundRepository(stableId: string): GitHubIdentityBackfillResolution {
  return {
    state: 'bound',
    reasonCode: 'fixture',
    observedAt: now,
    evidence: {
      entity: repositoryObservation(stableId),
    },
  };
}

function boundIssue(
  stableId: string,
  repositoryStableId: string,
  issueNumber: number,
): GitHubIdentityBackfillResolution {
  const repository = repositoryObservation(repositoryStableId);
  return {
    state: 'bound',
    reasonCode: 'fixture',
    observedAt: now,
    evidence: {
      repository,
      entity: {
        identity: { provider: 'github', hostKey: 'github.com', entityType: 'issue', stableId },
        locator: { owner: 'owner', repository: 'repo', issueNumber },
        observationSource: 'backfill',
        observedAt: now,
      },
    },
  };
}

function repositoryObservation(stableId: string) {
  return {
    identity: {
      provider: 'github',
      hostKey: 'github.com',
      entityType: 'repository' as const,
      stableId,
    },
    locator: { owner: 'owner', repository: 'repo' },
    observationSource: 'backfill' as const,
    observedAt: now,
  };
}

function legacyOnly(reasonCode: string): GitHubIdentityBackfillResolution {
  return { state: 'legacy_only', reasonCode, observedAt: now };
}

function identityCounts() {
  return {
    entities: database.default.select({ value: schema.externalEntities.id })
      .from(schema.externalEntities).all().length,
    bindings: database.default.select({ value: schema.externalEntityBindings.id })
      .from(schema.externalEntityBindings).all().length,
    locators: database.default.select({ value: schema.externalEntityLocators.id })
      .from(schema.externalEntityLocators).all().length,
    items: database.default.select({ value: schema.githubIdentityBackfillItems.localId })
      .from(schema.githubIdentityBackfillItems).all().length,
  };
}
