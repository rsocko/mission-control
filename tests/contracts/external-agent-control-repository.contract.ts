import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ExternalAgentControlPersistence } from '@/db/persistence/external-agent-control';
import type {
  AgentDispatchRecord,
  ExternalAgentRecord,
} from '@/lib/external-agents/contracts';

export interface ExternalAgentControlContractSeed {
  reset(): Promise<void>;
  protectedWebhook(id: string): Promise<void>;
}

const now = '2026-01-01T00:00:00.000Z';

function agent(id: string, inboundWebhookId: string | null = null): ExternalAgentRecord {
  return {
    id,
    name: 'Contract pull agent',
    type: 'pull-queue',
    transport: 'pull',
    executionLocality: 'external',
    description: null,
    endpoint: null,
    authType: 'bearer',
    authCredentialRef: 'contract-secret',
    capabilities: { canProposeTasks: true },
    inputFormat: 'mc-tasks',
    outputFormat: 'mc-tasks',
    inboundWebhookId,
    dataPolicy: {
      allowedClassifications: ['standard'],
      fieldAllowlist: [
        'instruction',
        'execution.locality',
        'dispatchId',
        'dataClassification',
        'allowedActions',
      ],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    enabled: true,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function dispatch(id: string, agentId: string, key = id): AgentDispatchRecord {
  return {
    id,
    externalAgentId: agentId,
    idempotencyKey: key,
    instruction: 'Propose work',
    scope: {},
    status: 'needs_confirmation',
    transport: 'pull',
    executionLocality: 'external',
    dataClassification: 'standard',
    allowedActions: ['propose_tasks'],
    disclosedFields: ['instruction'],
    payloadPreview: { instruction: 'Propose work', dispatchId: id },
    previewHash: `hash-${id}`,
    providerTaskId: null,
    providerDetail: null,
    result: null,
    resultDigest: null,
    resultStatus: null,
    claimTokenHash: null,
    claimedAt: null,
    leaseExpiresAt: null,
    attemptCount: 0,
    maxAttempts: 2,
    availableAt: now,
    deadlineAt: null,
    cancelRequestedAt: null,
    githubIssueUrl: null,
    githubPullRequestUrl: null,
    repository: null,
    baseRef: null,
    branchRef: null,
    commitSha: null,
    checks: null,
    artifacts: null,
    errorMessage: null,
    confirmedAt: null,
    startedAt: null,
    completedAt: null,
    reviewedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

export function externalAgentControlRepositoryContract(
  backend: string,
  repository: () => ExternalAgentControlPersistence,
  seed: () => ExternalAgentControlContractSeed,
) {
  describe(`${backend} external-agent control persistence contract`, () => {
    beforeEach(async () => seed().reset());

    it('atomically validates protected callbacks and preserves soft-delete filters', async () => {
      await expect(repository().registry.create(agent('missing-callback', 'missing')))
        .rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
      await seed().protectedWebhook('callback');
      const created = await repository().registry.create(agent('registered', 'callback'));
      expect(created.inboundWebhookId).toBe('callback');
      expect(await repository().registry.softDelete(created.id, now)).toBe(true);
      expect(await repository().registry.get(created.id)).toBeNull();
      expect(await repository().registry.get(created.id, true)).toMatchObject({
        enabled: false,
        deletedAt: now,
      });
    });

    it('creates previews idempotently and rejects semantic drift', async () => {
      await repository().registry.create(agent('preview-agent'));
      const record = dispatch('dispatch-1', 'preview-agent', 'same-key');
      const event = {
        eventType: 'preview_created',
        fromStatus: null,
        toStatus: 'needs_confirmation' as const,
        detail: { credential: 'already-redacted' },
        createdAt: now,
      };
      await expect(repository().dispatches.createPreview(record, event)).resolves.toMatchObject({
        id: record.id,
        created: true,
      });
      await expect(repository().dispatches.createPreview(record, event)).resolves.toMatchObject({
        id: record.id,
        created: false,
      });
      await expect(repository().dispatches.createPreview(
        { ...record, id: 'dispatch-2', previewHash: 'different' },
        event,
      )).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
      expect((await repository().dispatches.get(record.id))?.events).toHaveLength(1);
    });

    it('claims oldest work once, stores only a token hash, and deduplicates results', async () => {
      await repository().registry.create(agent('pull-agent'));
      const record = dispatch('claim-dispatch', 'pull-agent');
      await repository().dispatches.createPreview(record, {
        eventType: 'preview_created',
        fromStatus: null,
        toStatus: 'needs_confirmation',
        detail: {},
        createdAt: now,
      });
      await repository().dispatches.confirm({
        id: record.id,
        agentId: 'pull-agent',
        agentSnapshot: agent('pull-agent'),
        previewHash: record.previewHash,
        currentPreviewHash: record.previewHash,
        maxRequestsPerMinute: 30,
        now,
      });
      const tokenHash = createHash('sha256').update('plaintext-token').digest('hex');
      const claim = await repository().dispatches.claimNext({
        agentId: 'pull-agent',
        attemptId: 'attempt-1',
        claimTokenHash: tokenHash,
        now: '2026-01-01T00:00:01.000Z',
        leaseExpiresAt: '2026-01-01T00:02:01.000Z',
      });
      expect(claim).toMatchObject({ dispatchId: record.id, attempt: 1 });
      expect(await repository().dispatches.claimNext({
        agentId: 'pull-agent',
        attemptId: 'attempt-2',
        claimTokenHash: tokenHash,
        now: '2026-01-01T00:00:02.000Z',
        leaseExpiresAt: '2026-01-01T00:02:02.000Z',
      })).toBeNull();
      expect((await repository().dispatches.get(record.id))?.claimTokenHash).toBe(tokenHash);

      const result = {
        dispatchId: record.id,
        status: 'completed' as const,
        result: { summary: 'Done' },
        providerTaskId: 'provider-1',
        providerState: 'done',
        providerDetail: { state: 'done' },
        errorMessage: null,
        repository: null,
        baseRef: null,
        branchRef: null,
        commitSha: null,
        pullRequestUrl: null,
        digest: 'canonical-result',
        authorization: { claimTokenHash: tokenHash },
        leaseExpiresAt: '2026-01-01T00:03:00.000Z',
        now: '2026-01-01T00:00:03.000Z',
      };
      await expect(repository().dispatches.submitResult(result)).resolves.toEqual({
        duplicate: false,
        status: 'completed',
      });
      await expect(repository().dispatches.submitResult(result)).resolves.toEqual({
        duplicate: true,
        status: 'completed',
      });
      await expect(repository().dispatches.submitResult({
        ...result,
        digest: 'conflicting-result',
      })).rejects.toMatchObject({ code: 'TERMINAL_DISPATCH' });
    });

    it('fences stale transport completions and rolls back a failed attempt insert', async () => {
      const pushAgent = {
        ...agent('push-agent'),
        type: 'manual' as const,
        transport: 'manual' as const,
        authType: 'none' as const,
        authCredentialRef: null,
      };
      await repository().registry.create(pushAgent);
      const first = {
        ...dispatch('push-dispatch', 'push-agent'),
        transport: 'manual' as const,
      };
      await repository().dispatches.createPreview(first, {
        eventType: 'preview_created',
        fromStatus: null,
        toStatus: 'needs_confirmation',
        detail: {},
        createdAt: now,
      });
      await repository().dispatches.confirm({
        id: first.id,
        agentId: first.externalAgentId,
        agentSnapshot: pushAgent,
        previewHash: first.previewHash,
        currentPreviewHash: first.previewHash,
        maxRequestsPerMinute: 30,
        now,
      });
      const started = await repository().dispatches.beginAttempt({
        id: first.id,
        attemptId: 'duplicate-attempt-id',
        now,
        leaseExpiresAt: '2026-01-01T00:00:01.000Z',
      });
      const resumed = await repository().dispatches.resumeAttempt({
        id: first.id,
        now: '2026-01-01T00:00:02.000Z',
        leaseExpiresAt: '2026-01-01T00:02:02.000Z',
      });
      const finalize = {
        dispatchId: first.id,
        attempt: 1,
        status: 'completed' as const,
        providerTaskId: 'provider',
        result: { summary: 'Done' },
        resultDigest: 'digest',
        resultStatus: 'pending_review' as const,
        errorMessage: null,
        repository: null,
        baseRef: null,
        branchRef: null,
        commitSha: null,
        pullRequestUrl: null,
        now: '2026-01-01T00:00:03.000Z',
      };
      await expect(repository().dispatches.finalizeAttempt({
        ...finalize,
        leaseExpiresAt: started!.leaseExpiresAt,
      })).resolves.toBe('stale');
      await expect(repository().dispatches.finalizeAttempt({
        ...finalize,
        leaseExpiresAt: resumed!.leaseExpiresAt,
      })).resolves.toBe('updated');

      const second = {
        ...dispatch('rollback-dispatch', 'push-agent'),
        transport: 'manual' as const,
      };
      await repository().dispatches.createPreview(second, {
        eventType: 'preview_created',
        fromStatus: null,
        toStatus: 'needs_confirmation',
        detail: {},
        createdAt: now,
      });
      await repository().dispatches.confirm({
        id: second.id,
        agentId: second.externalAgentId,
        agentSnapshot: pushAgent,
        previewHash: second.previewHash,
        currentPreviewHash: second.previewHash,
        maxRequestsPerMinute: 30,
        now,
      });
      await expect(repository().dispatches.beginAttempt({
        id: second.id,
        attemptId: 'duplicate-attempt-id',
        now,
        leaseExpiresAt: '2026-01-01T00:02:00.000Z',
      })).rejects.toBeDefined();
      expect(await repository().dispatches.get(second.id)).toMatchObject({
        status: 'queued',
        attemptCount: 0,
        attempts: [],
      });
    });
  });
}
