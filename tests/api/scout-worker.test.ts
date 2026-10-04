import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

process.env.MC_DB_PATH = ':memory:';
process.env.MC_API_KEY = 'scout-worker-test-key';

let sqlite: typeof import('@/db').sqlite;
let route: typeof import('@/app/api/scout/worker/route');
let registry: typeof import('@/lib/external-agents/registry');
let mcpRoute: typeof import('@/app/api/external-agents/[id]/mcp/route');

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [route, registry, mcpRoute] = await Promise.all([
    import('@/app/api/scout/worker/route'),
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

function post(body: unknown) {
  return new Request('https://mc.example.test/api/scout/worker', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mc-api-key': 'scout-worker-test-key',
    },
    body: JSON.stringify(body),
  });
}

describe('Scout pull worker setup', () => {
  it('provisions a managed pull destination and returns a retrievable setup prompt', async () => {
    const response = await route.POST(post({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.worker).toMatchObject({
      id: 'scout-pull-worker-scout-primary',
      type: 'pull-queue',
      transport: 'pull',
      enabled: true,
      credentialSource: 'mission-control',
      hasCredentialReference: true,
    });

    expect(body.setupPrompt).toContain(
      'https://mc.example.test/api/external-agents/scout-pull-worker-scout-primary/mcp',
    );
    expect(body.setupPrompt).toContain('mc_agent_claim_work');
    expect(body.setupPrompt).toContain('Authorization: Bearer ');

    const internal = await registry.getExternalAgent(
      'scout-pull-worker-scout-primary',
    );
    expect(internal?.capabilities).toMatchObject({
      canPerformM365Actions: true,
    });
    expect(internal?.dataPolicy.allowedClassifications).toEqual([
      'standard',
      'restricted',
    ]);

    const status = await route.GET(new Request(
      'https://mc.example.test/api/scout/worker?connectorId=scout-primary',
    ));
    const statusBody = await status.json();
    expect(statusBody.worker).not.toHaveProperty('authCredentialRef');
    expect(JSON.stringify(statusBody)).not.toContain('Bearer ');

    const revealed = await route.POST(post({
      connectorId: 'scout-primary',
      action: 'show-setup',
    }));
    const revealedBody = await revealed.json();
    expect(revealed.status).toBe(200);
    expect(revealedBody.setupPrompt).toBe(body.setupPrompt);
  });

  it('exposes the scoped MCP endpoint only to the generated worker credential', async () => {
    const setup = await (await route.POST(post({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }))).json();
    const credential = /Authorization: Bearer ([A-Za-z0-9_-]+)/.exec(
      setup.setupPrompt,
    )?.[1];
    expect(credential).toBeTruthy();

    const initialize = (token: string) => new Request(
      'https://mc.example.test/api/external-agents/scout-pull-worker-scout-primary/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'scout-test', version: '1.0.0' },
          },
        }),
      },
    );

    const denied = await mcpRoute.POST(initialize('wrong-token'), {
      params: Promise.resolve({ id: 'scout-pull-worker-scout-primary' }),
    });
    expect(denied.status).toBe(401);

    const accepted = await mcpRoute.POST(initialize(credential!), {
      params: Promise.resolve({ id: 'scout-pull-worker-scout-primary' }),
    });
    expect(accepted.status).toBe(200);

    const listTools = new Request(
      'https://mc.example.test/api/external-agents/scout-pull-worker-scout-primary/mcp',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${credential}`,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      },
    );
    const toolsResponse = await mcpRoute.POST(listTools, {
      params: Promise.resolve({ id: 'scout-pull-worker-scout-primary' }),
    });
    const toolsBody = await toolsResponse.text();
    expect(toolsResponse.status).toBe(200);
    expect(toolsBody).toContain('mc_agent_claim_work');
    expect(toolsBody).toContain('mc_agent_update_progress');
    expect(toolsBody).toContain('mc_agent_complete_work');
    expect(toolsBody).toContain('mc_agent_fail_work');
    expect(toolsBody).not.toContain('mc_update_task');
  });

  it('rotates the setup credential and can disable pickup', async () => {
    const first = await (await route.POST(post({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }))).json();
    const second = await (await route.POST(post({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }))).json();

    expect(second.setupPrompt).not.toBe(first.setupPrompt);

    const disabled = await route.POST(post({
      connectorId: 'scout-primary',
      action: 'disable',
    }));
    expect((await disabled.json()).worker.enabled).toBe(false);
  });

  it('rejects setup for a non-Scout connector', async () => {
    sqlite.prepare(`
      UPDATE connector_configs SET type = 'github-issues' WHERE id = 'scout-primary'
    `).run();
    const response = await route.POST(post({
      connectorId: 'scout-primary',
      action: 'generate-setup',
    }));
    expect(response.status).toBe(404);
  });
});
