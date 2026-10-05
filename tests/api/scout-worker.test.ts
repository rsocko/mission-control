import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
process.env.MC_API_KEY = 'scout-worker-test-key';

let sqlite: typeof import('@/db').sqlite;
let workerRoute: typeof import('@/app/api/scout/worker/route');
let onboardingRoute: typeof import('@/app/api/scout/worker/onboarding/route');
let registry: typeof import('@/lib/external-agents/registry');
let mcpRoute: typeof import('@/app/api/external-agents/[id]/mcp/route');

const workerId = 'scout-pull-worker-scout-primary';
const capabilities = {
  sourceTypes: ['email', 'teams'],
  actions: ['read_m365', 'create_draft'],
  triggerTypes: ['schedule'],
  protectedCredentialStorage: true,
};
const client = { name: 'Microsoft Scout', version: '2026.10' };

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [workerRoute, onboardingRoute, registry, mcpRoute] = await Promise.all([
    import('@/app/api/scout/worker/route'),
    import('@/app/api/scout/worker/onboarding/route'),
    import('@/lib/external-agents/registry'),
    import('@/app/api/external-agents/[id]/mcp/route'),
  ]);
  sqlite = databaseModule.sqlite;
}, 30_000);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
    DELETE FROM connector_configs;
    INSERT INTO connector_configs (
      id, type, name, enabled, sync_mode, capabilities, credentials, settings,
      synced_lists, created_at, updated_at
    ) VALUES (
      'scout-primary', 'scout', 'Microsoft Scout', 1, 'push', '{}', '{}', '{}',
      '[]', '2026-10-03T00:00:00.000Z', '2026-10-03T00:00:00.000Z'
    );
  `);
});

afterAll(async () => {
  sqlite?.close();
  await (await import('@/db/runtime')).shutdownRuntimeDatabase();
  delete process.env.MC_DB_PATH;
  delete process.env.MC_API_KEY;
});

function trustedPost(body: unknown) {
  return new Request('https://mc.example.test/api/scout/worker', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mc-api-key': 'scout-worker-test-key',
    },
    body: JSON.stringify(body),
  });
}

function onboardingPost(body: unknown) {
  return new Request('https://mc.example.test/api/scout/worker/onboarding', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function provision() {
  const response = await workerRoute.POST(trustedPost({
    connectorId: 'scout-primary',
    action: 'generate-setup',
  }));
  const body = await response.json();
  const registrationToken = /^Registration token: (.+)$/m.exec(body.setupPrompt)?.[1];
  expect(registrationToken).toBeTruthy();
  return { response, body, registrationToken: registrationToken! };
}

async function register(registrationToken: string, overrides: Record<string, unknown> = {}) {
  const response = await onboardingRoute.POST(onboardingPost({
    action: 'register',
    workerId,
    registrationToken,
    capabilities,
    client,
    ...overrides,
  }));
  return { response, body: await response.json() };
}

describe('Scout pull worker onboarding', () => {
  it('copies only a temporary registration token and redacts onboarding hashes', async () => {
    const { response, body } = await provision();

    expect(response.status).toBe(200);
    expect(body.worker).toMatchObject({
      id: workerId,
      type: 'pull-queue',
      transport: 'pull',
      enabled: false,
      credentialSource: 'mission-control',
      hasCredentialReference: true,
      providerConfig: {
        scout: {
          onboarding: { status: 'pending_registration' },
        },
      },
    });
    expect(body.setupPrompt).toContain('/api/scout/worker/onboarding');
    expect(body.setupPrompt).not.toContain('Authorization: Bearer');
    expect(body.setupPrompt).not.toContain(`/api/external-agents/${workerId}/mcp`);
    expect(JSON.stringify(body.worker)).not.toContain('registrationTokenHash');
    expect(JSON.stringify(body.worker)).not.toContain('claimTokenHash');

    const status = await workerRoute.GET(new Request(
      'https://mc.example.test/api/scout/worker?connectorId=scout-primary',
    ));
    const statusBody = await status.json();
    expect(JSON.stringify(statusBody)).not.toContain('TokenHash');
  });

  it('requires protected credential storage and validates declared capabilities', async () => {
    const { registrationToken } = await provision();
    const withoutProtectedStorage = await register(registrationToken, {
      capabilities: { ...capabilities, protectedCredentialStorage: false },
    });
    expect(withoutProtectedStorage.response.status).toBe(422);
    expect(withoutProtectedStorage.body.code).toBe('PROTECTED_STORAGE_REQUIRED');

    const unsupportedSource = await register(registrationToken, {
      capabilities: { ...capabilities, sourceTypes: ['email', 'sharepoint'] },
    });
    expect(unsupportedSource.response.status).toBe(422);
    expect(unsupportedSource.body.code).toBe('VALIDATION_ERROR');
  });

  it('requires approval, claims the durable credential once, and activates the worker', async () => {
    const { registrationToken } = await provision();
    const registered = await register(registrationToken);
    expect(registered.response.status).toBe(200);
    expect(registered.body).toMatchObject({
      workerId,
      status: 'pending_approval',
      protocolVersion: '2',
    });
    expect(registered.body.claimToken).toBeTruthy();

    const replay = await register(registrationToken);
    expect(replay.response.status).toBe(409);
    expect(replay.body.code).toBe('CREDENTIAL_CONSUMED');

    const earlyClaim = await onboardingRoute.POST(onboardingPost({
      action: 'claim',
      workerId,
      claimToken: registered.body.claimToken,
    }));
    expect(earlyClaim.status).toBe(409);
    expect((await earlyClaim.json()).code).toBe('APPROVAL_REQUIRED');

    const approved = await workerRoute.POST(trustedPost({
      connectorId: 'scout-primary',
      action: 'approve',
    }));
    expect((await approved.json()).worker.providerConfig.scout.onboarding.status)
      .toBe('approved');

    const claimed = await onboardingRoute.POST(onboardingPost({
      action: 'claim',
      workerId,
      claimToken: registered.body.claimToken,
    }));
    const claimedBody = await claimed.json();
    expect(claimed.status).toBe(200);
    expect(claimedBody).toMatchObject({
      workerId,
      status: 'claimed',
      mcp: {
        transport: 'streamable-http',
        url: `https://mc.example.test/api/external-agents/${workerId}/mcp`,
        authorization: {
          scheme: 'Bearer',
          sensitive: true,
        },
      },
    });
    expect(claimedBody.mcp.authorization.token).toBeTruthy();

    const secondClaim = await onboardingRoute.POST(onboardingPost({
      action: 'claim',
      workerId,
      claimToken: registered.body.claimToken,
    }));
    expect(secondClaim.status).toBe(409);
    expect((await secondClaim.json()).code).toBe('CREDENTIAL_CONSUMED');

    const internal = await registry.getExternalAgent(workerId);
    expect(internal).toMatchObject({
      enabled: true,
      capabilities: {
        scout: capabilities,
        canPerformM365Actions: true,
      },
    });
  });

  it('authenticates MCP only after claim and exposes identity, health, and durable input tools', async () => {
    const { registrationToken } = await provision();
    const registered = await register(registrationToken);
    await workerRoute.POST(trustedPost({
      connectorId: 'scout-primary',
      action: 'approve',
    }));
    const claim = await onboardingRoute.POST(onboardingPost({
      action: 'claim',
      workerId,
      claimToken: registered.body.claimToken,
    }));
    const credential = (await claim.json()).mcp.authorization.token as string;

    const rpc = (token: string, id: number, method: string) => new Request(
      `https://mc.example.test/api/external-agents/${workerId}/mcp`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params: method === 'initialize'
            ? {
              protocolVersion: '2025-03-26',
              capabilities: {},
              clientInfo: { name: 'scout-test', version: '1.0.0' },
            }
            : {},
        }),
      },
    );

    const denied = await mcpRoute.POST(rpc('wrong-token', 1, 'initialize'), {
      params: Promise.resolve({ id: workerId }),
    });
    expect(denied.status).toBe(401);

    const accepted = await mcpRoute.POST(rpc(credential, 2, 'initialize'), {
      params: Promise.resolve({ id: workerId }),
    });
    expect(accepted.status).toBe(200);

    const toolsResponse = await mcpRoute.POST(rpc(credential, 3, 'tools/list'), {
      params: Promise.resolve({ id: workerId }),
    });
    const toolsBody = await toolsResponse.text();
    expect(toolsResponse.status).toBe(200);
    expect(toolsBody).toContain('mc_agent_identity');
    expect(toolsBody).toContain('mc_agent_health');
    expect(toolsBody).toContain('mc_agent_claim_work');
    expect(toolsBody).toContain('mc_agent_request_input');
    expect(toolsBody).toContain('mc_agent_complete_work');
    expect(toolsBody).not.toContain('mc_update_task');
  });

  it('can reject or restart an onboarding invitation without exposing a credential', async () => {
    const first = await provision();
    const registered = await register(first.registrationToken);
    expect(registered.response.status).toBe(200);

    const rejected = await workerRoute.POST(trustedPost({
      connectorId: 'scout-primary',
      action: 'reject',
    }));
    expect((await rejected.json()).worker.providerConfig.scout.onboarding.status)
      .toBe('rejected');

    const restarted = await provision();
    expect(restarted.body.setupPrompt).not.toBe(first.body.setupPrompt);
    expect(restarted.body.setupPrompt).not.toContain('Authorization: Bearer');
  });

  it('rejects setup for a non-Scout connector', async () => {
    sqlite.prepare(`
      UPDATE connector_configs SET type = 'github-issues' WHERE id = 'scout-primary'
    `).run();
    const response = await workerRoute.POST(trustedPost({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }));
    expect(response.status).toBe(404);
  });
});
