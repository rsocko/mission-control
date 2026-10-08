import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

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
let dispatchRoute: typeof import('@/app/api/external-agents/dispatch/route');
let dispatchDetailRoute: typeof import('@/app/api/external-agents/dispatches/[id]/route');

const companyId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const assigneeAgentId = '33333333-3333-4333-8333-333333333333';
const policyFields = [
  'instruction',
  'alwaysInstructions',
  'repository.fullName',
  'repository.defaultBranch',
  'execution.locality',
  'execution.baseRef',
  'execution.model',
  'execution.createPullRequest',
  'tasks.id',
  'tasks.title',
  'tasks.description',
  'tasks.priority',
  'tasks.status',
  'tasks.tags',
  'tasks.dueDate',
  'tasks.effort',
  'tasks.assignee',
  'tasks.microStatus',
  'tasks.planningHorizon',
  'tasks.sourceListName',
  'tasks.siblingOrder',
  'tasks.depth',
  'tasks.isChecklistItem',
  'tasks.subtasks',
  'tasks.sourceIssue',
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
    providerConfig: {
      alwaysInstructions: 'Run focused tests and report exact results.',
    },
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
    if (path === `/api/projects/${projectId}`) {
      return Response.json({ id: projectId, companyId });
    }
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
        alwaysInstructions: 'Keep Paperclip progress concise.',
        paperclip: {
          companyId,
          companyName: 'Acme Corp',
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

async function createScoutPullAgent() {
  return registry.createExternalAgent({
    id: 'scout-pull-worker-scout-primary',
    name: 'Microsoft Scout work pickup',
    type: 'pull-queue',
    authType: 'bearer',
    credential: 'managed-scout-worker-secret',
    capabilities: {
      canProposeTasks: true,
      canProposePhases: true,
      canPerformM365Actions: true,
    },
    dataPolicy: {
      allowedClassifications: ['standard', 'restricted'],
      fieldAllowlist: policyFields,
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
  });
}

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [
    registry,
    delegation,
    singleRoute,
    bulkRoute,
    dispatchRoute,
    dispatchDetailRoute,
  ] = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/task-delegation'),
    import('@/app/api/tasks/[id]/delegation/route'),
    import('@/app/api/tasks/delegation/route'),
    import('@/app/api/external-agents/dispatch/route'),
    import('@/app/api/external-agents/dispatches/[id]/route'),
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
    UPDATE tasks
    SET description = 'Parser fails on escaped delimiters.',
        metadata = '{"url":"https://github.com/octo/source/issues/17"}',
        due_date = '2026-10-15',
        effort = 3,
        assignee = 'octocat',
        micro_status = 'ready',
        planning_horizon = 'next',
        source_list_name = 'octo/source'
    WHERE id = 'task-github';
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, priority, parent_id, sibling_order, depth, is_checklist_item,
      created_at, updated_at, last_synced_at
    ) VALUES (
      'subtask-parser-test', 'octo/source:19', 'github-issues', 'github-source',
      'Add escaped delimiter coverage', 'Cover opening and closing delimiters.',
      'in_progress', 'medium', 'task-github', 2, 1, 1,
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
  it('persists confirmation intent without calling a provider from the API process', async () => {
    await createCloudAgent();
    const preview = await delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'api-worker-owned-confirmation',
      instruction: 'Fix the parser',
      repository: 'octo/source',
    });

    const providerFetch = vi.fn(() => {
      throw new Error('provider transport must not run in the web process');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      const response = await dispatchRoute.POST(mutationRequest(
        'http://localhost/api/external-agents/dispatch',
        {
          dispatchId: preview.id,
          previewHash: preview.previewHash,
          confirm: true,
        },
      ));
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        accepted: true,
        dispatch: { id: preview.id, status: 'queued' },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(sqlite.prepare(`
      SELECT action, status FROM agent_dispatch_actions WHERE dispatch_id = ?
    `).get(preview.id)).toEqual({ action: 'submit', status: 'pending' });
  });

  it('queues refresh intent and keeps delegation reads side-effect free', async () => {
    await createCloudAgent();
    const preview = await delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'api-worker-owned-refresh',
      instruction: 'Fix the parser',
      repository: 'octo/source',
    });
    await (await import('@/lib/external-agents/service'))
      .confirmDispatch(preview.id, preview.previewHash);
    const providerFetch = vi.fn(() => {
      throw new Error('provider transport must not run in the web process');
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = providerFetch as typeof fetch;
    try {
      const getResponse = await singleRoute.GET(
        new Request('http://localhost/api/tasks/task-github/delegation'),
        { params: Promise.resolve({ id: 'task-github' }) },
      );
      expect(getResponse.status).toBe(200);
      const refreshResponse = await dispatchDetailRoute.PATCH(
        new Request(
          `http://localhost/api/external-agents/dispatches/${preview.id}`,
          {
            method: 'PATCH',
            headers: {
              'Content-Type': 'application/json',
              'x-mc-api-key': 'task-delegation-test-key',
            },
            body: JSON.stringify({ action: 'refresh' }),
          },
        ),
        { params: Promise.resolve({ id: preview.id }) },
      );
      expect(refreshResponse.status).toBe(202);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(providerFetch).not.toHaveBeenCalled();
    expect(sqlite.prepare(`
      SELECT action, status FROM agent_dispatch_actions
      WHERE dispatch_id = ? AND action = 'reconcile'
    `).get(preview.id)).toEqual({ action: 'reconcile', status: 'pending' });
  });

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
    await Promise.all([
      createCloudAgent(),
      createPaperclipAgent(),
      createScoutPullAgent(),
    ]);

    const response = await bulkRoute.GET(new Request(
      'http://localhost/api/tasks/delegation?taskId=task-github&taskId=task-local',
    ));
    expect(response.status).toBe(200);
    const context = await response.json();

    expect(context.targets).toHaveLength(3);
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
          companyName: 'Acme Corp',
          projectId,
          assigneeAgentId,
          requiredAdapterType: 'github-copilot-web',
        },
      }),
      expect.objectContaining({
        id: 'scout-pull-worker-scout-primary',
        type: 'pull-queue',
        executionLocality: 'external',
        allowedActions: expect.arrayContaining([
          'propose_tasks',
          'propose_phases',
          'm365_actions',
        ]),
        eligibility: expect.arrayContaining([
          expect.objectContaining({
            taskId: 'task-local',
            ready: true,
            repositoryLocked: false,
          }),
        ]),
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
      instruction: 'Fix the parser',
      alwaysInstructions: 'Run focused tests and report exact results.',
      repository: { fullName: 'octo/source', defaultBranch: 'main' },
      execution: { model: 'auto', createPullRequest: true },
      tasks: [{
        id: 'task-github',
        title: 'Fix the parser',
        description: 'Parser fails on escaped delimiters.',
        priority: 'high',
        status: 'todo',
        dueDate: '2026-10-15',
        effort: 3,
        assignee: 'octocat',
        microStatus: 'ready',
        planningHorizon: 'next',
        sourceListName: 'octo/source',
        sourceIssue: {
          type: 'github-issue',
          repository: 'octo/source',
          issueNumber: 17,
          url: 'https://github.com/octo/source/issues/17',
        },
        subtasks: [{
          id: 'subtask-parser-test',
          title: 'Add escaped delimiter coverage',
          description: 'Cover opening and closing delimiters.',
          status: 'in_progress',
          siblingOrder: 2,
          isChecklistItem: true,
        }],
      }],
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
        canCancel: false,
        canStopTracking: false,
        cancellationLimitation: null,
      }],
    });
  });

  it('changes the preview contract when always instructions change', async () => {
    await createCloudAgent();
    const first = await delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'always-instructions-first',
      repository: 'octo/source',
      instruction: 'Fix the parser',
      allowedActions: ['write_code'],
    });

    await registry.updateExternalAgent('github-cloud', {
      providerConfig: {
        alwaysInstructions: 'Run the full parser suite before handing off.',
      },
    });
    const second = await delegation.previewTaskDelegation({
      taskId: 'task-local',
      agentId: 'github-cloud',
      operationId: 'always-instructions-second',
      repository: 'octo/validated',
      instruction: 'Write release notes',
      allowedActions: ['write_code'],
    });

    expect(first.previewHash).not.toBe(second.previewHash);
    expect(second.payloadPreview).toMatchObject({
      alwaysInstructions: 'Run the full parser suite before handing off.',
    });
    await expect(
      (await import('@/lib/external-agents/service'))
        .confirmDispatch(first.id, first.previewHash),
    ).rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });
  });

  it('does not expose cancellation for Scout work pickup', async () => {
    await createScoutPullAgent();
    const preview = await delegation.previewTaskDelegation({
      taskId: 'task-local',
      agentId: 'scout-pull-worker-scout-primary',
      operationId: 'scout-without-cancel',
      instruction: 'Handle this Microsoft 365 task',
      allowedActions: ['propose_tasks'],
    });

    const response = await singleRoute.GET(
      new Request('http://localhost/api/tasks/task-local/delegation'),
      { params: Promise.resolve({ id: 'task-local' }) },
    );

    expect(await response.json()).toMatchObject({
      assignments: [{
        dispatchId: preview.id,
        targetType: 'pull-queue',
        canCancel: false,
        canStopTracking: false,
      }],
    });
  });

  it('uses the task details when per-dispatch instructions are omitted', async () => {
    await createCloudAgent();
    const preview = await delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'task-details-only',
      repository: 'octo/source',
      allowedActions: ['write_code'],
    });

    expect(preview.payloadPreview).toMatchObject({
      instruction: 'Complete the delegated task using the task details provided.',
      tasks: [{ id: 'task-github' }],
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
        taskBriefs: {
          'task-local': 'Prepare concise release notes for the October update.',
        },
        allowedActions: ['write_code'],
      },
    ), { params: Promise.resolve({ id: 'task-local' }) });
    expect(valid.status).toBe(201);
    expect(await valid.json()).toMatchObject({
      payloadPreview: {
        repository: { fullName: 'octo/validated' },
        tasks: [{
          id: 'task-local',
          description: 'Prepare concise release notes for the October update.',
        }],
      },
    });
    expect(sqlite.prepare('SELECT description FROM tasks WHERE id = ?').get('task-local'))
      .toEqual({ description: null });
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
    expect(firstBatch.previews).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: 'task-github',
        payloadPreview: expect.objectContaining({
          tasks: [expect.objectContaining({
            title: 'Fix the parser',
            description: 'Parser fails on escaped delimiters.',
            subtasks: [expect.objectContaining({ id: 'subtask-parser-test' })],
          })],
        }),
      }),
      expect.objectContaining({
        taskId: 'task-local',
        payloadPreview: expect.objectContaining({
          tasks: [expect.objectContaining({ title: 'Write release notes' })],
        }),
      }),
    ]));
    expect(new Set(firstBatch.previews.map(
      ({ dispatchId }: { dispatchId: string }) => dispatchId,
    )).size).toBe(2);
    expect(replayBatch.previews).toEqual(firstBatch.previews);
    expect(replayBatch.blocked).toEqual(firstBatch.blocked);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 2 });
  });

  it('combines selected tasks into one idempotent Copilot cloud assignment', async () => {
    await createCloudAgent();
    const body = {
      taskIds: ['task-github', 'task-local'],
      agentId: 'github-cloud',
      operationId: 'combined-operation',
      strategy: 'combined',
      repository: 'octo/source',
      baseRef: 'main',
      instruction: 'Deliver both tasks as one cohesive change.',
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
      blockedCount: 0,
      dispatchCount: 1,
      strategy: 'combined',
      previews: [{
        taskIds: ['task-github', 'task-local'],
        payloadPreview: {
          repository: { fullName: 'octo/source' },
          tasks: expect.arrayContaining([
            expect.objectContaining({ id: 'task-github', title: 'Fix the parser' }),
            expect.objectContaining({ id: 'task-local', title: 'Write release notes' }),
          ]),
        },
      }],
    });
    expect(replayBatch.previews).toEqual(firstBatch.previews);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 1 });
    expect(JSON.parse(String(sqlite.prepare(
      'SELECT scope FROM agent_dispatches LIMIT 1',
    ).pluck().get()))).toMatchObject({
      taskIds: ['task-github', 'task-local'],
      repository: 'octo/source',
    });
  });

  it('keeps combined delegation all-or-nothing when any selected task is blocked', async () => {
    await createCloudAgent();
    const response = await bulkRoute.POST(mutationRequest(
      'http://localhost/api/tasks/delegation',
      {
        taskIds: ['task-github', 'task-done'],
        agentId: 'github-cloud',
        operationId: 'combined-blocked',
        strategy: 'combined',
        baseRef: 'main',
        allowedActions: ['write_code'],
      },
    ));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: 'DISCLOSURE_BLOCKED',
      error: 'Task is done',
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 0 });
  });

  it('isolates oversized bulk tasks while preserving visible idempotent previews', async () => {
    await createCloudAgent();
    sqlite.prepare('UPDATE tasks SET description = ? WHERE id = ?')
      .run('x'.repeat(64 * 1024 + 1), 'task-local');
    const body = {
      taskIds: ['task-github', 'task-local'],
      agentId: 'github-cloud',
      operationId: 'bulk-oversized',
      repository: 'octo/validated',
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
      readyCount: 1,
      blockedCount: 1,
      previews: [expect.objectContaining({ taskId: 'task-github' })],
      blocked: [expect.objectContaining({
        taskId: 'task-local',
        ready: false,
        errorCode: 'PAYLOAD_TOO_LARGE',
        statusCode: 413,
        blocker: expect.stringContaining('65536 character context limit'),
      })],
    });
    expect(replayBatch.previews).toEqual(firstBatch.previews);
    expect(replayBatch.blocked).toEqual(firstBatch.blocked);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 1 });
  });

  it('upgrades legacy rich-context allowlists before eligibility review', async () => {
    await createCloudAgent({
      id: 'legacy-policy',
    });
    const legacyFields = [
      'instruction',
      'execution.locality',
      'dispatchId',
      'dataClassification',
      'allowedActions',
      'tasks.id',
      'tasks.title',
      'project.description',
    ];
    sqlite.prepare('UPDATE external_agents SET data_policy = ? WHERE id = ?').run(
      JSON.stringify({
        allowedClassifications: ['standard'],
        fieldAllowlist: legacyFields,
        retentionDays: 47,
        maxRequestsPerMinute: 9,
      }),
      'legacy-policy',
    );

    const response = await singleRoute.GET(
      new Request('http://localhost/api/tasks/task-github/delegation'),
      { params: Promise.resolve({ id: 'task-github' }) },
    );
    expect(await response.json()).toMatchObject({
      targets: [expect.objectContaining({
        id: 'legacy-policy',
        eligibility: [expect.objectContaining({
          ready: true,
          blocker: null,
        })],
      })],
    });
    const persisted = JSON.parse((sqlite.prepare(
      'SELECT data_policy AS dataPolicy FROM external_agents WHERE id = ?',
    ).get('legacy-policy') as { dataPolicy: string }).dataPolicy);
    expect(persisted).toMatchObject({
      allowedClassifications: ['standard'],
      retentionDays: 47,
      maxRequestsPerMinute: 9,
    });
    expect(persisted.fieldAllowlist).toEqual(expect.arrayContaining([
      ...legacyFields,
      'alwaysInstructions',
      'tasks.description',
      'tasks.subtasks',
      'tasks.sourceIssue',
    ]));
  });

  it('classifies the complete disclosed descendant hierarchy before transmission', async () => {
    await createCloudAgent();
    sqlite.prepare(`
      UPDATE tasks
      SET connector_type = 'custom-rest', connector_instance_id = 'restricted-source'
      WHERE id = 'subtask-parser-test'
    `).run();

    await expect(delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'restricted-descendant-blocked',
      repository: 'octo/source',
      instruction: 'Fix the parser',
      allowedActions: ['write_code'],
    })).rejects.toMatchObject({
      code: 'DISCLOSURE_BLOCKED',
      status: 403,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 0 });

    await registry.updateExternalAgent('github-cloud', {
      dataPolicy: {
        allowedClassifications: ['standard', 'restricted'],
      },
    });
    await expect(delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'restricted-descendant-allowed',
      repository: 'octo/source',
      instruction: 'Fix the parser',
      allowedActions: ['write_code'],
    })).resolves.toMatchObject({
      dataClassification: 'restricted',
      status: 'needs_confirmation',
    });
  });

  it('rejects oversized canonical content instead of truncating it', async () => {
    await createCloudAgent();
    sqlite.prepare('UPDATE tasks SET description = ? WHERE id = ?')
      .run('x'.repeat(64 * 1024 + 1), 'task-github');

    await expect(delegation.previewTaskDelegation({
      taskId: 'task-github',
      agentId: 'github-cloud',
      operationId: 'oversized-context',
      repository: 'octo/source',
      instruction: 'Fix the parser',
      allowedActions: ['write_code'],
    })).rejects.toMatchObject({
      code: 'PAYLOAD_TOO_LARGE',
      status: 413,
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get())
      .toEqual({ count: 0 });
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
    sqlite.prepare(`
      UPDATE agent_dispatches
      SET provider_detail = ?
      WHERE id = ?
    `).run(JSON.stringify({
      taskUrl: 'https://github.com/copilot/tasks/cloud-task-1',
    }), latestGithubId);

    const summaries = await delegation.listTaskDelegationSummaries([
      'task-github',
      'task-local',
    ]);
    expect(summaries.size).toBe(2);
    expect(summaries.get('task-github')?.dispatchId).toBe(latestGithubId);
    expect(summaries.get('task-github')?.providerTaskUrl)
      .toBe('https://github.com/copilot/tasks/cloud-task-1');
    expect(summaries.get('task-local')?.dispatchId).toBe(local.id);
  });
});
