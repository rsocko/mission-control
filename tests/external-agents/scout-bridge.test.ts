import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, createHmac } from 'node:crypto';

vi.unmock('@/db');
vi.unmock('drizzle-orm');

const companyId = '11111111-1111-4111-8111-111111111111';
const paperclipRuntimeAgentId = '22222222-2222-4222-8222-222222222222';
const bridgeSecret = 'paperclip-bridge-secret';
const scoutSecret = 'scout-pull-secret';

process.env.MC_DB_PATH = ':memory:';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'paperclip-provider-key': 'paperclip-provider-secret',
  'paperclip-scout:paperclip-provider': bridgeSecret,
  'scout-pull-key': scoutSecret,
});

let sqlite: typeof import('@/db').sqlite;
let registry: typeof import('@/lib/external-agents/registry');
let service: typeof import('@/lib/external-agents/service');
let bridgeRoute: typeof import('@/app/api/external-agents/paperclip/scout/route');
let bridgeStatusRoute: typeof import('@/app/api/external-agents/paperclip/scout/[id]/route');
let claimRoute: typeof import('@/app/api/external-agents/dispatches/claim/route');
let resultRoute: typeof import('@/app/api/external-agents/dispatches/[id]/result/route');

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [
    registry,
    service,
    bridgeRoute,
    bridgeStatusRoute,
    claimRoute,
    resultRoute,
  ] = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/service'),
    import('@/app/api/external-agents/paperclip/scout/route'),
    import('@/app/api/external-agents/paperclip/scout/[id]/route'),
    import('@/app/api/external-agents/dispatches/claim/route'),
    import('@/app/api/external-agents/dispatches/[id]/result/route'),
  ]);
  sqlite = databaseModule.sqlite;
}, 30_000);

beforeEach(() => {
  vi.useRealTimers();
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
  `);
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname;
    if (path === '/api/health') return Response.json({ status: 'ok' });
    if (path === `/api/agents/${paperclipRuntimeAgentId}`) {
      return Response.json({
        id: paperclipRuntimeAgentId,
        companyId,
        adapterType: 'openclaw',
      });
    }
    throw new Error(`Unexpected Paperclip request: ${path}`);
  }));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  sqlite?.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON;
});

async function createAgents(options: {
  risk?: 'low' | 'messaging';
  action?: string;
  automation?: boolean;
} = {}) {
  const action = options.action ?? 'search';
  await registry.createExternalAgent({
    id: 'scout-pull',
    name: 'Scout pull worker',
    type: 'pull-queue',
    authType: 'bearer',
    authCredentialRef: 'scout-pull-key',
    inputFormat: 'scout-capability-request-v1',
    capabilities: {
      allowedActions: [`m365.search:${action}`],
    },
    dataPolicy: {
      allowedClassifications: ['standard'],
      fieldAllowlist: [
        'instruction',
        'execution.locality',
        'dispatchId',
        'dataClassification',
        'allowedActions',
        'brokerRequest',
      ],
      retentionDays: 30,
      maxRequestsPerMinute: 20,
    },
  });
  return registry.createExternalAgent({
    id: 'paperclip-provider',
    name: 'Paperclip',
    type: 'paperclip',
    endpoint: 'https://paperclip.example.test',
    authType: 'bearer',
    authCredentialRef: 'paperclip-provider-key',
    providerConfig: {
      paperclip: {
        companyId,
        assigneeAgentId: paperclipRuntimeAgentId,
        requiredAdapterType: 'openclaw',
        scoutBridge: {
          destinationAgentId: 'scout-pull',
          tenantId: 'tenant-a',
          capabilities: [{
            tool: 'm365.search',
            actions: [action],
            inputFields: ['query', 'limit'],
            risk: options.risk ?? 'low',
          }],
          ...(options.automation === undefined
            ? {}
            : {
              automation: {
                enabled: options.automation,
                capabilities: [{ tool: 'm365.search', action }],
              },
            }),
        },
      },
    },
  });
}

function requestBody(overrides: Record<string, unknown> = {}) {
  return {
    paperclipAgentId: 'paperclip-provider',
    requestId: 'pc-request-1',
    companyId,
    agentId: paperclipRuntimeAgentId,
    destinationAgentId: 'scout-pull',
    tenantId: 'tenant-a',
    tool: 'm365.search',
    action: 'search',
    dataClassification: 'standard',
    input: { query: 'synthetic quarterly plan', limit: 5 },
    ...overrides,
  };
}

function signedRequest(
  method: 'POST' | 'GET',
  path: string,
  body?: Record<string, unknown>,
  options: { timestamp?: string; secret?: string } = {},
) {
  const rawBody = body ? JSON.stringify(body) : '';
  const timestamp = options.timestamp ?? new Date().toISOString();
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-mc-paperclip-agent-id': 'paperclip-provider',
      'x-mc-paperclip-timestamp': timestamp,
      'x-mc-paperclip-signature': `sha256=${createHmac(
        'sha256',
        options.secret ?? bridgeSecret,
      ).update([
        timestamp,
        'paperclip-provider',
        method,
        path.split('?')[0],
        createHash('sha256').update(rawBody, 'utf8').digest('hex'),
      ].join('\n'), 'utf8').digest('hex')}`,
    },
    ...(body ? { body: rawBody } : {}),
  });
}

function scoutRequest(path: string, body: unknown) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mc-agent-key': scoutSecret,
    },
    body: JSON.stringify(body),
  });
}

describe('Paperclip Scout bridge', () => {
  it('creates a minimized destination-bound preview and fences replay changes', async () => {
    await createAgents();
    const body = requestBody();
    const created = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      body,
    ));
    const preview = await created.json();
    expect(created.status).toBe(202);
    expect(preview).toMatchObject({
      requestId: 'pc-request-1',
      state: 'waiting-for-user',
      dataClassification: 'standard',
      allowedActions: ['m365.search:search'],
    });
    expect(preview.disclosedFields).toContain('brokerRequest');

    const dispatch = await service.getDispatch(preview.dispatchId);
    expect(dispatch?.payloadPreview).toMatchObject({
      brokerRequest: {
        source: {
          externalAgentId: 'paperclip-provider',
          companyId,
          agentId: paperclipRuntimeAgentId,
        },
        destination: {
          externalAgentId: 'scout-pull',
          tenantId: 'tenant-a',
        },
        capability: {
          tool: 'm365.search',
          action: 'search',
          risk: 'low',
        },
        input: { query: 'synthetic quarterly plan', limit: 5 },
      },
    });
    expect(JSON.stringify(dispatch)).not.toContain(bridgeSecret);
    expect(JSON.stringify(dispatch)).not.toContain('paperclip-provider-secret');
    expect(JSON.stringify(dispatch)).not.toContain(scoutSecret);

    const replay = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      body,
    ));
    expect((await replay.json()).dispatchId).toBe(preview.dispatchId);

    const changed = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody({ input: { query: 'changed payload', limit: 5 } }),
    ));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects expired signatures, tenant changes, restricted data, and disallowed fields/actions', async () => {
    await createAgents();
    const invalidSignature = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody({ requestId: 'invalid-signature' }),
      { secret: 'incorrect-bridge-secret' },
    ));
    expect(invalidSignature.status).toBe(401);
    expect(await invalidSignature.json()).toMatchObject({
      state: 'rejected',
      code: 'UNAUTHORIZED',
    });

    const expired = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody(),
      { timestamp: new Date(Date.now() - 10 * 60_000).toISOString() },
    ));
    expect(expired.status).toBe(401);
    expect(await expired.json()).toMatchObject({
      state: 'rejected',
      code: 'REPLAY_REJECTED',
    });

    for (const [overrides, code] of [
      [{ companyId: '33333333-3333-4333-8333-333333333333' }, 'PROVIDER_SCOPE_MISMATCH'],
      [{ agentId: '44444444-4444-4444-8444-444444444444' }, 'PROVIDER_SCOPE_MISMATCH'],
      [{ tenantId: 'tenant-b' }, 'PROVIDER_SCOPE_MISMATCH'],
      [{ destinationAgentId: 'other-scout' }, 'PROVIDER_SCOPE_MISMATCH'],
      [{ dataClassification: 'restricted' }, 'DISCLOSURE_BLOCKED'],
      [{ dataClassification: 'local-only' }, 'DISCLOSURE_BLOCKED'],
      [{ action: 'send' }, 'CAPABILITY_MISMATCH'],
      [{ input: { query: 'ok', accessToken: 'must-not-leave' } }, 'DISCLOSURE_BLOCKED'],
    ] as const) {
      const response = await bridgeRoute.POST(signedRequest(
        'POST',
        '/api/external-agents/paperclip/scout',
        requestBody({ requestId: `request-${code}-${JSON.stringify(overrides)}`, ...overrides }),
      ));
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code });
    }
  });

  it('requires human confirmation, revalidates claims, and fences results with source receipts', async () => {
    await createAgents();
    const created = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody(),
    ));
    const preview = await created.json();
    const beforeConfirmation = await claimRoute.POST(scoutRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'scout-pull' },
    ));
    expect(beforeConfirmation.status).toBe(204);

    await service.confirmDispatch(preview.dispatchId, preview.previewHash);
    const claimResponse = await claimRoute.POST(scoutRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'scout-pull' },
    ));
    const claim = await claimResponse.json();
    expect(claimResponse.status).toBe(200);
    expect(claim).toMatchObject({
      dispatchId: preview.dispatchId,
      attempt: 1,
      payload: {
        brokerRequest: {
          destination: { tenantId: 'tenant-a' },
          capability: { tool: 'm365.search', action: 'search' },
        },
      },
    });

    const missingReceipt = scoutRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      {
        status: 'completed',
        summary: 'Synthetic search completed',
      },
    );
    missingReceipt.headers.set('x-mc-claim-token', claim.claimToken);
    const missingReceiptResponse = await resultRoute.POST(missingReceipt, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(missingReceiptResponse.status).toBe(422);

    const result = {
      status: 'completed' as const,
      summary: 'Synthetic search completed',
      providerTaskId: 'scout-claim-1',
      providerDetail: {
        sourceReceiptId: 'm365-receipt-1',
        tenantId: 'tenant-a',
      },
    };
    const completed = scoutRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      result,
    );
    completed.headers.set('x-mc-claim-token', claim.claimToken);
    const completedResponse = await resultRoute.POST(completed, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(completedResponse.status).toBe(202);
    expect(await completedResponse.json()).toEqual({
      duplicate: false,
      status: 'completed',
    });

    const duplicate = scoutRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      result,
    );
    duplicate.headers.set('x-mc-claim-token', claim.claimToken);
    const duplicateResponse = await resultRoute.POST(duplicate, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(duplicateResponse.status).toBe(200);
    expect(await duplicateResponse.json()).toEqual({
      duplicate: true,
      status: 'completed',
    });

    const changedCompletion = scoutRequest(
      `/api/external-agents/dispatches/${preview.dispatchId}/result`,
      {
        ...result,
        summary: 'Changed terminal result',
      },
    );
    changedCompletion.headers.set('x-mc-claim-token', claim.claimToken);
    const changedCompletionResponse = await resultRoute.POST(changedCompletion, {
      params: Promise.resolve({ id: preview.dispatchId }),
    });
    expect(changedCompletionResponse.status).toBe(409);
    expect(await changedCompletionResponse.json()).toMatchObject({
      code: 'TERMINAL_DISPATCH',
    });

    const path = `/api/external-agents/paperclip/scout/${preview.dispatchId}`;
    const statusResponse = await bridgeStatusRoute.GET(
      signedRequest('GET', path),
      { params: Promise.resolve({ id: preview.dispatchId }) },
    );
    expect(await statusResponse.json()).toMatchObject({
      requestId: 'pc-request-1',
      dispatchId: preview.dispatchId,
      state: 'completed',
      result: { summary: 'Synthetic search completed' },
    });
  });

  it('allows explicitly scoped low-risk automation but never high-risk automation', async () => {
    await createAgents({ automation: true });
    const lowRisk = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody(),
    ));
    expect(await lowRisk.json()).toMatchObject({ state: 'queued' });

    sqlite.exec(`
      DELETE FROM agent_dispatch_events;
      DELETE FROM agent_dispatch_attempts;
      DELETE FROM agent_dispatches;
      DELETE FROM external_agents;
    `);
    await createAgents({
      action: 'send',
      risk: 'messaging',
      automation: true,
    });
    const messaging = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody({
        requestId: 'messaging-request',
        action: 'send',
      }),
    ));
    expect(await messaging.json()).toMatchObject({ state: 'waiting-for-user' });
  });

  it('reclaims expired leases and terminally fails claims after policy changes', async () => {
    await createAgents();
    const firstCreated = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody(),
    ));
    const firstPreview = await firstCreated.json();
    await service.confirmDispatch(firstPreview.dispatchId, firstPreview.previewHash);

    const leaseStart = Date.now();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(leaseStart));
    const firstClaim = await claimRoute.POST(scoutRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'scout-pull', leaseMs: 1 },
    ));
    expect(await firstClaim.json()).toMatchObject({ attempt: 1 });
    vi.setSystemTime(new Date(leaseStart + 10));
    const reclaimed = await claimRoute.POST(scoutRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'scout-pull', leaseMs: 1_000 },
    ));
    expect(await reclaimed.json()).toMatchObject({
      dispatchId: firstPreview.dispatchId,
      attempt: 2,
    });
    vi.useRealTimers();

    sqlite.exec(`
      DELETE FROM agent_dispatch_events;
      DELETE FROM agent_dispatch_attempts;
      DELETE FROM agent_dispatches;
    `);
    const secondCreated = await bridgeRoute.POST(signedRequest(
      'POST',
      '/api/external-agents/paperclip/scout',
      requestBody({ requestId: 'policy-change-request' }),
    ));
    const secondPreview = await secondCreated.json();
    await service.confirmDispatch(secondPreview.dispatchId, secondPreview.previewHash);
    await registry.updateExternalAgent('paperclip-provider', {
      providerConfig: {
        paperclip: {
          companyId,
          assigneeAgentId: paperclipRuntimeAgentId,
          requiredAdapterType: 'openclaw',
          scoutBridge: {
            destinationAgentId: 'scout-pull',
            tenantId: 'tenant-b',
            capabilities: [{
              tool: 'm365.search',
              actions: ['search'],
              inputFields: ['query', 'limit'],
              risk: 'low',
            }],
          },
        },
      },
    });
    const deniedClaim = await claimRoute.POST(scoutRequest(
      '/api/external-agents/dispatches/claim',
      { agentId: 'scout-pull' },
    ));
    expect(deniedClaim.status).toBe(409);
    expect(await deniedClaim.json()).toMatchObject({
      code: 'PROVIDER_SCOPE_MISMATCH',
    });
    expect(await service.getDispatch(secondPreview.dispatchId)).toMatchObject({
      status: 'failed',
      providerDetail: { policyRevalidation: 'rejected' },
    });
    const failedStatus = await bridgeStatusRoute.GET(
      signedRequest(
        'GET',
        `/api/external-agents/paperclip/scout/${secondPreview.dispatchId}`,
      ),
      { params: Promise.resolve({ id: secondPreview.dispatchId }) },
    );
    expect(await failedStatus.json()).toMatchObject({
      requestId: 'policy-change-request',
      state: 'failed',
    });
  });
});
