import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('@/db');
vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';
process.env.MC_EXTERNAL_AGENT_CREDENTIALS_JSON = JSON.stringify({
  'paperclip-approvals-key': 'paperclip-secret',
});

let sqlite: typeof import('@/db').sqlite;
let registry: typeof import('@/lib/external-agents/registry');
let approvals: typeof import('@/lib/external-agents/paperclip-approvals');

const companyId = '11111111-1111-4111-8111-111111111111';
const agentId = '22222222-2222-4222-8222-222222222222';
const approvalId = '33333333-3333-4333-8333-333333333333';
const issueId = '44444444-4444-4444-8444-444444444444';

function response(body: unknown, status = 200) {
  return Response.json(body, { status });
}

function approval(status: string, updatedAt: string) {
  return {
    id: approvalId,
    companyId,
    type: 'budget_override_required',
    requestedByAgentId: agentId,
    requestedByUserId: null,
    status,
    payload: {
      summary: 'Increase the synthetic test budget Authorization: Bearer hidden-token',
      risk: 'high',
      expiresAt: '2026-10-02T00:00:00.000Z',
      secret: 'must-not-persist',
    },
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: status === 'pending' ? null : updatedAt,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt,
  };
}

beforeAll(async () => {
  const databaseModule = await import('@/db');
  await (await import('@/db/runtime')).initializeRuntimeDatabase();
  [registry, approvals] = await Promise.all([
    import('@/lib/external-agents/registry'),
    import('@/lib/external-agents/paperclip-approvals'),
  ]);
  sqlite = databaseModule.sqlite;
  sqlite.prepare('SELECT 1').get();
}, 30_000);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM notification_actions;
    DELETE FROM notification_delivery_events;
    DELETE FROM notifications;
    DELETE FROM agent_dispatch_events;
    DELETE FROM agent_dispatch_attempts;
    DELETE FROM agent_dispatches;
    DELETE FROM external_agents;
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

async function createProvider(fetcher: typeof fetch) {
  vi.stubGlobal('fetch', fetcher);
  return registry.createExternalAgent({
    id: 'paperclip-approvals-provider',
    name: 'Paperclip approvals',
    type: 'paperclip',
    endpoint: 'https://paperclip.example.test',
    authType: 'bearer',
    authCredentialRef: 'paperclip-approvals-key',
    providerConfig: {
      paperclip: {
        companyId,
        assigneeAgentId: agentId,
        requiredAdapterType: 'github-copilot-web',
      },
    },
  });
}

describe('Paperclip approval notification reconciliation', () => {
  it('is idempotent across restart-style polls and closes only after authoritative approval', async () => {
    let state: 'pending' | 'approved' = 'pending';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${agentId}`) {
        return response({
          id: agentId,
          companyId,
          name: 'Budget agent',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}`) {
        return response({ id: companyId, name: 'Synthetic company' });
      }
      if (path === `/api/companies/${companyId}/approvals`) {
        expect(url.searchParams.get('status')).toBe('pending');
        return response(state === 'pending'
          ? [approval('pending', '2026-10-01T00:01:00.000Z')]
          : []);
      }
      if (path === `/api/approvals/${approvalId}`) {
        return response(approval(
          state,
          state === 'pending'
            ? '2026-10-01T00:01:00.000Z'
            : '2026-10-01T00:02:00.000Z',
        ));
      }
      if (path === `/api/approvals/${approvalId}/issues`) {
        return response([{
          id: issueId,
          identifier: 'PAP-42',
          companyId,
          executionRunId: '55555555-5555-4555-8555-555555555555',
        }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const provider = await createProvider(fetcher);

    const first = await approvals.reconcilePaperclipApprovals();
    const second = await approvals.reconcilePaperclipApprovals();
    expect(first).toMatchObject({ created: 1, failures: [] });
    expect(second).toMatchObject({ created: 0, updated: 1, failures: [] });

    const notification = sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable,
             metadata, body
      FROM notifications
      WHERE source_id = ?
    `).get(`paperclip:approval:${provider.id}:${approvalId}`) as {
      sourceState: string;
      isActionable: number;
      metadata: string;
      body: string;
    };
    expect(notification).toMatchObject({ sourceState: 'active', isActionable: 1 });
    expect(notification.body).toContain('Synthetic company');
    expect(notification.body).toContain('Budget agent');
    expect(notification.body).toContain('PAP-42');
    expect(notification.body).not.toContain('must-not-persist');
    expect(notification.body).not.toContain('hidden-token');
    expect(notification.metadata).not.toContain('must-not-persist');

    const action = sqlite.prepare(`
      SELECT payload, execution_state AS executionState
      FROM notification_actions
      WHERE notification_id = ?
    `).get(`paperclip-approval:${provider.id}:${approvalId}`) as {
      payload: string;
      executionState: string;
    };
    expect(JSON.parse(action.payload)).toEqual({
      url: `https://paperclip.example.test/approvals/${approvalId}`,
    });
    expect(action.payload).not.toContain('paperclip-secret');
    expect(action.executionState).toBe('pending');

    state = 'approved';
    const terminal = await approvals.reconcilePaperclipApprovals();
    expect(terminal).toMatchObject({ resolved: 1, failures: [] });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable
      FROM notifications WHERE source_id = ?
    `).get(`paperclip:approval:${provider.id}:${approvalId}`)).toMatchObject({
      sourceState: 'resolved',
      isActionable: 0,
    });
    expect(sqlite.prepare(`
      SELECT execution_state AS executionState
      FROM notification_actions WHERE notification_id = ?
    `).get(`paperclip-approval:${provider.id}:${approvalId}`)).toMatchObject({
      executionState: 'completed',
    });
  });

  it('does not create a stale notification when a concurrent decision follows the pending list', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${agentId}`) {
        return response({
          id: agentId,
          companyId,
          name: 'Budget agent',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}`) {
        return response({ id: companyId, name: 'Synthetic company' });
      }
      if (path === `/api/companies/${companyId}/approvals`) {
        return response([approval('pending', '2026-10-01T00:01:00.000Z')]);
      }
      if (path === `/api/approvals/${approvalId}`) {
        return response(approval('approved', '2026-10-01T00:02:00.000Z'));
      }
      if (path === `/api/approvals/${approvalId}/issues`) {
        return response([{ id: issueId, identifier: 'PAP-42', companyId }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await createProvider(fetcher);

    await expect(approvals.reconcilePaperclipApprovals()).resolves.toMatchObject({
      created: 0,
      updated: 0,
      resolved: 0,
      failures: [],
    });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get())
      .toEqual({ count: 0 });
  });

  it('rejects approvals returned outside the configured company scope', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${agentId}`) {
        return response({
          id: agentId,
          companyId,
          name: 'Budget agent',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}`) {
        return response({ id: companyId, name: 'Synthetic company' });
      }
      if (path === `/api/companies/${companyId}/approvals`) {
        return response([{
          ...approval('pending', '2026-10-01T00:01:00.000Z'),
          companyId: '99999999-9999-4999-8999-999999999999',
        }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    await createProvider(fetcher);

    const result = await approvals.reconcilePaperclipApprovals();
    expect(result.failures).toEqual([expect.objectContaining({
      error: expect.stringContaining('outside the configured company'),
    })]);
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM notifications').get())
      .toEqual({ count: 0 });
  });

  it('keeps the notification active during provider outages and closes authoritative deletion', async () => {
    let mode: 'pending' | 'outage' | 'forbidden' | 'rate_limited' | 'deleted' = 'pending';
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      if (path === '/api/health') return response({ status: 'ok' });
      if (path === `/api/agents/${agentId}`) {
        return response({
          id: agentId,
          companyId,
          name: 'Budget agent',
          adapterType: 'github-copilot-web',
        });
      }
      if (path === `/api/companies/${companyId}`) {
        if (mode === 'outage') return response({ error: 'Unavailable' }, 503);
        if (mode === 'forbidden') return response({ error: 'Forbidden' }, 403);
        if (mode === 'rate_limited') return response({ error: 'Slow down' }, 429);
        return response({ id: companyId, name: 'Synthetic company' });
      }
      if (path === `/api/companies/${companyId}/approvals`) {
        return response(mode === 'pending'
          ? [approval('pending', '2026-10-01T00:01:00.000Z')]
          : []);
      }
      if (path === `/api/approvals/${approvalId}`) {
        return mode === 'deleted'
          ? response({ error: 'Not found' }, 404)
          : response(approval('pending', '2026-10-01T00:01:00.000Z'));
      }
      if (path === `/api/approvals/${approvalId}/issues`) {
        return response([{ id: issueId, identifier: 'PAP-42', companyId }]);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const provider = await createProvider(fetcher);
    await approvals.reconcilePaperclipApprovals();

    mode = 'outage';
    const outage = await approvals.reconcilePaperclipApprovals();
    expect(outage.failures).toHaveLength(1);
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState FROM notifications WHERE source_id = ?
    `).get(`paperclip:approval:${provider.id}:${approvalId}`)).toMatchObject({
      sourceState: 'active',
    });

    for (const failureMode of ['forbidden', 'rate_limited'] as const) {
      mode = failureMode;
      const failed = await approvals.reconcilePaperclipApprovals();
      expect(failed.failures).toHaveLength(1);
      expect(sqlite.prepare(`
        SELECT source_state AS sourceState FROM notifications WHERE source_id = ?
      `).get(`paperclip:approval:${provider.id}:${approvalId}`)).toMatchObject({
        sourceState: 'active',
      });
    }

    mode = 'deleted';
    const deleted = await approvals.reconcilePaperclipApprovals();
    expect(deleted).toMatchObject({ deleted: 1, failures: [] });
    expect(sqlite.prepare(`
      SELECT source_state AS sourceState, is_actionable AS isActionable
      FROM notifications WHERE source_id = ?
    `).get(`paperclip:approval:${provider.id}:${approvalId}`)).toMatchObject({
      sourceState: 'deleted',
      isActionable: 0,
    });
  });
});
