import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
process.env.MC_API_KEY = 'task-delegation-test-key';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'github-user-test': 'github-token',
  'paperclip-test': 'paperclip-token',
});

let sqlite: typeof import('@/db').sqlite;
let registry: typeof import('@/lib/external-agents/registry');
let delegation: typeof import('@/lib/external-agents/task-delegation');
let singleRoute: typeof import('@/app/api/tasks/[id]/delegation/route');
let bulkRoute: typeof import('@/app/api/tasks/delegation/route');

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const assigneeAgentId = '33333333-3333-4333-8333-333333333333';
const policyFields = [
  'instruction',
  'repository.fullName',
  'repository.defaultBranch',
  'execution.locality',
  'execution.baseRef',
  'execution.model',
  'execution.createPullRequest',
  'tasks.id',
  'tasks.title',
  'tasks.status',
  'dispatchId',
  'dataClassification',
  'allowedActions',
];

function mutationRequest(url: string, body: unknown) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mc-api-key': 'task-delegation-test-key',
    },
    body: JSON.stringify(body),
  });
}

async function createCloudAgent(overrides: Partial<
  import('@/lib/external-agents/registry').ExternalAgentInput
> = {}) {
  return registry.createExternalAgent({
    id: 'github-cloud',
    name: 'GitHub Copilot Cloud',
    type: 'copilot-cloud',
    endpoint: 'https://api.github.com',
    authType: 'github-user',
    authCredentialRef: 'github-user-test',
    capabilities: {
      canAnalyzeCode: true,
      canWriteCode: true,
      canRunCommands: true,
      canPush: true,
      canCreatePullRequest: true,
    },
    dataPolicy: {
      allowedClassifications: ['standard'],
      fieldAllowlist: policyFields,
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    ...overrides,
  });
}

async function createPaperclipAgent() {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/health') return Response.json({ status: 'ok' });
    return Response.json({
      id: assigneeAgentId,
      companyId,
      adapterType: 'github-copilot-web',
    });
  };
  try {
    return await registry.createExternalAgent({
      id: 'paperclip-route',
      name: 'Paperclip build route',
      type: 'paperclip',
      endpoint: 'https://paperclip.example.test',
      authType: 'bearer',
      authCredentialRef: 'paperclip-test',
      providerConfig: {
        paperclip: {
          companyId,
          projectId,
          assigneeAgentId,
          requiredAdapterType: 'github-copilot-web',
        },
      },
      capabilities: {
        canAnalyzeCode: true,
        canWriteCode: true,
        canRunCommands: true,
      },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: policyFields,
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [registry, delegation, singleRoute, bulkRoute] = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/task-delegation'),
    import('@/app/api/tasks/[id]/delegation/route'),
    import('@/app/api/tasks/delegation/route'),
  ]);
  sqlite = databaseModule.sqlite;
}, 30_000);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
    DELETE FROM source_lists;
    DELETE FROM connector_configs;
    DELETE FROM tasks;

    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials, settings,
      synced_lists, created_at, updated_at
    ) VALUES (
      'github-source', 'github-issues', 'GitHub issues', 1, 'poll', '{}', '{}',
      '{"repos":["octo/validated"]}', '[]',
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'
    );
    INSERT INTO source_lists (
      id, connector_instance_id, source_id, name, type, task_count, sort_order, hidden
    ) VALUES (
      'repo-validated', 'github-source', 'octo/validated', 'Validated repo',
      'repo', 0, 0, 0
    );

    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, status,
      priority, created_at, updated_at, last_synced_at
    ) VALUES
      (
        'task-github', 'octo/source:17', 'github-issues', 'github-source',
        'Fix the parser', 'todo', 'high',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      ),
      (
        'task-local', 'todo-1', 'microsoft-todo', 'todo-source',
        'Write release notes', 'todo', 'medium',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      ),
      (
        'task-done', 'octo/source:18', 'github-issues', 'github-source',
        'Already shipped', 'done', 'low',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      ),
      (
        'task-restricted', 'private-1', 'custom-rest', 'private-source',
        'Private deployment', 'todo', 'critical',
        '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
        '2026-10-01T00:00:00.000Z'
      );
  `);
});

afterAll(async () => {
  sqlite?.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
});

describe('provider-neutral task delegation API', () => {
  it('maps every canonical and provider liveness state for task surfaces', () => {
    const base = { status: 'queued' } as import(
      '@/lib/external-agents/contracts'
    ).AgentDispatchRecord;
    expect(delegation.taskDelegationDisplayState(base, null)).toBe('queued');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'claimed' },
      null,
    )).toBe('running');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'in_progress' },
      { progress: { livenessState: 'idle' } },
    )).toBe('idle');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'waiting_for_user' },
      null,
    )).toBe('waiting_for_user');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'completed' },
      null,
    )).toBe('completed');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'failed' },
      null,
    )).toBe('failed');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'timed_out' },
      null,
    )).toBe('timed_out');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'cancelled' },
      null,
    )).toBe('cancelled');
    expect(delegation.taskDelegationDisplayState(
      { ...base, status: 'in_progress' },
      { issueStatus: 'blocked' },
    )).toBe('blocked');
  });

  it('returns configured typed destinations with exact repository and route bindings', async () => {
    await Promise.all([createCloudAgent(), createPaperclipAgent()]);

    const response = await bulkRoute.GET(new Request(
      'http://localhost/api/tasks/delegation?taskId=task-github&taskId=task-local',
    ));
    expect(response.status).toBe(200);
    const context = await response.json();

    expect(context.targets).toHaveLength(2);
    expect(context.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'github-cloud',
        type: 'copilot-cloud',
        executionLocality: 'github-hosted',
        repositories: [
          expect.objectContaining({ repository: 'octo/validated' }),
        ],
        eligibility: expect.arrayContaining([
          expect.objectContaining({
            taskId: 'task-github',
            ready: true,
            repository: 'octo/source',
            repositoryLocked: true,
          }),
          expect.objectContaining({
            taskId: 'task-local',
            ready: true,
            repository: null,
            repositoryLocked: false,
          }),
        ]),
      }),
      expect.objectContaining({
        id: 'paperclip-route',
        type: 'paperclip',
        paperclipBinding: {
          companyId,
          projectId,
          assigneeAgentId,
          requiredAdapterType: 'github-copilot-web',
        },
      }),
    ]));
  });

  it('locks GitHub tasks to their source repository and replays an atomic preview', async () => {
    await createCloudAgent();
    const changedRepository = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-github/delegation',
      {
        agentId: 'github-cloud',
        operationId: 'locked-repository',
        repository: 'octo/validated',
        instruction: 'Fix the parser',
        allowedActions: ['write_code'],
      },
    ), { params: Promise.resolve({ id: 'task-github' }) });
    expect(changedRepository.status).toBe(409);

    const body = {
      agentId: 'github-cloud',
      operationId: 'single-idempotency',
      repository: 'octo/source',
      baseRef: 'main',
      model: 'auto',
      instruction: 'Fix the parser',
      allowedActions: ['write_code', 'create_pull_request'],
      createPullRequest: true,
      maxAttempts: 4,
      timeoutMs: 3_600_000,
    };
    const first = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-github/delegation',
      body,
    ), { params: Promise.resolve({ id: 'task-github' }) });
    const replay = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-github/delegation',
      body,
    ), { params: Promise.resolve({ id: 'task-github' }) });
    const firstPreview = await first.json();
    const replayPreview = await replay.json();

    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replayPreview.dispatchId).toBe(firstPreview.dispatchId);
    expect(firstPreview.payloadPreview).toMatchObject({
      repository: { fullName: 'octo/source', defaultBranch: 'main' },
      execution: { model: 'auto', createPullRequest: true },
      tasks: [{ id: 'task-github', title: 'Fix the parser' }],
    });
    expect(firstPreview.payloadPreview.tasks[0]).not.toHaveProperty('sourceId');
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 1 });
    const previewContext = await singleRoute.GET(
      new Request('http://localhost/api/tasks/task-github/delegation'),
      { params: Promise.resolve({ id: 'task-github' }) },
    );
    expect(await previewContext.json()).toMatchObject({
      assignments: [{
        dispatchId: firstPreview.dispatchId,
        displayState: 'preview',
        canCancel: true,
        canStopTracking: false,
        cancellationLimitation: null,
      }],
    });
  });

  it('atomically prevents concurrent operations from reserving the same task', async () => {
    await createCloudAgent();
    const input = {
      taskId: 'task-github',
      agentId: 'github-cloud',
      repository: 'octo/source',
      instruction: 'Fix the parser',
      allowedActions: ['write_code'],
    };
    const results = await Promise.allSettled([
      delegation.previewTaskDelegation({ ...input, operationId: 'concurrent-a' }),
      delegation.previewTaskDelegation({ ...input, operationId: 'concurrent-b' }),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: {
        code: expect.stringMatching(/CONFLICT|DISCLOSURE_BLOCKED/),
        status: expect.any(Number),
      },
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 1 });
  });

  it('allows non-GitHub tasks to use only configured repositories', async () => {
    await createCloudAgent();
    const invalid = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-local/delegation',
      {
        agentId: 'github-cloud',
        operationId: 'invalid-repository',
        repository: 'octo/unconfigured',
        instruction: 'Write release notes',
        allowedActions: ['write_code'],
      },
    ), { params: Promise.resolve({ id: 'task-local' }) });
    expect(invalid.status).toBe(403);

    const valid = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-local/delegation',
      {
        agentId: 'github-cloud',
        operationId: 'validated-repository',
        repository: 'octo/validated',
        instruction: 'Write release notes',
        allowedActions: ['write_code'],
      },
    ), { params: Promise.resolve({ id: 'task-local' }) });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      payloadPreview: {
        repository: { fullName: 'octo/validated' },
      },
    });
  });

  it('blocks unavailable credentials and restricted context before persistence', async () => {
    await createCloudAgent({
      id: 'missing-credential',
      authCredentialRef: 'not-configured',
    });
    const credentialContext = await singleRoute.GET(
      new Request('http://localhost/api/tasks/task-github/delegation'),
      { params: Promise.resolve({ id: 'task-github' }) },
    );
    expect(await credentialContext.json()).toMatchObject({
      targets: [{
        id: 'missing-credential',
        hasCredential: false,
        eligibility: [{
          taskId: 'task-github',
          ready: false,
          blocker: expect.stringMatching(/credential/i),
        }],
      }],
    });

    const credentialPreview = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-github/delegation',
      {
        agentId: 'missing-credential',
        operationId: 'missing-credential',
        instruction: 'Do not send this',
      },
    ), { params: Promise.resolve({ id: 'task-github' }) });
    expect(credentialPreview.status).toBe(403);

    await registry.updateExternalAgent('missing-credential', {
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: policyFields,
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
      authCredentialRef: 'github-user-test',
    });
    const restrictedPreview = await singleRoute.POST(mutationRequest(
      'http://localhost/api/tasks/task-restricted/delegation',
      {
        agentId: 'missing-credential',
        operationId: 'restricted-context',
        repository: 'octo/validated',
        instruction: 'Do not send this either',
      },
    ), { params: Promise.resolve({ id: 'task-restricted' }) });
    expect(restrictedPreview.status).toBe(403);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 0 });
  });

  it('fans bulk work out per task, reports blockers, and safely replays retries', async () => {
    await createCloudAgent();
    const body = {
      taskIds: ['task-github', 'task-local', 'task-done'],
      agentId: 'github-cloud',
      operationId: 'bulk-operation',
      repository: 'octo/validated',
      baseRef: 'main',
      instruction: 'Implement each task independently',
      allowedActions: ['write_code'],
    };
    const first = await bulkRoute.POST(mutationRequest(
      'http://localhost/api/tasks/delegation',
      body,
    ));
    const firstBatch = await first.json();
    const replay = await bulkRoute.POST(mutationRequest(
      'http://localhost/api/tasks/delegation',
      body,
    ));
    const replayBatch = await replay.json();

    expect(first.status).toBe(201);
    expect(firstBatch).toMatchObject({
      readyCount: 2,
      blockedCount: 1,
      blocked: [{
        taskId: 'task-done',
        ready: false,
        blocker: 'Task is done',
      }],
      requiresConfirmation: true,
    });
    expect(firstBatch.previews.map(({ taskId }: { taskId: string }) => taskId).sort())
      .toEqual(['task-github', 'task-local']);
    expect(new Set(firstBatch.previews.map(
      ({ dispatchId }: { dispatchId: string }) => dispatchId,
    )).size).toBe(2);
    expect(replayBatch.previews).toEqual(firstBatch.previews);
    expect(replayBatch.blocked).toEqual(firstBatch.blocked);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 2 });
  });

  it('returns the latest assignment for every requested task despite skewed history', async () => {
    await createCloudAgent();
    const local = await delegation.previewTaskDelegation({
      taskId: 'task-local',
      agentId: 'github-cloud',
      operationId: 'local-history',
      repository: 'octo/validated',
      instruction: 'Write release notes',
      allowedActions: ['write_code'],
    });
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET status = 'completed',
          created_at = '2026-10-01T00:00:00.000Z',
          updated_at = '2026-10-01T00:00:00.000Z'
      WHERE id = ?
    `).run(local.id);

    let latestGithubId = '';
    for (let index = 0; index < 7; index += 1) {
      const preview = await delegation.previewTaskDelegation({
        taskId: 'task-github',
        agentId: 'github-cloud',
        operationId: `github-history-${index}`,
        repository: 'octo/source',
        instruction: `Fix parser revision ${index}`,
        allowedActions: ['write_code'],
      });
      latestGithubId = preview.id;
      sqlite.prepare(`
        UPDATE agent_dispatches
        SET status = 'completed',
            created_at = ?,
            updated_at = ?
        WHERE id = ?
      `).run(
        `2026-10-02T00:00:0${index}.000Z`,
        `2026-10-02T00:00:0${index}.000Z`,
        preview.id,
      );
    }

    const summaries = await delegation.listTaskDelegationSummaries([
      'task-github',
      'task-local',
    ]);
    expect(summaries.size).toBe(2);
    expect(summaries.get('task-github')?.dispatchId).toBe(latestGithubId);
    expect(summaries.get('task-local')?.dispatchId).toBe(local.id);
  });
});
