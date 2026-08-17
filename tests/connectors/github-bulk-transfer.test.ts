import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type {
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
} from '@/lib/external-identities';
import type {
  GitHubRepositoryRepointRemote,
} from '@/lib/connectors/github-issues/repoint-service';
import { GitHubHttpError } from '@/lib/connectors/github-issues/github-client';

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
  it('selects only reviewed stable issue node IDs and binds the manifest into the plan', async () => {
    const seeded = seedConnector('bulk-reviewed-allowlist');
    const common = {
      ...input(seeded.connectorId),
      scope: reviewedScope(seeded.connectorId, [1]),
    };
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview).toMatchObject({
      go: true,
      scopeMode: 'reviewed-allowlist',
      sourceRepositoryIssueCount: 2,
      sourceIssueCount: 1,
      approvedIssueNodeIdCount: 1,
      localTaskCount: 1,
      reviewedManifestSha256: 'b'.repeat(64),
    });
    expect(preview.items.map((item) => item.taskId)).toEqual([seeded.taskIds[0]]);

    const changedManifestPreview = await service.previewGitHubBulkTransfer({
      ...common,
      scope: {
        ...common.scope,
        manifestSha256: 'c'.repeat(64),
      },
    }, {
      remote: createRemote(seeded),
      now: () => now,
    });
    expect(changedManifestPreview.planHash).not.toBe(preview.planHash);

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      scope: {
        ...common.scope,
        manifestSha256: 'c'.repeat(64),
      },
      idempotencyKey: 'changed-reviewed-manifest',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote: createRemote(seeded),
      now: () => now,
    })).rejects.toThrow('plan hash is stale');

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'reviewed-allowlist-execute',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote: createRemote(seeded),
      now: () => now,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      phase: 'completed',
      totalCount: 1,
      transferredCount: 1,
    });
    expect(database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, seeded.connectorId)).all()
      .map((task) => task.sourceId)).toEqual([
      'owner/target:101',
      'owner/source:2',
    ]);
  });

  it('fails closed for duplicate or non-source allowlist node IDs', async () => {
    const seeded = seedConnector('bulk-invalid-allowlist');
    const duplicate = reviewedScope(seeded.connectorId, [1, 1]);
    await expect(service.previewGitHubBulkTransfer({
      ...input(seeded.connectorId),
      scope: duplicate,
    }, {
      remote: createRemote(seeded),
      now: () => now,
    })).rejects.toThrow('duplicate issue node IDs');

    const preview = await service.previewGitHubBulkTransfer({
      ...input(seeded.connectorId),
      scope: {
        ...reviewedScope(seeded.connectorId, [1]),
        issueNodeIds: ['I_from_another_repository_or_pull_request'],
      },
    }, {
      remote: createRemote(seeded),
      now: () => now,
    });
    expect(preview.go).toBe(false);
    expect(preview.reasons).toContain(
      'approved_issue_node_id_not_in_source:I_from_another_repository_or_pull_request',
    );
    expect(preview.items).toEqual([]);
  });

  it('requires repository-wide transfers to opt into all-issues scope', async () => {
    const seeded = seedConnector('bulk-explicit-all-issues');
    await expect(service.previewGitHubBulkTransfer({
      ...input(seeded.connectorId),
      scope: undefined,
    } as unknown as Parameters<typeof service.previewGitHubBulkTransfer>[0], {
      remote: createRemote(seeded),
      now: () => now,
    })).rejects.toThrow('requires explicit reviewed-allowlist or all-issues scope');
  });

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
    expect(database.default.select().from(schema.githubBulkTransferRuns).all()
      .filter((run) => run.connectorInstanceId === seeded.connectorId)).toEqual([]);
    expect(database.default.select().from(schema.tasks).all()
      .filter((task) => seeded.taskIds.includes(task.id))
      .map((task) => task.sourceId)).toEqual([
      'owner/source:1',
      'owner/source:2',
    ]);
  });

  it('excludes a cancelled task with durable authoritative deletion evidence', async () => {
    const seeded = seedConnector('bulk-authoritative-deletion');
    const deletedTaskId = addBoundTask(seeded, 1996, 'cancelled');
    addAuthoritativeDeletionProof(seeded.connectorId, deletedTaskId);

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview).toMatchObject({
      go: true,
      sourceIssueCount: 2,
      localTaskCount: 2,
    });
    expect(preview.items.map((item) => item.taskId)).toEqual(seeded.taskIds);
  });

  it('keeps arbitrary cancelled and live tasks in transfer reconciliation', async () => {
    const seeded = seedConnector('bulk-unproven-deletions');
    const cancelledTaskId = addBoundTask(seeded, 1996, 'cancelled');
    const liveTaskId = addBoundTask(seeded, 1997, 'todo');

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview).toMatchObject({
      go: false,
      sourceIssueCount: 2,
      localTaskCount: 4,
    });
    expect(preview.reasons).toEqual(expect.arrayContaining([
      'source_issue_and_task_counts_do_not_reconcile',
      `issue_identity_mismatch:${cancelledTaskId}`,
      `issue_identity_mismatch:${liveTaskId}`,
    ]));
  });

  it('rejects a revoked deletion exception as authoritative evidence', async () => {
    const seeded = seedConnector('bulk-revoked-deletion');
    const deletedTaskId = addBoundTask(seeded, 1996, 'cancelled');
    addAuthoritativeDeletionProof(seeded.connectorId, deletedTaskId);
    database.default.insert(schema.githubIdentityExceptionEvents).values({
      connectorInstanceId: seeded.connectorId,
      bindingType: 'task',
      localId: deletedTaskId,
      category: 'terminal_inaccessible',
      action: 'revoke',
      idempotencyKey: `${deletedTaskId}-revoked`,
      actor: 'test-operator',
      reason: 'Deletion could not be independently confirmed',
      createdAt: new Date(now.getTime() + 60_000).toISOString(),
    }).run();

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview).toMatchObject({
      go: false,
      sourceIssueCount: 2,
      localTaskCount: 3,
    });
    expect(preview.reasons).toEqual(expect.arrayContaining([
      'source_issue_and_task_counts_do_not_reconcile',
      `issue_identity_mismatch:${deletedTaskId}`,
    ]));
  });

  it('allows a fully observed completed comparison write cycle', async () => {
    const seeded = seedConnector('bulk-completed-write-cycle');
    database.default.insert(schema.githubIdentityWriteCycles).values({
      id: 'bulk-completed-write-cycle-evidence',
      connectorInstanceId: seeded.connectorId,
      modeRevision: 4,
      pendingCandidateCount: 1,
      observedRouteCount: 1,
      appliedCount: 1,
      state: 'completed',
      startedAt: now.toISOString(),
      completedAt: now.toISOString(),
    }).run();

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview.go).toBe(true);
  });

  it('fails closed while an unknown GitHub write outcome is unresolved', async () => {
    const seeded = seedConnector('bulk-push-failed');
    database.default.update(schema.tasks).set({
      syncStatus: 'push_failed',
      pushRetryCount: 5,
    }).where(eq(schema.tasks.id, seeded.taskIds[0])).run();

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview.go).toBe(false);
    expect(preview.reasons).toContain('pending_writes_deletions_or_identity_collisions');
  });

  it('fails closed while dependency reconciliation is incomplete', async () => {
    const seeded = seedConnector('bulk-dependency-running');
    database.default.insert(schema.dependencyReconciliationSnapshots).values({
      id: 'bulk-dependency-running-snapshot',
      connectorInstanceId: seeded.connectorId,
      status: 'running',
      phase: 'reconciling',
      cursor: 0,
      total: 1,
      batchSize: 100,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).run();

    const preview = await service.previewGitHubBulkTransfer(input(seeded.connectorId), {
      remote: createRemote(seeded),
      now: () => now,
    });

    expect(preview.go).toBe(false);
    expect(preview.reasons).toContain('pending_writes_deletions_or_identity_collisions');
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
      .map((task) => ({
        sourceId: task.sourceId,
        metadata: task.metadata,
      }))).toEqual([
      {
        sourceId: 'owner/target:101',
        metadata: {
          issueNumber: 101,
          nodeId: `I_${seeded.connectorId}_1`,
          url: 'https://github.test/owner/target/issues/101',
          retained: true,
        },
      },
      {
        sourceId: 'owner/target:102',
        metadata: {
          issueNumber: 102,
          nodeId: `I_${seeded.connectorId}_2`,
          url: 'https://github.test/owner/target/issues/102',
          retained: true,
        },
      },
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

  it('returns rate-limited dispatches to pending before bounded retry', async () => {
    const seeded = seedConnector('bulk-rate-limit');
    const remote = createRemote(seeded, { rateLimitFirstDispatch: true });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const observedStates: string[] = [];
    const sleep = vi.fn(async () => {
      const item = database.default.select().from(schema.githubBulkTransferItems)
        .where(eq(
          schema.githubBulkTransferItems.runId,
          database.default.select().from(schema.githubBulkTransferRuns)
            .where(eq(
              schema.githubBulkTransferRuns.connectorInstanceId,
              seeded.connectorId,
            )).get()!.id,
        )).get();
      observedStates.push(item!.state);
    });

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-rate-limit-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
      ambiguousCount: 0,
    });

    expect(sleep).toHaveBeenCalledWith(2_000);
    expect(observedStates).toEqual(['pending']);
    expect(database.default.select().from(schema.githubBulkTransferEvents).all()
      .filter((event) => event.runId === database.default.select()
        .from(schema.githubBulkTransferRuns)
        .where(eq(
          schema.githubBulkTransferRuns.connectorInstanceId,
          seeded.connectorId,
        )).get()!.id)
      .map((event) => event.eventType)).toContain('rate_limited');
  });

  it.each([
    {
      name: 'Retry-After',
      error: new GitHubHttpError('GraphQL request failed: 403', 403, 2_000, {
        headers: { 'retry-after': '2' },
      }),
      expectedDelayMs: 2_000,
    },
    {
      name: 'exhausted primary limit and reset',
      error: new GitHubHttpError('GraphQL request failed: 403', 403, null, {
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.ceil(Date.now() / 1_000) + 60),
        },
      }),
      expectedDelayMs: null,
    },
    {
      name: 'secondary limit response',
      error: new GitHubHttpError('GraphQL request failed: 403', 403, null, {
        responseBody: '{"message":"You have exceeded a secondary rate limit."}',
      }),
      expectedDelayMs: 1_000,
    },
  ])('retries a 403 dispatch with proven $name evidence', async ({
    name,
    error,
    expectedDelayMs,
  }) => {
    const seeded = seedConnector(`bulk-403-${name.replaceAll(' ', '-')}`);
    const remote = createRemote(seeded, { firstDispatchError: error });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const sleep = vi.fn(async () => undefined);

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: `bulk-403-${name}-key`,
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
      ambiguousCount: 0,
    });

    if (expectedDelayMs === null) {
      const delay = sleep.mock.calls[0]?.[0];
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(61_000);
    } else {
      expect(sleep).toHaveBeenCalledWith(expectedDelayMs);
    }
  });

  it.each([
    {
      name: 'ordinary forbidden',
      error: new GitHubHttpError('GraphQL request failed: 403', 403, null, {
        responseBody: '{"message":"Resource not accessible by personal access token"}',
      }),
    },
    {
      name: 'malformed rate-limit headers',
      error: new GitHubHttpError('GraphQL request failed: 403', 403, null, {
        headers: {
          'retry-after': 'later',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': 'not-a-timestamp',
        },
      }),
    },
  ])('rejects a 403 dispatch with $name evidence', async ({ name, error }) => {
    const seeded = seedConnector(`bulk-403-reject-${name.replaceAll(' ', '-')}`);
    const remote = createRemote(seeded, { firstDispatchError: error });
    const transferIssue = vi.fn(remote.transferIssue!);
    remote.transferIssue = transferIssue;
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const sleep = vi.fn(async () => undefined);

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: `bulk-403-reject-${name}-key`,
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep,
    })).rejects.toThrow('GraphQL request failed: 403');

    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      failedCount: 1,
      ambiguousCount: 0,
      connectorEnabled: false,
    });
    expect(transferIssue).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('keeps a post-transfer 403 rate limit ambiguous without redispatch', async () => {
    const seeded = seedConnector('bulk-verification-rate-limit');
    const remote = createRemote(seeded, {
      targetResolutionError: new GitHubHttpError(
        'GraphQL request failed: 403',
        403,
        2_000,
        { headers: { 'retry-after': '2' } },
      ),
    });
    const transferIssue = vi.fn(remote.transferIssue!);
    remote.transferIssue = transferIssue;
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const sleep = vi.fn(async () => undefined);
    const execute = {
      ...common,
      idempotencyKey: 'bulk-verification-rate-limit-key',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    };

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep,
    })).rejects.toThrow('GraphQL request failed: 403');

    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      ambiguousCount: 1,
      connectorEnabled: false,
    });
    expect(transferIssue).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();

    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
    }, { remote, now: () => now })).resolves.toMatchObject({
      ambiguousCount: 0,
      transferredCount: 1,
    });
    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
    });
    expect(transferIssue).toHaveBeenCalledTimes(2);
  });

  it('automatically records changed transfer identities and preserves local task identity', async () => {
    const seeded = seedConnector('bulk-automatic-successor');
    const remote = createRemote(seeded, { changeIdentityOnTransfer: true });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-automatic-successor-run',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).resolves.toMatchObject({
      phase: 'completed',
      transferredCount: 2,
      ambiguousCount: 0,
      connectorEnabled: true,
    });

    const tasks = database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.connectorInstanceId, seeded.connectorId)).all();
    expect(tasks.map((task) => task.sourceId)).toEqual([
      'owner/target:101',
      'owner/target:102',
    ]);
    expect(identities.readGitHubTaskTransferBinding(
      database.default,
      seeded.connectorId,
      seeded.taskIds[0],
    )).toMatchObject({
      taskId: seeded.taskIds[0],
      stableId: `S_I_${seeded.connectorId}_1`,
      sourceId: 'owner/target:101',
    });
    const successions = database.default.select().from(schema.githubBulkTransferSuccessions).all()
      .filter((succession) => succession.taskId.startsWith(seeded.connectorId));
    expect(successions).toHaveLength(2);
    expect(successions[0]).toMatchObject({
      sourceStableIdDigest: sha256(`I_${seeded.connectorId}_1`),
      successorStableIdDigest: sha256(`S_I_${seeded.connectorId}_1`),
      successorSourceId: 'owner/target:101',
      actor: 'test-operator',
      reason: 'GitHub-confirmed native transfer created a successor identity',
    });
  });

  it('keeps manual successor reconciliation explicitly authorization-gated', async () => {
    const seeded = seedConnector('bulk-identity-successor');
    const remote = createRemote(seeded, {
      changeIdentityOnTransfer: true,
      targetResolutionError: new GitHubHttpError(
        'GraphQL request failed: 403',
        403,
        null,
        {},
      ),
    });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const execute = {
      ...common,
      idempotencyKey: 'bulk-identity-successor-run',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    };

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('GraphQL request failed: 403');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    const sourceStableId = `I_${seeded.connectorId}_1`;
    const successorStableId = `S_${sourceStableId}`;
    const authorization = {
      expectedSourceStableIdDigest: sha256(sourceStableId),
      expectedSuccessorStableIdDigest: sha256(successorStableId),
      reason: 'GitHub native transfer created the reviewed successor identity',
      idempotencyKey: 'successor-reconcile-1',
    };

    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
    }, { remote, now: () => now })).rejects.toThrow('explicit successor authorization');
    const dispatchAccepted = database.default.select()
      .from(schema.githubBulkTransferEvents).where(eq(
        schema.githubBulkTransferEvents.eventType,
        'dispatch_accepted',
      )).all().find((event) => (
        event.runId === run.id && event.taskId === seeded.taskIds[0]
      ))!;
    database.default.update(schema.githubBulkTransferEvents).set({
      payload: { ...dispatchAccepted.payload, targetNumber: 999 },
    }).where(eq(schema.githubBulkTransferEvents.id, dispatchAccepted.id)).run();
    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: authorization,
    }, { remote, now: () => now })).rejects.toThrow('disagrees with dispatch evidence');
    database.default.update(schema.githubBulkTransferEvents).set({
      payload: dispatchAccepted.payload,
    }).where(eq(schema.githubBulkTransferEvents.id, dispatchAccepted.id)).run();
    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: {
        ...authorization,
        expectedSuccessorStableIdDigest: 'f'.repeat(64),
      },
    }, { remote, now: () => now })).rejects.toThrow('target identity mismatch');
    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: authorization,
    }, { remote, now: () => now })).resolves.toMatchObject({
      phase: 'failed',
      ambiguousCount: 0,
      transferredCount: 1,
      connectorEnabled: false,
    });

    const task = database.default.select().from(schema.tasks)
      .where(eq(schema.tasks.id, seeded.taskIds[0])).get()!;
    expect(task).toMatchObject({
      id: seeded.taskIds[0],
      sourceId: 'owner/target:101',
      sourceListId: 'owner/target',
      metadata: {
        issueNumber: 101,
        nodeId: successorStableId,
        url: 'https://github.test/owner/target/issues/101',
        retained: true,
      },
    });
    expect(identities.readGitHubTaskTransferBinding(
      database.default,
      seeded.connectorId,
      seeded.taskIds[0],
    )).toMatchObject({
      taskId: seeded.taskIds[0],
      stableId: successorStableId,
      sourceId: 'owner/target:101',
    });
    const succession = database.default.select().from(schema.githubBulkTransferSuccessions)
      .where(eq(schema.githubBulkTransferSuccessions.runId, run.id)).get()!;
    expect(succession).toMatchObject({
      taskId: seeded.taskIds[0],
      sourceStableIdDigest: sha256(sourceStableId),
      successorStableIdDigest: sha256(successorStableId),
      sourceId: 'owner/source:1',
      successorSourceId: 'owner/target:101',
      targetNumber: 101,
      actor: 'incident-operator',
      idempotencyKey: 'successor-reconcile-1',
    });
    expect(succession.proofDigest).toMatch(/^[a-f0-9]{64}$/);
    const sourceLocator = database.default.select().from(schema.externalEntityLocators)
      .where(eq(schema.externalEntityLocators.externalEntityId, succession.sourceExternalEntityId))
      .get()!;
    expect(sourceLocator.validTo).toBe(now.toISOString());

    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: authorization,
    }, { remote, now: () => now })).resolves.toMatchObject({
      transferredCount: 1,
    });
    database.default.update(schema.githubBulkTransferSuccessions).set({
      proof: { ...succession.proof, targetNumber: 999 },
    }).where(eq(schema.githubBulkTransferSuccessions.id, succession.id)).run();
    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: authorization,
    }, { remote, now: () => now })).rejects.toThrow('replay proof is invalid');
    database.default.update(schema.githubBulkTransferSuccessions).set({
      proof: succession.proof,
    }).where(eq(schema.githubBulkTransferSuccessions.id, succession.id)).run();
    await expect(service.reconcileGitHubBulkTransferItem({
      runId: run.id,
      taskId: seeded.taskIds[0],
      targetNumber: 101,
      actor: 'incident-operator',
      successorAuthorization: {
        ...authorization,
        reason: 'different authorization',
      },
    }, { remote, now: () => now })).rejects.toThrow('belongs to another request');

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

  it('fails closed when an automatic successor identity is already bound', async () => {
    const seeded = seedConnector('bulk-successor-occupied');
    const remote = createRemote(seeded, { changeIdentityOnTransfer: true });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const occupiedTaskId = `${seeded.connectorId}-occupied`;
    database.default.insert(schema.tasks).values({
      id: occupiedTaskId,
      sourceId: 'owner/target:101',
      sourceListId: 'owner/target',
      sourceListName: 'owner/target',
      connectorType: 'github-issues',
      connectorInstanceId: seeded.connectorId,
      title: 'Conflicting successor task',
      description: '',
      status: 'todo',
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastSyncedAt: now.toISOString(),
    }).run();
    identities.persistExternalIdentityBatch([{
      target: {
        connectorInstanceId: seeded.connectorId,
        bindingType: 'task',
        localId: occupiedTaskId,
        legacyIdentity: 'owner/target:101',
      },
      evidence: issueEvidence(
        seeded.connectorId,
        'target',
        101,
        `S_I_${seeded.connectorId}_1`,
      ),
    }]);

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-successor-occupied-run',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('already bound');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      ambiguousCount: 1,
      connectorEnabled: false,
    });
    expect(identities.readGitHubTaskTransferBinding(
      database.default,
      seeded.connectorId,
      seeded.taskIds[0],
    )).toMatchObject({
      stableId: `I_${seeded.connectorId}_1`,
      sourceId: 'owner/source:1',
    });
  });

  it('fails closed when changed identity evidence names another target repository', async () => {
    const seeded = seedConnector('bulk-successor-target-mismatch');
    const remote = createRemote(seeded, {
      changeIdentityOnTransfer: true,
      mismatchTargetRepositoryOnTransfer: true,
    });
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });

    await expect(service.executeGitHubBulkTransfer({
      ...common,
      idempotencyKey: 'bulk-successor-target-mismatch-run',
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
    }, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('destination identity verification failed');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      ambiguousCount: 1,
      connectorEnabled: false,
    });
    expect(database.default.select().from(schema.githubBulkTransferSuccessions).all()
      .some((succession) => succession.runId === run.id)).toBe(false);
    expect(identities.readGitHubTaskTransferBinding(
      database.default,
      seeded.connectorId,
      seeded.taskIds[0],
    )).toMatchObject({
      stableId: `I_${seeded.connectorId}_1`,
      sourceId: 'owner/source:1',
    });
  });

  it.each([
    {
      name: 'issue number',
      locator: { owner: 'owner', repository: 'target', issueNumber: 999 },
    },
    {
      name: 'repository',
      locator: { owner: 'owner', repository: 'other', issueNumber: 101 },
    },
  ])('fails closed when the changed identity locator has a mismatched $name', async ({
    name,
    locator,
  }) => {
    const seeded = seedConnector(`bulk-successor-locator-${name.replace(' ', '-')}`);
    const remote = createRemote(seeded, {
      changeIdentityOnTransfer: true,
      targetIssueLocatorOverride: locator,
    });
    const transferIssue = vi.fn(remote.transferIssue!);
    remote.transferIssue = transferIssue;
    const common = input(seeded.connectorId);
    const preview = await service.previewGitHubBulkTransfer(common, {
      remote,
      now: () => now,
    });
    const execute = {
      ...common,
      idempotencyKey: `bulk-successor-locator-${name.replace(' ', '-')}-run`,
      planHash: preview.planHash,
      confirmation: 'owner/source=>owner/target',
      concurrency: 1,
    };

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('destination locator verification failed');
    const run = database.default.select().from(schema.githubBulkTransferRuns)
      .where(eq(
        schema.githubBulkTransferRuns.connectorInstanceId,
        seeded.connectorId,
      )).get()!;
    expect(service.getGitHubBulkTransferStatus(run.id)).toMatchObject({
      phase: 'failed',
      ambiguousCount: 1,
      connectorEnabled: false,
    });
    expect(database.default.select().from(schema.githubBulkTransferSuccessions).all()
      .some((succession) => succession.runId === run.id)).toBe(false);
    expect(identities.readGitHubTaskTransferBinding(
      database.default,
      seeded.connectorId,
      seeded.taskIds[0],
    )).toMatchObject({
      stableId: `I_${seeded.connectorId}_1`,
      sourceId: 'owner/source:1',
    });

    await expect(service.executeGitHubBulkTransfer(execute, {
      remote,
      now: () => now,
      sleep: async () => undefined,
    })).rejects.toThrow('unresolved post-dispatch item');
    expect(transferIssue.mock.calls.filter(([stableId]) => (
      stableId === `I_${seeded.connectorId}_1`
    ))).toHaveLength(1);
  });
});

function input(connectorInstanceId: string) {
  return {
    connectorInstanceId,
    sourceRepository: 'owner/source',
    targetRepository: 'owner/target',
    actor: 'test-operator',
    scope: { mode: 'all-issues' as const },
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

function reviewedScope(connectorInstanceId: string, issueNumbers: number[]) {
  return {
    mode: 'reviewed-allowlist' as const,
    sourceRepository: 'owner/source',
    manifestSha256: 'b'.repeat(64),
    issueNodeIds: issueNumbers.map((number) => `I_${connectorInstanceId}_${number}`),
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
    phase: 'complete',
    updatedAt: now.toISOString(),
  }).run();
  database.default.insert(schema.githubIdentityControls).values({
    connectorInstanceId: connectorId,
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
  ]);
  return { connectorId, taskIds };
}

function addBoundTask(
  seeded: ReturnType<typeof seedConnector>,
  issueNumber: number,
  status: 'todo' | 'cancelled',
): string {
  const taskId = `${seeded.connectorId}-${issueNumber}`;
  database.default.insert(schema.tasks).values({
    id: taskId,
    sourceId: `owner/source:${issueNumber}`,
    sourceListId: 'owner/source',
    sourceListName: 'owner/source',
    connectorType: 'github-issues',
    connectorInstanceId: seeded.connectorId,
    title: `Issue ${issueNumber}`,
    description: `Body ${issueNumber}`,
    status,
    metadata: { issueNumber, retained: true },
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    lastSyncedAt: now.toISOString(),
  }).run();
  identities.persistExternalIdentityBatch([{
    target: {
      connectorInstanceId: seeded.connectorId,
      bindingType: 'task',
      localId: taskId,
      legacyIdentity: `owner/source:${issueNumber}`,
    },
    evidence: issueEvidence(
      seeded.connectorId,
      'source',
      issueNumber,
      `I_${seeded.connectorId}_${issueNumber}`,
    ),
  }]);
  return taskId;
}

function addAuthoritativeDeletionProof(connectorId: string, taskId: string): string {
  database.default.insert(schema.githubIdentityBackfillItems).values({
    connectorInstanceId: connectorId,
    bindingType: 'task',
    localId: taskId,
    state: 'bound',
    observedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }).onConflictDoNothing().run();
  database.default.insert(schema.githubIdentityExceptionEvents).values({
    connectorInstanceId: connectorId,
    bindingType: 'task',
    localId: taskId,
    category: 'terminal_inaccessible',
    action: 'accept',
    idempotencyKey: `${taskId}-authoritative-deletion`,
    actor: 'test-operator',
    reason: 'Independently verified authoritative GitHub deletion',
    proofType: 'post_backfill_authoritative_deletion',
    createdAt: now.toISOString(),
  }).run();
  return `${taskId}-proof`;
}

function createRemote(
  seeded: ReturnType<typeof seedConnector>,
  options: {
    failAfterDispatch?: boolean;
    failSourceResolutionOnce?: boolean;
    rateLimitFirstDispatch?: boolean;
    firstDispatchError?: GitHubHttpError;
    targetResolutionError?: GitHubHttpError;
    changeIdentityOnTransfer?: boolean;
    mismatchTargetRepositoryOnTransfer?: boolean;
    targetIssueLocatorOverride?: {
      owner: string;
      repository: string;
      issueNumber: number;
    };
  } = {},
): GitHubRepositoryRepointRemote {
  const locations = new Map([
    [`I_${seeded.connectorId}_1`, { repository: 'owner/source', number: 1 }],
    [`I_${seeded.connectorId}_2`, { repository: 'owner/source', number: 2 }],
  ]);
  let transferCalls = 0;
  let sourceResolutionFailed = false;
  let targetResolutionRateLimited = false;
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
      if (
        options.targetResolutionError
        && repository === 'owner/target'
        && !targetResolutionRateLimited
      ) {
        targetResolutionRateLimited = true;
        throw options.targetResolutionError;
      }
      const match = [...locations.entries()].find(([, location]) => (
        location.repository === repository && location.number === issueNumber
      ));
      const evidence = match
        ? issueEvidence(
            seeded.connectorId,
            repository.endsWith('source') ? 'source' : 'target',
            issueNumber,
            match[0],
          )
        : null;
      if (
        evidence?.repository
        && options.mismatchTargetRepositoryOnTransfer
        && repository === 'owner/target'
      ) {
        evidence.repository.identity.stableId = 'R_wrong_target';
      }
      if (
        evidence
        && options.targetIssueLocatorOverride
        && repository === 'owner/target'
      ) {
        evidence.entity.locator = options.targetIssueLocatorOverride;
      }
      return evidence;
    },
    async transferIssue(issueStableId) {
      transferCalls++;
      if (options.rateLimitFirstDispatch && transferCalls === 1) {
        throw new GitHubHttpError('GraphQL request failed: 429', 429, 2_000);
      }
      if (options.firstDispatchError && transferCalls === 1) {
        throw options.firstDispatchError;
      }
      const targetNumber = 100 + transferCalls;
      const transferredStableId = options.changeIdentityOnTransfer
        ? `S_${issueStableId}`
        : issueStableId;
      if (options.changeIdentityOnTransfer) locations.delete(issueStableId);
      locations.set(transferredStableId, { repository: 'owner/target', number: targetNumber });
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
      locator: {
        owner: 'owner',
        repository,
        issueNumber,
        webUrl: `https://github.test/owner/${repository}/issues/${issueNumber}`,
      },
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

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
