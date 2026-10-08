import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/db');
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'paperclip-key': 'paperclip-secret',
});

let sqlite: typeof import('@/db').sqlite;
let registry: typeof import('@/lib/external-agents/registry');
let service: typeof import('@/lib/external-agents/service');
let ExternalAgentDispatchWorker: typeof import(
  '@/lib/external-agents/worker'
)['ExternalAgentDispatchWorker'];

const companyId = '11111111-1111-4111-8111-111111111111';
const assigneeAgentId = '22222222-2222-4222-8222-222222222222';

function response(body: unknown, status = 200) {
  return Response.json(body, { status });
}

async function asWorker<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.MC_PROCESS_ROLE;
  process.env.MC_PROCESS_ROLE = 'worker';
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.MC_PROCESS_ROLE;
    else process.env.MC_PROCESS_ROLE = previous;
  }
}

async function drainWorker(fetcher: typeof fetch): Promise<void> {
  await asWorker(async () => {
    const worker = new ExternalAgentDispatchWorker({ fetcher });
    expect(await worker.drainOne()).toBe(true);
  });
}

function paperclipAgent(
  overrides: Partial<import('@/lib/external-agents/registry').ExternalAgentInput> = {},
) {
  return registry.createExternalAgent({
    id: 'paperclip-provider',
    name: 'Paperclip',
    type: 'paperclip',
    endpoint: 'https://paperclip.example.test',
    authType: 'bearer',
    authCredentialRef: 'paperclip-key',
    providerConfig: {
      alwaysInstructions: 'Follow the destination quality bar.',
      paperclip: {
        companyId,
        assigneeAgentId,
        requiredAdapterType: 'github-copilot-web',
      },
    },
    capabilities: {
      canAnalyzeCode: true,
      canWriteCode: true,
      canRunCommands: true,
      canPush: true,
      canCreatePullRequest: true,
    },
    dataPolicy: {
      allowedClassifications: ['standard', 'restricted'],
      fieldAllowlist: [
        'instruction',
        'alwaysInstructions',
        'repository.fullName',
        'execution.locality',
        'execution.baseRef',
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
      ],
      retentionDays: 30,
      maxRequestsPerMinute: 30,
    },
    ...overrides,
  });
}

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  const modules = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/service'),
    import('@/lib/external-agents/worker'),
  ]);
  [registry, service] = modules;
  ExternalAgentDispatchWorker = modules[2].ExternalAgentDispatchWorker;
  sqlite = databaseModule.sqlite;
  sqlite.prepare('SELECT 1').get();
}, 30_000);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_actions;
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
    DELETE FROM tasks;
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, priority, created_at, updated_at, last_synced_at
    ) VALUES (
      'paperclip-task', 'octo/example:42', 'github-issues', 'github-source',
      'Canonical parser task title that must not be truncated',
      'Fix every escaped delimiter failure.',
      'todo', 'high',
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z'
    );
    UPDATE tasks
    SET metadata = '{"url":"https://github.com/octo/example/issues/42"}'
    WHERE id = 'paperclip-task';
    INSERT INTO tasks (
      id, source_id, connector_type, connector_instance_id, title, description,
      status, priority, parent_id, sibling_order, depth, is_checklist_item,
      created_at, updated_at, last_synced_at
    ) VALUES (
      'paperclip-subtask', 'paperclip-subtask', 'local', 'local',
      'Add regression coverage', 'Exercise nested escaped delimiters.',
      'todo', 'medium', 'paperclip-task', 1, 1, 1,
      '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z'
    );
  `);
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  sqlite.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
});

describe('Paperclip external-agent provider', () => {
  it('validates the endpoint, credential, company, and configured runtime', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer paperclip-secret');
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') {
        return response({ status: 'ok', version: '1.2.3' });
      }
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          name: 'Copilot engineer',
          status: 'idle',
          adapterType: 'github-copilot-web',
        });
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const created = await paperclipAgent();
    expect(created).toMatchObject({
      type: 'paperclip',
      transport: 'push',
      executionLocality: 'external',
      providerConfig: {
        paperclip: {
          companyId,
          assigneeAgentId,
          requiredAdapterType: 'github-copilot-web',
        },
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('stores a direct credential and reuses it for setup discovery', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer stored-secret');
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok', version: '1.2.3' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          name: 'Engineer',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === '/api/companies') {
        return response([{ id: companyId, name: 'Acme', status: 'active' }]);
      }
      if (path === `/api/companies/${companyId}/projects`) {
        return response([{
          id: '33333333-3333-4333-8333-333333333333',
          companyId,
          name: 'Mission Control',
          status: 'active',
        }]);
      }
      if (path === `/api/companies/${companyId}/agents`) {
        return response([{
          id: assigneeAgentId,
          companyId,
          name: 'Engineer',
          adapterType: 'github-copilot-web',
        }]);
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const created = await paperclipAgent({
      authCredentialRef: undefined,
      credential: 'stored-secret',
    });
    expect(registry.publicExternalAgent(created)).toMatchObject({
      hasCredentialReference: true,
      credentialSource: 'mission-control',
    });

    await expect(registry.discoverPaperclipSetup({
      destinationId: created.id,
      companyId,
    })).resolves.toMatchObject({
      companies: [{ id: companyId, name: 'Acme' }],
      projects: [{ name: 'Mission Control' }],
      agents: [{ id: assigneeAgentId, name: 'Engineer' }],
    });
  });

  it('reuses a Paperclip connector credential without exposing or duplicating it', async () => {
    const connectorId = 'paperclip-connector-auth';
    sqlite.prepare('DELETE FROM connector_configs WHERE id = ?').run(connectorId);
    const { getConnectorManagementPersistence } = await import(
      '@/lib/connectors/management-service'
    );
    await (await getConnectorManagementPersistence()).createConnector({
      id: connectorId,
      type: 'paperclip',
      name: 'Paperclip — Acme',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: { read: true, sync: true, notificationOnly: true },
      credentials: { apiToken: 'connector-board-token' },
      settings: {
        apiOrigin: 'https://paperclip.example.test',
        companyId,
        companyName: 'Acme',
      },
      syncedLists: [],
      now: new Date().toISOString(),
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization'))
        .toBe('Bearer connector-board-token');
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok', version: '1.2.3' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          name: 'Engineer',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === '/api/companies') {
        return response([{ id: companyId, name: 'Acme', status: 'active' }]);
      }
      if (path === `/api/companies/${companyId}/projects`) return response([]);
      if (path === `/api/companies/${companyId}/agents`) {
        return response([{
          id: assigneeAgentId,
          companyId,
          name: 'Engineer',
          adapterType: 'github-copilot-web',
        }]);
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(registry.discoverPaperclipSetup({
      connectorId,
      endpoint: 'https://paperclip.example.test',
      companyId,
    })).resolves.toMatchObject({
      companies: [{ id: companyId, name: 'Acme' }],
      agents: [{ id: assigneeAgentId }],
    });

    const created = await paperclipAgent({
      authCredentialRef: `paperclip-connector:${connectorId}`,
    });
    expect(registry.publicExternalAgent(created)).toMatchObject({
      hasCredentialReference: true,
      credentialSource: 'paperclip-connector',
      paperclipConnectorId: connectorId,
    });
    expect(JSON.stringify(registry.publicExternalAgent(created)))
      .not.toContain('connector-board-token');
  });

  it('can disable an unavailable Paperclip route without contacting the provider', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          adapterType: 'github-copilot-web',
        });
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    }));
    await paperclipAgent();

    const unavailable = vi.fn().mockRejectedValue(new Error('Provider offline'));
    vi.stubGlobal('fetch', unavailable);
    const updated = await registry.updateExternalAgent('paperclip-provider', {
      enabled: false,
    });

    expect(updated.enabled).toBe(false);
    expect(unavailable).not.toHaveBeenCalled();
  });

  it('allows unauthenticated Paperclip access only for local endpoints', () => {
    expect(() => registry.validateExternalAgentInput({
      name: 'Remote Paperclip',
      type: 'paperclip',
      endpoint: 'https://paperclip.example.test',
      authType: 'none',
      providerConfig: {
        paperclip: { companyId, assigneeAgentId },
      },
    })).toThrow(expect.objectContaining({
      code: 'EXECUTION_BOUNDARY_MISMATCH',
      status: 422,
    }));
  });

  it('creates one idempotent parent issue and reconciles run and work products', async () => {
    let phase: 'queued' | 'completed' = 'queued';
    let createCount = 0;
    let postedIssue: Record<string, unknown> | undefined;
    const issueId = '33333333-3333-4333-8333-333333333333';
    const runId = '44444444-4444-4444-8444-444444444444';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          adapterType: 'github-copilot-web',
        });
      }
      if (
        path === `/api/companies/${companyId}/issues`
        && init?.method === 'POST'
      ) {
        createCount += 1;
        postedIssue = JSON.parse(String(init.body)) as Record<string, unknown>;
        return response({
          id: issueId,
          identifier: 'PAP-42',
          companyId,
          status: 'todo',
          assigneeAgentId,
        }, 201);
      }
      if (path === `/api/issues/${issueId}`) {
        return response(phase === 'queued'
          ? {
            id: issueId,
            identifier: 'PAP-42',
            companyId,
            status: 'todo',
            assigneeAgentId,
            workProducts: [],
          }
          : {
            id: issueId,
            identifier: 'PAP-42',
            companyId,
            status: 'done',
            assigneeAgentId,
            executionRunId: runId,
            workProducts: [
              {
                type: 'pull_request',
                provider: 'github',
                title: 'PR 42',
                url: 'https://github.com/octo/example/pull/42',
                status: 'ready_for_review',
                metadata: {
                  repo: 'octo/example',
                  baseRef: 'main',
                  headRef: 'copilot/paperclip',
                },
              },
              {
                type: 'commit',
                provider: 'github',
                title: 'Implementation',
                status: 'active',
                metadata: {
                  repo: 'octo/example',
                  sha: '0123456789abcdef',
                  branch: 'copilot/paperclip',
                },
              },
              {
                type: 'artifact',
                provider: 'paperclip',
                title: 'Test report',
                url: 'https://paperclip.example.test/artifacts/test-report',
                status: 'approved',
              },
            ],
          });
      }
      if (path === `/api/issues/${issueId}/active-run`) return response(null);
      if (path === `/api/heartbeat-runs/${runId}`) {
        return response({
          id: runId,
          agentId: assigneeAgentId,
          agentName: 'Copilot engineer',
          adapterType: 'github-copilot-web',
          status: 'succeeded',
          usageJson: { inputTokens: 100, outputTokens: 20, costCents: 3 },
        });
      }
      if (path === `/api/issues/${issueId}/approvals`) return response([]);
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const agent = await paperclipAgent();
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Implement the parser fix',
      scope: {
        taskIds: ['paperclip-task'],
        repository: 'octo/example',
        baseRef: 'main',
        createPullRequest: true,
      },
      allowedActions: ['write_code', 'create_pull_request'],
      idempotencyKey: 'paperclip-dispatch',
    });

    await service.confirmDispatch(preview.id, preview.previewHash);
    await service.confirmDispatch(preview.id, preview.previewHash);
    await drainWorker(fetcher as typeof fetch);
    expect(createCount).toBe(1);
    expect(postedIssue).toMatchObject({
      title: 'Canonical parser task title that must not be truncated',
      status: 'todo',
      assigneeAgentId,
      idempotencyKey: `mission-control:${preview.id}`,
      allowDuplicate: false,
    });
    expect(postedIssue?.description).toEqual(expect.stringContaining(
      '## Destination always instructions\n\nFollow the destination quality bar.',
    ));
    expect(postedIssue?.description).toEqual(expect.stringContaining(
      '## Task 1: Canonical parser task title that must not be truncated',
    ));
    expect(postedIssue?.description).toEqual(expect.stringContaining(
      '1. **Add regression coverage** (`paperclip-subtask`)',
    ));
    expect(postedIssue?.description).toEqual(expect.stringContaining(
      '[octo/example#42](https://github.com/octo/example/issues/42)',
    ));
    expect(JSON.stringify(postedIssue)).not.toContain('paperclip-secret');
    expect(await service.getDispatch(preview.id)).toMatchObject({
      status: 'queued',
      providerTaskId: issueId,
      providerDetail: {
        issueIdentifier: 'PAP-42',
        assigneeAgentId,
      },
    });

    phase = 'completed';
    const reconciled = await asWorker(() => service.reconcileDispatch(preview.id));
    expect(reconciled).toMatchObject({
      status: 'completed',
      providerTaskId: issueId,
      repository: 'octo/example',
      baseRef: 'main',
      branchRef: 'copilot/paperclip',
      commitSha: '0123456789abcdef',
      githubPullRequestUrl: 'https://github.com/octo/example/pull/42',
      artifacts: [{ name: 'Test report', status: 'approved' }],
      providerDetail: {
        runId,
        executor: {
          agentId: assigneeAgentId,
          adapterType: 'github-copilot-web',
        },
        costs: { costCents: 3 },
      },
    });

    const callsAfterCompletion = fetcher.mock.calls.length;
    await asWorker(() => service.reconcileDispatch(preview.id));
    expect(fetcher).toHaveBeenCalledTimes(callsAfterCompletion);
  });

  it('cancels the provider run and issue before recording cancellation', async () => {
    const issueId = '55555555-5555-4555-8555-555555555555';
    const runId = '66666666-6666-4666-8666-666666666666';
    let cancelled = false;
    const mutations: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}/issues` && init?.method === 'POST') {
        return response({
          id: issueId,
          identifier: 'PAP-55',
          companyId,
          status: 'in_progress',
          assigneeAgentId,
          executionRunId: runId,
        }, 201);
      }
      if (path === `/api/issues/${issueId}` && init?.method === 'PATCH') {
        mutations.push('issue');
        cancelled = true;
        return response({
          id: issueId,
          identifier: 'PAP-55',
          companyId,
          status: 'cancelled',
          assigneeAgentId,
          executionRunId: runId,
        });
      }
      if (path === `/api/issues/${issueId}`) {
        return response({
          id: issueId,
          identifier: 'PAP-55',
          companyId,
          status: cancelled ? 'cancelled' : 'in_progress',
          assigneeAgentId,
          executionRunId: runId,
          workProducts: [],
        });
      }
      if (
        path === `/api/heartbeat-runs/${runId}/cancel`
        && init?.method === 'POST'
      ) {
        mutations.push('run');
        return response({ id: runId, status: 'cancelled' });
      }
      if (path === `/api/heartbeat-runs/${runId}`) {
        return response({
          id: runId,
          agentId: assigneeAgentId,
          status: cancelled ? 'cancelled' : 'running',
        });
      }
      if (path === `/api/issues/${issueId}/approvals`) return response([]);
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const agent = await paperclipAgent();
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Cancel safely',
      idempotencyKey: 'paperclip-cancel',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    await drainWorker(fetcher as typeof fetch);

    await expect(service.cancelDispatch(preview.id)).resolves.toBe(true);
    await drainWorker(fetcher as typeof fetch);
    expect(mutations).toEqual(['run', 'issue']);
    expect((await service.getDispatch(preview.id))?.status).toBe('cancelled');
    await expect(service.cancelDispatch(preview.id)).resolves.toBe(false);
  });

  it('does not record cancellation when Paperclip rejects it', async () => {
    const issueId = '77777777-7777-4777-8777-777777777777';
    const runId = '88888888-8888-4888-8888-888888888888';
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${assigneeAgentId}`) {
        return response({
          id: assigneeAgentId,
          companyId,
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}/issues` && init?.method === 'POST') {
        return response({
          id: issueId,
          identifier: 'PAP-77',
          companyId,
          status: 'in_progress',
          assigneeAgentId,
          executionRunId: runId,
        }, 201);
      }
      if (path === `/api/issues/${issueId}`) {
        return response({
          id: issueId,
          identifier: 'PAP-77',
          companyId,
          status: 'in_progress',
          assigneeAgentId,
          executionRunId: runId,
          workProducts: [],
        });
      }
      if (
        path === `/api/heartbeat-runs/${runId}/cancel`
        && init?.method === 'POST'
      ) {
        return response({ error: 'Board access required' }, 403);
      }
      if (path === `/api/heartbeat-runs/${runId}`) {
        return response({ id: runId, agentId: assigneeAgentId, status: 'running' });
      }
      if (path === `/api/issues/${issueId}/approvals`) return response([]);
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const agent = await paperclipAgent();
    const preview = await service.createDispatchPreview({
      agentId: agent.id,
      instruction: 'Keep cancellation truthful',
      idempotencyKey: 'paperclip-reject-cancel',
    });
    await service.confirmDispatch(preview.id, preview.previewHash);
    await drainWorker(fetcher as typeof fetch);

    await expect(service.cancelDispatch(preview.id)).resolves.toBe(true);
    await drainWorker(fetcher as typeof fetch);
    expect((await service.getDispatch(preview.id))?.status).toBe('in_progress');
  });
});
