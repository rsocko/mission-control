import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';

vi.unmock('@/db');
vi.unmock('drizzle-orm');
vi.unmock('crypto');
process.env.MC_DB_PATH = ':memory:';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'pull-agent-key': 'pull-secret-value',
  'push-agent-key': 'push-secret-value',
});

let db: typeof import('@/db').default;
let sqlite: typeof import('@/db').sqlite;
let schema: typeof import('@/db/schema');
let registry: typeof import('@/lib/external-agents/registry');
let service: typeof import('@/lib/external-agents/service');
let transports: typeof import('@/lib/external-agents/transports');
let receiveInboundResult: typeof import('@/app/api/inbound-webhooks/[id]/receive/route').POST;

const requiredFields = [
  'instruction',
  'execution.locality',
  'dispatchId',
  'dataClassification',
  'allowedActions',
];

beforeAll(async () => {
  const databaseModule = await import('@/db');
  const runtimeModule = await import('@/db/runtime');
  await runtimeModule.initializeRuntimeDatabase();
  const modules = await Promise.all([
    import('@/db/schema'),
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/service'),
    import('@/lib/external-agents/transports'),
    import('@/app/api/inbound-webhooks/[id]/receive/route'),
  ]);
  db = databaseModule.default;
  sqlite = databaseModule.sqlite;
  schema = modules[0];
  registry = modules[1];
  service = modules[2];
  transports = modules[3];
  receiveInboundResult = modules[4].POST;
  sqlite.prepare('SELECT 1').get();
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
    DELETE FROM inbound_webhook_log;
    DELETE FROM inbound_webhooks;
    DELETE FROM project_phase_items;
    DELETE FROM project_phases;
    DELETE FROM task_tags;
    DELETE FROM tags;
    DELETE FROM task_projects;
    DELETE FROM tasks;
    DELETE FROM hub_projects;
  `);
});

afterAll(async () => {
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  sqlite.close();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
});

function manualAgent(overrides: Partial<import('@/lib/external-agents/registry').ExternalAgentInput> = {}) {
  return registry.createExternalAgent({
    id: 'manual-agent',
    name: 'Manual reviewer',
    type: 'manual',
    endpoint: 'https://example.test/agent',
    capabilities: {
      canProposeTasks: true,
      canCreatePullRequest: true,
    },
    dataPolicy: {
      allowedClassifications: ['standard', 'restricted'],
      fieldAllowlist: [
        ...requiredFields,
        'project.id',
        'project.name',
        'tasks.id',
        'tasks.title',
        'tasks.description',
        'tasks.tags',
        'repository.fullName',
        'execution.createPullRequest',
      ],
      retentionDays: 1,
      maxRequestsPerMinute: 30,
    },
    ...overrides,
  });
}

function pullAgent(overrides: Partial<import('@/lib/external-agents/registry').ExternalAgentInput> = {}) {
  return registry.createExternalAgent({
    id: 'pull-agent',
    name: 'Pull worker',
    type: 'pull-queue',
    authType: 'bearer',
    authCredentialRef: 'pull-agent-key',
    capabilities: { canProposeTasks: true },
    dataPolicy: {
      allowedClassifications: ['standard'],
      fieldAllowlist: [...requiredFields, 'tasks.id', 'tasks.title'],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    ...overrides,
  });
}

async function seedTask(connectorType = 'github-issues') {
  const now = new Date().toISOString();
  await db.insert(schema.tasks).values({
    id: 'task-1',
    sourceId: 'source-task-1',
    connectorType,
    connectorInstanceId: `${connectorType}-1`,
    title: 'Implement control plane',
    description: 'Authorization: Bearer should-not-persist',
    status: 'todo',
    priority: 'high',
    metadata: {},
    syncStatus: 'synced',
    lastSyncedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(schema.tags).values({
    id: 'tag-1',
    name: 'backend',
    slug: 'backend',
    type: 'hub',
    confirmed: true,
    createdAt: now,
  });
  await db.insert(schema.taskTags).values({ taskId: 'task-1', tagId: 'tag-1' });
}

describe('external-agent registry boundaries', () => {
  it('keeps inference, MC-hosted, and GitHub-hosted execution explicit', async () => {
    await expect(registry.createExternalAgent({
      name: 'Unsafe inference',
      type: 'inference',
      endpoint: 'https://models.example.test/infer',
      capabilities: { canWriteCode: true },
    })).rejects.toMatchObject({ code: 'EXECUTION_BOUNDARY_MISMATCH' });

    await expect(registry.createExternalAgent({
      name: 'Cloud coding',
      type: 'copilot-cloud',
      authType: 'github-app',
      authCredentialRef: 'push-agent-key',
      endpoint: 'https://api.github.com/agents',
    })).rejects.toMatchObject({ code: 'EXECUTION_BOUNDARY_MISMATCH' });

    const hosted = await registry.createExternalAgent({
      name: 'Hosted coding',
      type: 'copilot-cloud',
      authType: 'github-user',
      authCredentialRef: 'push-agent-key',
      endpoint: 'https://api.github.com/agents',
    });
    expect(hosted).toMatchObject({
      transport: 'push',
      executionLocality: 'github-hosted',
    });
    await expect(service.createDispatchPreview({
      agentId: hosted.id,
      instruction: 'Change the repository',
      scope: { repository: 'owner/repo' },
      idempotencyKey: 'cloud-preview',
    })).resolves.toMatchObject({ status: 'needs_confirmation' });
    await expect(service.confirmDispatch(
      (await service.listDispatches())[0].id,
      (await service.listDispatches())[0].previewHash,
    )).rejects.toMatchObject({ code: 'TRANSPORT_NOT_IMPLEMENTED' });
    expect((await service.listDispatches())[0].status).toBe('failed');
  });

  it('never returns credential references to registry clients', async () => {
    const agent = await pullAgent();
    expect(registry.publicExternalAgent(agent)).toMatchObject({
      hasCredentialReference: true,
    });
    expect(registry.publicExternalAgent(agent)).not.toHaveProperty('authCredentialRef');
  });

  it('rejects endpoints with embedded credentials', async () => {
    await expect(registry.createExternalAgent({
      name: 'Embedded secret',
      type: 'manual',
      endpoint: 'https://user:password@example.test/agent',
    })).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
  });
});

describe('disclosure preview and manual result review', () => {
  it('blocks restricted and local-only context before external transmission', async () => {
    await registry.createExternalAgent({
      id: 'standard-only',
      name: 'Standard-only agent',
      type: 'manual',
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [...requiredFields, 'tasks.id', 'tasks.title'],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });
    await seedTask('outlook-email');
    await expect(service.createDispatchPreview({
      agentId: 'standard-only',
      instruction: 'Disclose restricted task',
      scope: { taskIds: ['task-1'] },
      idempotencyKey: 'restricted-block',
    })).rejects.toMatchObject({ code: 'DISCLOSURE_BLOCKED' });

    await expect(service.createDispatchPreview({
      agentId: 'standard-only',
      instruction: 'Disclose local-only instruction',
      dataClassification: 'local-only',
      idempotencyKey: 'local-only-block',
    })).rejects.toMatchObject({ code: 'DISCLOSURE_BLOCKED' });
  });

  it('persists one exact, redacted preview behind confirmation', async () => {
    await manualAgent();
    await seedTask();
    const first = await service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Review token=instruction-secret and propose work',
      scope: { taskIds: ['task-1', 'task-1'], repository: 'owner/repo' },
      allowedActions: ['propose_tasks'],
      idempotencyKey: 'preview-once',
    });
    const duplicate = await service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Review token=instruction-secret and propose work',
      scope: { taskIds: ['task-1', 'task-1'], repository: 'owner/repo' },
      allowedActions: ['propose_tasks'],
      idempotencyKey: 'preview-once',
    });

    expect(duplicate.id).toBe(first.id);
    expect(first.status).toBe('needs_confirmation');
    expect(first.payloadPreview).toMatchObject({
      execution: { locality: 'external' },
      tasks: [{
        id: 'task-1',
        title: 'Implement control plane',
        tags: ['backend'],
      }],
    });
    const serialized = JSON.stringify(first.payloadPreview);
    expect(serialized).not.toContain('instruction-secret');
    expect(serialized).not.toContain('should-not-persist');
    expect(first.disclosedFields).toEqual(expect.arrayContaining([
      'instruction',
      'tasks.description',
      'execution.locality',
    ]));
    expect(first.events).toHaveLength(1);

    await expect(service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Different request',
      idempotencyKey: 'preview-once',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const confirmed = await service.confirmDispatch(first.id, first.previewHash);
    expect(confirmed.dispatch.status).toBe('waiting_for_user');
    expect(confirmed.manualUrl).toBe('https://example.test/agent');
    expect(confirmed.dispatch.attempts).toHaveLength(1);
  });

  it('rejects confirmation when the reviewed destination changes', async () => {
    await manualAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Pin this destination',
      idempotencyKey: 'destination-pin',
    });
    await registry.updateExternalAgent('manual-agent', {
      endpoint: 'https://different.example.test/agent',
    });

    await expect(service.confirmDispatch(preview.id, preview.previewHash))
      .rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });
    expect((await service.getDispatch(preview.id))?.status).toBe('needs_confirmation');
  });

  it('correlates a redacted structured result and code references idempotently', async () => {
    await manualAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Return a proposal',
      idempotencyKey: 'manual-result',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    const result = {
      status: 'completed' as const,
      summary: 'Created a proposal token=result-secret',
      tasks: [{ title: 'Add dispatch worker', apiKey: 'result-key' }],
      codeChange: {
        repository: 'owner/repo',
        baseRef: 'main',
        branchRef: 'agent/control-plane',
        commitSha: '0123456789abcdef',
        pullRequestUrl: 'https://github.com/owner/repo/pull/42',
        checks: [{ name: 'test', status: 'success', url: 'https://ci.example.test/42' }],
        artifacts: [{ name: 'report', url: 'https://artifacts.example.test/report.json' }],
      },
      providerDetail: {
        state: 'done',
        accessToken: 'provider-secret',
      },
    };

    await expect(service.submitDispatchResult(
      preview.id,
      result,
      { agentAuthenticated: true },
    )).resolves.toEqual({ duplicate: false, status: 'completed' });
    await expect(service.submitDispatchResult(
      preview.id,
      result,
      { agentAuthenticated: false },
    )).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.submitDispatchResult(
      preview.id,
      result,
      { agentAuthenticated: true },
    )).resolves.toEqual({ duplicate: true, status: 'completed' });

    const dispatch = await service.getDispatch(preview.id);
    expect(dispatch).toMatchObject({
      status: 'completed',
      resultStatus: 'pending_review',
      repository: 'owner/repo',
      baseRef: 'main',
      branchRef: 'agent/control-plane',
      commitSha: '0123456789abcdef',
      githubPullRequestUrl: 'https://github.com/owner/repo/pull/42',
      checks: [{ name: 'test', status: 'success' }],
      artifacts: [{ name: 'report' }],
    });
    const stored = JSON.stringify(dispatch);
    expect(stored).not.toContain('result-secret');
    expect(stored).not.toContain('result-key');
    expect(stored).not.toContain('provider-secret');
    await service.reviewDispatchResult(preview.id, 'accepted');
    expect((await service.getDispatch(preview.id))?.resultStatus).toBe('accepted');
  });
});

describe('pull lifecycle, retries, cancellation, and timeout', () => {
  it('claims atomically, enforces the lease token, and deduplicates completion', async () => {
    await pullAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'pull-agent',
      instruction: 'Propose tasks',
      allowedActions: ['propose_tasks'],
      idempotencyKey: 'pull-complete',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    const claim = (await service.claimNextDispatch('pull-agent'))!;

    expect(claim.dispatchId).toBe(preview.id);
    await expect(service.claimNextDispatch('pull-agent')).resolves.toBeNull();
    await expect(service.submitDispatchResult(
      preview.id,
      { status: 'in_progress', providerState: 'running' },
      { claimToken: 'wrong' },
    )).rejects.toThrow(/Invalid claim token/);
    await expect(service.submitDispatchResult(
      preview.id,
      { status: 'queued', providerState: 'requeue' },
      { claimToken: claim.claimToken },
    )).rejects.toThrow(/cannot return an active claim to the queue/);
    await expect(service.submitDispatchResult(
      preview.id,
      { status: 'waiting_for_user', providerState: 'waiting_for_user' },
      { claimToken: claim.claimToken },
    )).resolves.toMatchObject({ status: 'waiting_for_user' });
    await expect(service.submitDispatchResult(
      preview.id,
      { status: 'in_progress', providerState: 'resumed' },
      { claimToken: claim.claimToken },
    )).resolves.toMatchObject({ status: 'in_progress' });
    const completion = {
      status: 'completed' as const,
      summary: 'Proposed one task',
      tasks: [{ title: 'One task' }],
    };
    await expect(service.submitDispatchResult(
      preview.id,
      completion,
      { claimToken: claim.claimToken },
    )).resolves.toEqual({ duplicate: false, status: 'completed' });
    await expect(service.submitDispatchResult(
      preview.id,
      completion,
      { claimToken: 'wrong' },
    )).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(service.submitDispatchResult(
      preview.id,
      completion,
      { claimToken: claim.claimToken },
    )).resolves.toEqual({ duplicate: true, status: 'completed' });
  });

  it('dead-letters an expired final lease and permits only an explicit retry', async () => {
    await pullAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'pull-agent',
      instruction: 'Lease-bound work',
      idempotencyKey: 'lease-expiry',
      maxAttempts: 1,
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    await service.claimNextDispatch('pull-agent', { leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    await expect(service.claimNextDispatch('pull-agent')).resolves.toBeNull();
    expect((await service.getDispatch(preview.id))?.status).toBe('dead_letter');
    await service.retryDispatch(preview.id);
    const retry = await service.claimNextDispatch('pull-agent');
    expect(retry).toMatchObject({ attempt: 2, dispatchId: preview.id });
  });

  it('cancels idempotently and times out work at its durable deadline', async () => {
    await pullAgent();
    const cancelled = await service.createDispatchPreview({
      agentId: 'pull-agent',
      instruction: 'Cancel this',
      idempotencyKey: 'cancel-me',
    });
    await service.confirmDispatch(cancelled.id, cancelled.previewHash);
    await expect(service.cancelDispatch(cancelled.id)).resolves.toBe(true);
    await expect(service.cancelDispatch(cancelled.id)).resolves.toBe(false);
    expect((await service.getDispatch(cancelled.id))?.status).toBe('cancelled');

    const timed = await service.createDispatchPreview({
      agentId: 'pull-agent',
      instruction: 'Time out',
      idempotencyKey: 'timeout-me',
      timeoutMs: 1,
    });
    await service.confirmDispatch(timed.id, timed.previewHash);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(service.expireDispatches()).resolves.toBe(1);
    expect((await service.getDispatch(timed.id))?.status).toBe('timed_out');
  });

  it('atomically times out an overdue dispatch instead of accepting its result', async () => {
    await pullAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'pull-agent',
      instruction: 'Reject results after this deadline',
      idempotencyKey: 'late-result',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    const claim = (await service.claimNextDispatch('pull-agent'))!;
    sqlite.prepare(`
      UPDATE agent_dispatches SET deadline_at = ?
      WHERE id = ?
    `).run(new Date(Date.now() - 1_000).toISOString(), preview.id);

    await expect(service.submitDispatchResult(
      preview.id,
      { status: 'completed', summary: 'Too late' },
      { claimToken: claim.claimToken },
    )).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });

    const dispatch = await service.getDispatch(preview.id);
    expect(dispatch).toMatchObject({
      status: 'timed_out',
      result: null,
    });
    expect(dispatch?.events.filter(({ eventType }) => eventType === 'timed_out'))
      .toHaveLength(1);
    expect(dispatch?.events.some(({ eventType }) => eventType === 'result_received'))
      .toBe(false);
  });
});

describe('push credentials, provider detail, rate limits, and cleanup', () => {
  it('atomically times out a synchronous transport result received after its deadline', async () => {
    const agent = await registry.createExternalAgent({
      id: 'late-push',
      name: 'Late synchronous push',
      type: 'webhook-roundtrip',
      endpoint: 'https://agent.example.test/run',
      capabilities: { canProposeTasks: true },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [...requiredFields],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const dispatchId = new Headers(init?.headers).get('x-mc-dispatch-id');
      sqlite.prepare(`
        UPDATE agent_dispatches SET deadline_at = ?
        WHERE id = ?
      `).run(new Date(Date.now() - 1_000).toISOString(), dispatchId);
      return Response.json({
        status: 'completed',
        result: { summary: 'This result arrived too late' },
      });
    }) as typeof fetch;
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Do not accept a late synchronous response',
      idempotencyKey: 'late-synchronous-push',
    });

    await expect(service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: transports.createTransportResolver({ fetcher }),
    })).rejects.toMatchObject({ code: 'DEADLINE_EXPIRED' });

    const dispatch = await service.getDispatch(preview.id);
    expect(dispatch).toMatchObject({
      status: 'timed_out',
      result: null,
      attempts: [expect.objectContaining({ status: 'timed_out' })],
    });
    expect(dispatch?.events.filter(({ eventType }) => eventType === 'timed_out'))
      .toHaveLength(1);
    expect(dispatch?.events.some(({ eventType }) => eventType === 'transport_state'))
      .toBe(false);
  });

  it('injects credentials only into transport headers and preserves provider state detail', async () => {
    const agent = await registry.createExternalAgent({
      id: 'push-agent',
      name: 'Webhook worker',
      type: 'webhook-roundtrip',
      endpoint: 'https://agent.example.test/run',
      authType: 'bearer',
      authCredentialRef: 'push-agent-key',
      capabilities: { canProposeTasks: true },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [...requiredFields],
        retentionDays: 30,
        maxRequestsPerMinute: 1,
      },
    });

    let sentHeaders: Headers | undefined;
    let sentBody = '';
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      sentHeaders = new Headers(init?.headers);
      sentBody = String(init?.body);
      return Response.json({
        id: 'provider-task-9',
        status: 'queued_at_provider',
        queue: 'priority',
        credential: 'provider-response-secret',
      });
    }) as typeof fetch;
    const resolver = transports.createTransportResolver({ fetcher });
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Run externally',
      allowedActions: ['propose_tasks'],
      idempotencyKey: 'push-once',
    });

    await service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: resolver,
    });
    expect(sentHeaders?.get('authorization')).toBe('Bearer push-secret-value');
    expect(sentHeaders?.get('idempotency-key')).toBe(`${preview.id}:1`);
    expect(sentBody).not.toContain('push-secret-value');
    const dispatch = await service.getDispatch(preview.id);
    expect(dispatch).toMatchObject({
      status: 'in_progress',
      providerTaskId: 'provider-task-9',
      providerDetail: {
        id: 'provider-task-9',
        status: 'queued_at_provider',
        queue: 'priority',
      },
    });
    expect(JSON.stringify(dispatch)).not.toContain('provider-response-secret');
    expect(JSON.stringify(dispatch)).not.toContain('push-secret-value');
    await service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: resolver,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    const second = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Rate limited',
      idempotencyKey: 'push-two',
    });
    await expect(service.confirmDispatch(second.id, second.previewHash, {
      transportResolver: resolver,
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });

    await service.cancelDispatch(preview.id);
    await expect(service.retryDispatch(preview.id, {
      transportResolver: resolver,
    })).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await service.getDispatch(preview.id))?.status).toBe('cancelled');
    expect((await service.getDispatch(preview.id))?.events
      .some(({ eventType }) => eventType === 'retry_requested')).toBe(false);
  });

  it('replays an interrupted push attempt with the same provider idempotency key', async () => {
    const agent = await registry.createExternalAgent({
      id: 'recoverable-push',
      name: 'Recoverable push',
      type: 'webhook-roundtrip',
      endpoint: 'https://agent.example.test/run',
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [...requiredFields],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });
    const keys: string[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      keys.push(new Headers(init?.headers).get('idempotency-key') ?? '');
      throw new Error('simulated process interruption');
    }) as typeof fetch;
    const resolver = transports.createTransportResolver({ fetcher });
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Recover this delivery',
      idempotencyKey: 'recover-push',
    });
    await expect(service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: resolver,
    })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });

    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'in_progress', error_message = NULL, completed_at = NULL,
          lease_expires_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(preview.id);
    await expect(service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: resolver,
    })).rejects.toMatchObject({ code: 'TRANSPORT_ERROR' });
    expect(keys).toEqual([`${preview.id}:1`, `${preview.id}:1`]);
    expect((await service.getDispatch(preview.id))?.events)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: 'attempt_recovered' }),
      ]));
  });

  it('removes terminal records according to the per-agent retention policy', async () => {
    await manualAgent();
    const preview = await service.createDispatchPreview({
      agentId: 'manual-agent',
      instruction: 'Old result',
      idempotencyKey: 'cleanup',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    await service.submitDispatchResult(
      preview.id,
      { status: 'failed', errorMessage: 'old failure' },
      { agentAuthenticated: true },
    );
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET completed_at = '2000-01-01T00:00:00.000Z'
      WHERE id = ?
    `).run(preview.id);

    await expect(service.cleanupExpiredDispatches()).resolves.toBe(1);
    expect(await service.getDispatch(preview.id)).toBeNull();
  });

  it('correlates HMAC-authenticated inbound results without logging secrets', async () => {
    const now = new Date().toISOString();
    await db.insert(schema.inboundWebhooks).values({
      id: 'agent-callback',
      name: 'Agent callback',
      sourceLabel: 'agent',
      secret: 'callback-secret',
      enabled: true,
      defaultAction: 'auto',
      fieldMappings: {},
      totalReceived: 0,
      createdAt: now,
      updatedAt: now,
    });
    const agent = await registry.createExternalAgent({
      id: 'callback-agent',
      name: 'Callback worker',
      type: 'webhook-roundtrip',
      endpoint: 'https://agent.example.test/run',
      inboundWebhookId: 'agent-callback',
      capabilities: { canProposeTasks: true },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [...requiredFields, 'callbackUrl'],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Return through callback',
      idempotencyKey: 'callback-result',
      callbackBaseUrl: 'https://mc.example.test',
    });
    await service.confirmDispatch(preview.id, preview.previewHash, {
      transportResolver: transports.createTransportResolver({
        fetcher: vi.fn(async () => Response.json({ status: 'queued' })) as typeof fetch,
      }),
    });
    const payload = JSON.stringify({
      type: 'agent-result',
      dispatchId: preview.id,
      status: 'completed',
      summary: 'Done token=callback-result-secret',
      tasks: [{ title: 'Review proposal', password: 'task-secret' }],
    });
    const signature = `sha256=${createHmac('sha256', 'callback-secret').update(payload).digest('hex')}`;
    const response = await receiveInboundResult(new Request(
      'https://mc.example.test/api/inbound-webhooks/agent-callback/receive',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
        },
        body: payload,
      },
    ), {
      params: Promise.resolve({ id: 'agent-callback' }),
    });

    expect(response.status).toBe(202);
    expect((await service.getDispatch(preview.id))?.status).toBe('completed');
    const logs = await db.select().from(schema.inboundWebhookLog);
    expect(JSON.stringify(logs)).not.toContain('callback-result-secret');
    expect(JSON.stringify(logs)).not.toContain('task-secret');

    const ordinaryPayload = JSON.stringify({
      dispatchId: preview.id,
      title: 'Ordinary webhook task',
      description: 'A dispatch identifier alone does not make this an agent result.',
    });
    const ordinarySignature = `sha256=${createHmac('sha256', 'callback-secret')
      .update(ordinaryPayload)
      .digest('hex')}`;
    const ordinaryResponse = await receiveInboundResult(new Request(
      'https://mc.example.test/api/inbound-webhooks/agent-callback/receive',
      {
        method: 'POST',
        headers: { 'X-Webhook-Signature': ordinarySignature },
        body: ordinaryPayload,
      },
    ), {
      params: Promise.resolve({ id: 'agent-callback' }),
    });
    expect(ordinaryResponse.status).toBe(201);
    expect(await ordinaryResponse.json()).toMatchObject({ success: true, created: 'task' });
    expect((await service.getDispatch(preview.id))?.status).toBe('completed');

    await registry.updateExternalAgent(agent.id, { enabled: false });
    const disabledPayload = JSON.stringify({
      type: 'agent-result',
      dispatchId: preview.id,
      status: 'completed',
      summary: 'Forged duplicate',
    });
    const disabledSignature = `sha256=${createHmac('sha256', 'callback-secret').update(disabledPayload).digest('hex')}`;
    const disabledResponse = await receiveInboundResult(new Request(
      'https://mc.example.test/api/inbound-webhooks/agent-callback/receive',
      {
        method: 'POST',
        headers: { 'X-Webhook-Signature': disabledSignature },
        body: disabledPayload,
      },
    ), {
      params: Promise.resolve({ id: 'agent-callback' }),
    });
    expect(disabledResponse.status).toBe(404);
  });
});
