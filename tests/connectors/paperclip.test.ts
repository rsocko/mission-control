import { beforeEach, describe, expect, it, vi } from 'vitest';

const { listDispatches } = vi.hoisted(() => ({
  listDispatches: vi.fn(),
}));

vi.mock('@/lib/external-agents/persistence', () => ({
  getExternalAgentControlPersistence: async () => ({
    dispatches: { list: listDispatches },
  }),
}));

import { PaperclipConnector } from '@/lib/connectors/paperclip';
import {
  listPaperclipApprovals,
  listPaperclipAttention,
} from '@/lib/external-agents/paperclip';
import type { ConnectorConfig } from '@/types';

function connectorConfig(): ConnectorConfig {
  return {
    id: 'paperclip-connector',
    type: 'paperclip',
    name: 'Paperclip — Research',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 5,
    capabilities: {
      read: true,
      write: false,
      delete: false,
      sync: true,
      subtasks: false,
      lists: false,
      tags: false,
      tagWriteBack: false,
      notificationOnly: true,
    },
    credentials: { apiToken: 'paperclip-token' },
    settings: {
      apiOrigin: 'https://paperclip.example.test',
      companyId: 'company-1',
      companyName: 'Research',
    },
    syncedLists: [],
  };
}

describe('Paperclip approvals connector', () => {
  beforeEach(() => {
    listDispatches.mockReset();
    listDispatches.mockResolvedValue([{
      externalAgentId: 'paperclip-destination',
      providerTaskId: 'issue-1',
      scope: { taskIds: ['mc-task-1'] },
    }]);
    vi.unstubAllGlobals();
  });

  it('projects pending approvals once with bounded, linked details and authoritative reconciliation', async () => {
    const approvals = [
      {
        id: 'approval-1',
        companyId: 'company-1',
        status: 'pending',
        type: 'approve_budget',
        requestedByAgentId: 'agent-1',
        requestedByAgent: { name: 'Research agent' },
        issueId: 'issue-1',
        riskLevel: 'high',
        payload: { summary: 'Approve this small research budget' },
        createdAt: '2026-10-01T10:00:00.000Z',
        expiresAt: '2026-10-02T10:00:00.000Z',
      },
      {
        id: 'approval-2',
        companyId: 'company-1',
        status: 'approved',
        type: 'approve_strategy',
      },
    ];
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('authorization')).toMatch(/^Bearer\s+\S+$/);
      const path = new URL(String(input)).pathname;
      if (path === '/api/companies/company-1/approvals') {
        return Response.json(approvals);
      }
      if (path === '/api/companies/company-1/attention') {
        return Response.json({ companyId: 'company-1', items: [] });
      }
      if (path === '/api/approvals/approval-1/issues') {
        return Response.json([{
          id: 'issue-1',
          identifier: 'PAP-42',
          companyId: 'company-1',
        }]);
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);

    const connector = new PaperclipConnector();
    await connector.initialize(connectorConfig());
    const notifications = await connector.fetchNotifications();
    const replay = await connector.fetchNotifications();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      id: 'paperclip-approval:approval-1',
      sourceId: 'approval:approval-1',
      connectorType: 'paperclip',
      connectorInstanceId: 'paperclip-connector',
      title: 'Paperclip approval: approve_budget',
      level: 'action_needed',
      isActionable: true,
      actionUrl: 'https://paperclip.example.test/approvals/approval-1',
      relatedTaskId: 'mc-task-1',
      metadata: {
        companyName: 'Research',
        requester: 'Research agent',
        issueId: 'PAP-42',
        expiresAt: '2026-10-02T10:00:00.000Z',
      },
    });
    expect(notifications[0]?.body).toContain('Risk: high');
    expect(notifications[0]?.body).toContain('Summary: Approve this small research budget');
    expect(replay[0]?.id).toBe(notifications[0]?.id);
    expect(await connector.getActiveAlertSourceIds()).toEqual([notifications[0]?.id]);
    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(JSON.stringify(notifications)).not.toContain('paperclip-token');

    approvals[0]!.status = 'approved';
    expect(await connector.fetchNotifications()).toEqual([]);
    expect(await connector.getActiveAlertSourceIds()).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(8);
    await connector.dispose();
  });

  it('rejects remote token connections over plain HTTP', () => {
    return expect(new PaperclipConnector().initialize({
      ...connectorConfig(),
      settings: {
        apiOrigin: 'http://paperclip.example.test',
        companyId: 'company-1',
      },
    })).rejects.toThrow('require HTTPS');
  });

  it('discovers and monitors every accessible company when configured for all companies', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/health') {
        return Response.json({ status: 'ok' });
      }
      if (path === '/api/companies') {
        return Response.json([
          { id: 'company-1', name: 'Research', status: 'active' },
          { id: 'company-2', name: 'Operations', status: 'active' },
        ]);
      }
      if (path === '/api/projects' || path === '/api/agents') {
        return Response.json([]);
      }
      if (path === '/api/companies/company-1/approvals') {
        return Response.json([]);
      }
      if (path === '/api/companies/company-2/approvals') {
        return Response.json([{
          id: 'approval-2',
          status: 'pending',
          type: 'deploy_change',
        }]);
      }
      if (
        path === '/api/companies/company-1/attention'
        || path === '/api/companies/company-2/attention'
      ) {
        return Response.json({
          companyId: path.includes('company-1') ? 'company-1' : 'company-2',
          items: [],
        });
      }
      if (path === '/api/approvals/approval-2/issues') {
        return Response.json([]);
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const connector = new PaperclipConnector();
    await connector.initialize({
      ...connectorConfig(),
      name: 'Paperclip — All companies',
      settings: {
        apiOrigin: 'https://paperclip.example.test',
        monitorAllCompanies: true,
        companyIds: [],
      },
    });

    const notifications = await connector.fetchNotifications();

    expect(notifications).toEqual([
      expect.objectContaining({
        id: 'paperclip-approval:approval-2',
        metadata: expect.objectContaining({
          companyId: 'company-2',
          companyName: 'Operations',
        }),
      }),
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://paperclip.example.test/api/companies/company-1/approvals',
      expect.any(Object),
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://paperclip.example.test/api/companies/company-2/approvals',
      expect.any(Object),
    );
    await connector.dispose();
  });

  it('warns before the Board credential expires without hiding approval state', async () => {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      return path.endsWith('/attention')
        ? Response.json({ companyId: 'company-1', items: [] })
        : Response.json([]);
    }));
    const connector = new PaperclipConnector();
    await connector.initialize({
      ...connectorConfig(),
      settings: {
        ...connectorConfig().settings,
        boardKeyId: 'board-key-1',
        boardKeyExpiresAt: expiresAt,
        boardUserName: 'Mission Control operator',
      },
    });

    await expect(connector.fetchNotifications()).resolves.toEqual([
      expect.objectContaining({
        id: 'paperclip-credential-expiry:paperclip-connector',
        sourceId: 'credential-expiry:board-key-1',
        templateKey: 'paperclip_credential_expiring',
        actionUrl: '/settings/connectors',
        metadata: expect.objectContaining({ expiresAt, expired: false }),
      }),
    ]);
    await expect(connector.getActiveAlertSourceIds()).resolves.toEqual([
      'paperclip-credential-expiry:paperclip-connector',
    ]);
    await connector.dispose();
  });

  it('does not accept approvals returned for a different company', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([{
      id: 'approval-1',
      companyId: 'another-company',
      status: 'pending',
    }])));
    await expect(listPaperclipApprovals({
      endpoint: 'https://paperclip.example.test',
      credential: 'paperclip-token',
    }, 'company-1')).rejects.toMatchObject({
      code: 'PROVIDER_SCOPE_MISMATCH',
      status: 502,
    });
  });

  it('does not accept attention returned for a different company', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      companyId: 'company-1',
      items: [{
        id: 'attention-1',
        companyId: 'another-company',
        sourceKind: 'review',
      }],
    })));
    await expect(listPaperclipAttention({
      endpoint: 'https://paperclip.example.test',
      credential: 'paperclip-token',
    }, 'company-1')).rejects.toMatchObject({
      code: 'PROVIDER_SCOPE_MISMATCH',
      status: 502,
    });
  });

  it('paginates the authoritative attention feed', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const cursor = url.searchParams.get('cursor');
      return cursor
        ? Response.json({
          companyId: 'company-1',
          nextCursor: null,
          items: [{
            id: 'attention-2',
            companyId: 'company-1',
            sourceKind: 'review',
          }],
        })
        : Response.json({
          companyId: 'company-1',
          nextCursor: 'page-2',
          items: [{
            id: 'attention-1',
            companyId: 'company-1',
            sourceKind: 'issue_thread_interaction',
          }],
        });
    });
    vi.stubGlobal('fetch', fetcher);

    await expect(listPaperclipAttention({
      endpoint: 'https://paperclip.example.test',
      credential: 'paperclip-token',
    }, 'company-1')).resolves.toEqual([
      expect.objectContaining({ id: 'attention-1' }),
      expect.objectContaining({ id: 'attention-2' }),
    ]);
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      'https://paperclip.example.test/api/companies/company-1/attention?limit=100',
      expect.any(Object),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://paperclip.example.test/api/companies/company-1/attention?limit=100&cursor=page-2',
      expect.any(Object),
    );
  });

  it('keeps listed approvals actionable when linked issue details are inaccessible', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/companies/company-1/approvals') {
        return Response.json([{
          id: 'approval-1',
          companyId: 'company-1',
          status: 'pending',
          type: 'approve_budget',
          issueId: 'issue-1',
        }]);
      }
      if (path === '/api/companies/company-1/attention') {
        return Response.json({ companyId: 'company-1', items: [] });
      }
      if (path === '/api/approvals/approval-1/issues') {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    }));
    const connector = new PaperclipConnector();
    await connector.initialize(connectorConfig());

    const [notification] = await connector.fetchNotifications();
    expect(notification?.body).toContain('Paperclip issue: issue-1');
    expect(notification?.actionUrl).toBe('https://paperclip.example.test/approvals/approval-1');
    expect(await connector.getActiveAlertSourceIds()).toEqual([notification?.id]);
    await connector.dispose();
  });

  it('does not reconcile approval state when Paperclip authorization fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(
      { error: 'forbidden' },
      { status: 403 },
    )));
    const connector = new PaperclipConnector();
    await connector.initialize(connectorConfig());

    await expect(connector.fetchNotifications()).rejects.toMatchObject({
      code: 'PROVIDER_FORBIDDEN',
      status: 403,
    });
    await expect(connector.getActiveAlertSourceIds()).rejects.toMatchObject({
      code: 'PROVIDER_FORBIDDEN',
      status: 403,
    });
    await connector.dispose();
  });

  it('projects attention without duplicating approvals and reconciles disappeared items', async () => {
    const attentionItems = [
      {
        id: 'interaction:interaction-1',
        companyId: 'company-1',
        sourceKind: 'issue_thread_interaction',
        subject: {
          kind: 'interaction',
          id: 'interaction-1',
          title: 'Notification integration test',
          href: '/issues/PAP-42',
        },
        relatedIssue: {
          kind: 'issue',
          id: 'issue-1',
          identifier: 'PAP-42',
        },
        detail: {
          kind: 'confirmation',
          promptExcerpt: 'Did this notification appear?',
        },
        decisionVerbs: [
          { id: 'accept', label: 'Received notification' },
          { id: 'reject', label: 'Not received' },
        ],
        inlineResolvable: true,
        severity: 'high',
        whyNow: 'A teammate needs your confirmation.',
        activityAt: '2026-10-07T04:24:30.530Z',
        createdAt: '2026-10-07T04:24:30.530Z',
      },
      {
        id: 'approval:approval-1',
        companyId: 'company-1',
        sourceKind: 'approval',
        subject: { title: 'Duplicate approval feed row' },
        severity: 'high',
        createdAt: '2026-10-07T04:24:21.937Z',
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === '/api/companies/company-1/approvals') {
        return Response.json([]);
      }
      if (path === '/api/companies/company-1/attention') {
        return Response.json({ companyId: 'company-1', items: attentionItems });
      }
      throw new Error(`Unexpected Paperclip request: ${path}`);
    }));
    const connector = new PaperclipConnector();
    await connector.initialize(connectorConfig());

    await expect(connector.fetchNotifications()).resolves.toEqual([
      expect.objectContaining({
        id: 'paperclip-attention:interaction:interaction-1',
        sourceId: 'attention:interaction:interaction-1',
        templateKey: 'paperclip_attention',
        title: 'Notification integration test',
        level: 'action_needed',
        isActionable: true,
        actionUrl: 'https://paperclip.example.test/issues/PAP-42',
        relatedTaskId: 'mc-task-1',
        metadata: expect.objectContaining({
          sourceKind: 'issue_thread_interaction',
          detailKind: 'confirmation',
          identifier: 'PAP-42',
        }),
      }),
    ]);
    expect(await connector.getActiveAlertSourceIds()).toEqual([
      'paperclip-attention:interaction:interaction-1',
    ]);

    attentionItems.splice(0);
    await expect(connector.fetchNotifications()).resolves.toEqual([]);
    await expect(connector.getActiveAlertSourceIds()).resolves.toEqual([]);
    await connector.dispose();
  });

  it('keeps provider outages distinct from an empty authoritative approval list', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Connection refused');
    }));
    const connector = new PaperclipConnector();
    await connector.initialize(connectorConfig());

    await expect(connector.fetchNotifications()).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR',
      status: 502,
    });
    await expect(connector.getActiveAlertSourceIds()).rejects.toMatchObject({
      code: 'TRANSPORT_ERROR',
      status: 502,
    });
    await connector.dispose();
  });
});
