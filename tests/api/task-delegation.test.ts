import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
process.env.MC_API_KEY = 'task-delegation-test-key';

let sqlite: typeof import('@/db').sqlite;
let registry: typeof import('@/lib/external-agents/registry');
let route: typeof import('@/app/api/tasks/[id]/delegation/route');
let dispatchRoute: typeof import('@/app/api/external-agents/dispatch/route');

function request(body: unknown) {
  return new Request('http://localhost/api/tasks/task-1/delegation', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': 'task-delegation-preview',
      'x-mc-api-key': 'task-delegation-test-key',
    },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [registry, route, dispatchRoute] = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/app/api/tasks/[id]/delegation/route'),
    import('@/app/api/external-agents/dispatch/route'),
  ]);
  sqlite = databaseModule.sqlite;
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
    DELETE FROM tasks;
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, status,
      priority, created_at, updated_at, last_synced_at
    ) VALUES (
      'task-1', 'octo/repo:1', 'github-issues', 'github-test', 'Delegate this task', 'todo',
      'high', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z'
    );
  `);
});

afterAll(async () => {
  sqlite.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
});

describe('task delegation API', () => {
  it('evaluates targets, creates an exact durable preview, and returns the assignment', async () => {
    const agent = await registry.createExternalAgent({
      id: 'planning-worker',
      name: 'Planning worker',
      type: 'manual',
      capabilities: { canProposeTasks: true },
      dataPolicy: {
        allowedClassifications: ['standard'],
        fieldAllowlist: [
          'instruction',
          'execution.locality',
          'tasks.id',
          'tasks.title',
          'dispatchId',
          'dataClassification',
          'allowedActions',
        ],
        retentionDays: 30,
        maxRequestsPerMinute: 30,
      },
    });

    const emptyResponse = await route.GET(
      new Request('http://localhost/api/tasks/task-1/delegation'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    expect(emptyResponse.status).toBe(200);
    expect(await emptyResponse.json()).toMatchObject({
      taskId: 'task-1',
      eligibleTargets: [{
        id: agent.id,
        executionLocality: 'external',
        dataClassification: 'standard',
        allowedActions: ['propose_tasks'],
      }],
      assignments: [],
    });

    const previewResponse = await route.POST(request({
      agentId: agent.id,
      instruction: 'Break the task into an executable plan',
      allowedActions: ['propose_tasks'],
    }), { params: Promise.resolve({ id: 'task-1' }) });
    const preview = await previewResponse.json();
    expect(previewResponse.status).toBe(201);
    expect(preview).toMatchObject({
      status: 'needs_confirmation',
      processingLocation: 'external',
      dataClassification: 'standard',
      disclosedFields: expect.arrayContaining(['tasks.id', 'tasks.title']),
      allowedActions: ['propose_tasks'],
      requiresConfirmation: true,
    });
    expect(preview.payloadPreview.tasks).toEqual([{
      id: 'task-1',
      title: 'Delegate this task',
    }]);

    const confirmResponse = await dispatchRoute.POST(new Request(
      'http://localhost/api/external-agents/dispatch',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-mc-api-key': 'task-delegation-test-key',
        },
        body: JSON.stringify({
          confirm: true,
          dispatchId: preview.dispatchId,
          previewHash: preview.previewHash,
        }),
      },
    ));
    expect(confirmResponse.status).toBe(200);

    const assignedResponse = await route.GET(
      new Request('http://localhost/api/tasks/task-1/delegation'),
      { params: Promise.resolve({ id: 'task-1' }) },
    );
    const assigned = await assignedResponse.json();
    expect(assigned.assignments[0]).toMatchObject({
      dispatchId: preview.dispatchId,
      targetName: 'Planning worker',
      canonicalState: 'waiting_for_user',
      displayState: 'waiting_for_user',
      locality: 'external',
      canCancel: true,
      canRetry: false,
      disclosedFields: expect.arrayContaining(['tasks.id', 'tasks.title']),
    });

    const duplicateAssignmentResponse = await route.POST(new Request(
      'http://localhost/api/tasks/task-1/delegation',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'second-active-assignment',
          'x-mc-api-key': 'task-delegation-test-key',
        },
        body: JSON.stringify({
          agentId: agent.id,
          instruction: 'Start another executor',
          allowedActions: ['propose_tasks'],
        }),
      },
    ), { params: Promise.resolve({ id: 'task-1' }) });
    expect(duplicateAssignmentResponse.status).toBe(409);
  });

  it('rejects a target that policy excludes and does not materialize a dispatch', async () => {
    await registry.createExternalAgent({
      id: 'restricted-worker',
      name: 'Restricted worker',
      type: 'manual',
      dataPolicy: {
        allowedClassifications: ['restricted'],
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
    });
    const response = await route.POST(request({
      agentId: 'restricted-worker',
      instruction: 'Should be denied',
    }), { params: Promise.resolve({ id: 'task-1' }) });
    expect(response.status).toBe(403);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM agent_dispatches').get()).toEqual({
      count: 0,
    });
  });
});
