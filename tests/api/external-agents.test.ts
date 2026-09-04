import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/db');
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'api-pull-key': 'api-pull-secret',
  'api-manual-key': 'api-manual-secret',
});
process.env.MC_API_KEY = 'test-mc-api-key';

let sqlite: typeof import('@/db').sqlite;
let registryRoute: typeof import('@/app/api/external-agents/route');
let dispatchRoute: typeof import('@/app/api/external-agents/dispatch/route');
let claimRoute: typeof import('@/app/api/external-agents/dispatches/claim/route');
let resultRoute: typeof import('@/app/api/external-agents/dispatches/[id]/result/route');
let detailRoute: typeof import('@/app/api/external-agents/dispatches/[id]/route');

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  const modules = await Promise.all([
    import('@/app/api/external-agents/route'),
    import('@/app/api/external-agents/dispatch/route'),
    import('@/app/api/external-agents/dispatches/claim/route'),
    import('@/app/api/external-agents/dispatches/[id]/result/route'),
    import('@/app/api/external-agents/dispatches/[id]/route'),
  ]);
  sqlite = databaseModule.sqlite;
  registryRoute = modules[0];
  dispatchRoute = modules[1];
  claimRoute = modules[2];
  resultRoute = modules[3];
  detailRoute = modules[4];
  sqlite.prepare('SELECT 1').get();
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
  `);
});

afterAll(async () => {
  sqlite.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
  delete process.env.MC_API_KEY;
});

function mutationRequest(path: string, body: unknown, trusted = true) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(trusted
        ? {
          'x-mc-api-key': 'test-mc-api-key',
        }
        : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('external-agent API', () => {
  it('protects mutations and keeps credentials out of registry responses', async () => {
    const denied = await registryRoute.POST(mutationRequest(
      '/api/external-agents',
      { name: 'Denied', type: 'manual' },
      false,
    ));
    expect(denied.status).toBe(401);

    const created = await registryRoute.POST(mutationRequest('/api/external-agents', {
      id: 'api-pull',
      name: 'API pull worker',
      type: 'pull-queue',
      authType: 'bearer',
      authCredentialRef: 'api-pull-key',
      capabilities: { canProposeTasks: true },
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
    }));
    const body = await created.json();
    expect(created.status).toBe(201);
    expect(body.agent).toMatchObject({ hasCredentialReference: true });
    expect(body.agent).not.toHaveProperty('authCredentialRef');
  });

  it('enforces preview confirmation and scoped pull claim/result authentication', async () => {
    await registryRoute.POST(mutationRequest('/api/external-agents', {
      id: 'api-pull',
      name: 'API pull worker',
      type: 'pull-queue',
      authType: 'bearer',
      authCredentialRef: 'api-pull-key',
      capabilities: { canProposeTasks: true },
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
    }));
    const previewResponse = await dispatchRoute.POST(mutationRequest(
      '/api/external-agents/dispatch',
      {
        agentId: 'api-pull',
        instruction: 'Propose tasks',
        allowedActions: ['propose_tasks'],
        idempotencyKey: 'api-preview',
      },
    ));
    const preview = await previewResponse.json();
    expect(previewResponse.status).toBe(201);
    expect(preview).toMatchObject({
      status: 'needs_confirmation',
      processingLocation: 'external',
      requiresConfirmation: true,
    });

    const confirmResponse = await dispatchRoute.POST(mutationRequest(
      '/api/external-agents/dispatch',
      {
        confirm: true,
        dispatchId: preview.dispatchId,
        previewHash: preview.previewHash,
      },
    ));
    expect((await confirmResponse.json()).dispatch.status).toBe('queued');

    const deniedClaim = await claimRoute.POST(mutationRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'api-pull' },
    ));
    expect(deniedClaim.status).toBe(401);
    const claimRequest = mutationRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'api-pull' },
      false,
    );
    claimRequest.headers.set('x-mc-agent-key', 'api-pull-secret');
    const claimResponse = await claimRoute.POST(claimRequest);
    const claim = await claimResponse.json();
    expect(claimResponse.status).toBe(200);
    expect(claim).toMatchObject({ dispatchId: preview.dispatchId, attempt: 1 });

    const detailRequest = mutationRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}`,
      {},
    );
    const detailResponse = await detailRoute.GET(detailRequest, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(detailResponse.status).toBe(200);
    expect((await detailResponse.json()).dispatch).not.toHaveProperty('claimTokenHash');

    const resultRequest = mutationRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      { status: 'completed', summary: 'One proposal' },
      false,
    );
    resultRequest.headers.set('x-mc-claim-token', claim.claimToken);
    const resultResponse = await resultRoute.POST(resultRequest, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(resultResponse.status).toBe(202);
    expect(await resultResponse.json()).toEqual({ duplicate: false, status: 'completed' });
  });

  it('requires agent authentication for non-pull results despite claim-token headers', async () => {
    await registryRoute.POST(mutationRequest('/api/external-agents', {
      id: 'api-manual',
      name: 'Authenticated manual agent',
      type: 'manual',
      endpoint: 'https://manual.example.test/dispatch',
      authType: 'bearer',
      authCredentialRef: 'api-manual-key',
      capabilities: { canProposeTasks: true },
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
    }));
    const previewResponse = await dispatchRoute.POST(mutationRequest(
      '/api/external-agents/dispatch',
      {
        agentId: 'api-manual',
        instruction: 'Authenticate the result sender',
        idempotencyKey: 'api-manual-auth',
      },
    ));
    const preview = await previewResponse.json();
    await dispatchRoute.POST(mutationRequest(
      '/api/external-agents/dispatch',
      {
        confirm: true,
        dispatchId: preview.dispatchId,
        previewHash: preview.previewHash,
      },
    ));
    const resultBody = { status: 'completed', summary: 'Authenticated result' };

    const bypassRequest = mutationRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      resultBody,
      false,
    );
    bypassRequest.headers.set('x-mc-claim-token', 'not-a-pull-claim');
    const bypassResponse = await resultRoute.POST(bypassRequest, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(bypassResponse.status).toBe(401);

    const authenticatedRequest = mutationRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      resultBody,
      false,
    );
    authenticatedRequest.headers.set('x-mc-claim-token', 'still-not-a-pull-claim');
    authenticatedRequest.headers.set('x-mc-agent-key', 'api-manual-secret');
    const authenticatedResponse = await resultRoute.POST(authenticatedRequest, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(authenticatedResponse.status).toBe(202);
    expect(await authenticatedResponse.json()).toEqual({
      duplicate: false,
      status: 'completed',
    });

    const duplicateRequest = mutationRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      resultBody,
      false,
    );
    duplicateRequest.headers.set('x-mc-agent-key', 'api-manual-secret');
    const duplicateResponse = await resultRoute.POST(duplicateRequest, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(duplicateResponse.status).toBe(200);
    expect(await duplicateResponse.json()).toEqual({
      duplicate: true,
      status: 'completed',
    });
  });
});
