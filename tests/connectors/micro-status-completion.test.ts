import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runFencedGitHubWrite } from '../fixtures/github-write-fence';
import type { ConnectorConfig } from '@/types';

vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return { ...actual, randomUUID: () => 'test-uuid' };
});

vi.mock('@/db', () => ({
  default: {
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: { id: 'id' },
}));

vi.mock('@/lib/external-identities', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/external-identities')>();
  return {
    ...actual,
    getGitHubIdentityModeSnapshot: () => ({
      revision: 1,
    }),
  };
});

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(async () => 'test-token'),
  getSubstrateToken: vi.fn(async () => 'test-token'),
  invalidateToken: vi.fn(),
}));

const baseConfig = {
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {},
  syncedLists: [],
} satisfies Partial<ConnectorConfig>;

describe('micro-status cleanup for terminal states', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('removes GitHub mc:* labels before closing an issue', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });

      if (url.endsWith('/issues/42/labels') && !init?.method) {
        return Response.json([
          { name: 'mc:waiting-on-someone' },
          { name: 'type:feature' },
        ]);
      }
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return Response.json({}, { status: 200 });
    }));

    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize({
      ...baseConfig,
      id: 'github-test',
      type: 'github-issues',
      name: 'GitHub',
      credentials: { token: 'test-token' },
      settings: { repos: ['owner/repo'], syncMicroStatus: false },
    } as ConnectorConfig);

    await runFencedGitHubWrite(connector, {
      connectorInstanceId: 'github-test',
      taskId: 'task-42',
      owner: 'owner',
      repository: 'repo',
      issueNumber: 42,
      operation: 'complete',
    }, () => connector.completeTask('owner/repo:42'));

    const deleteCall = calls.find(call => call.init?.method === 'DELETE');
    const closeCall = calls.find(call => call.init?.method === 'PATCH');
    expect(deleteCall?.url).toContain('/issues/42/labels/mc%3Awaiting-on-someone');
    expect(closeCall?.url).toContain('/issues/42');
    expect(JSON.parse(String(closeCall?.init?.body))).toEqual({
      state: 'closed',
      state_reason: 'completed',
    });
    expect(calls.indexOf(deleteCall!)).toBeLessThan(calls.indexOf(closeCall!));
  });

  it('removes Microsoft Todo mc:* categories in the completion update', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });

      if (url.includes('$select=categories')) {
        return Response.json({
          categories: ['mc:started-but-stuck', 'Customer'],
        });
      }
      return Response.json({}, { status: 200 });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize({
      ...baseConfig,
      id: 'todo-test',
      type: 'microsoft-todo',
      name: 'Microsoft Todo',
      credentials: {},
      settings: { syncMicroStatus: false },
    } as ConnectorConfig);

    await connector.completeTask('list-1:task-1');

    const completionCall = calls.find(call => call.init?.method === 'PATCH');
    expect(JSON.parse(String(completionCall?.init?.body))).toEqual({
      status: 'completed',
      categories: ['Customer'],
    });
  });

  it('removes Microsoft Todo mc:* categories when cancelling with sync disabled', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });

      if (url.includes('$select=categories')) {
        return Response.json({
          categories: ['mc:waiting-on-someone', 'Customer'],
        });
      }
      return Response.json({
        id: 'task-1',
        title: 'Cancelled task',
        status: 'notStarted',
        importance: 'normal',
        categories: ['Customer'],
        createdDateTime: '2026-07-31T00:00:00Z',
        lastModifiedDateTime: '2026-07-31T01:00:00Z',
      });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize({
      ...baseConfig,
      id: 'todo-test',
      type: 'microsoft-todo',
      name: 'Microsoft Todo',
      credentials: {},
      settings: { syncMicroStatus: false },
    } as ConnectorConfig);

    await connector.updateTask('list-1:task-1', {
      status: 'cancelled',
      microStatus: null,
    });

    const cancellationCall = calls.find(call => call.init?.method === 'PATCH');
    expect(JSON.parse(String(cancellationCall?.init?.body))).toEqual({
      status: 'notStarted',
      categories: ['Customer'],
    });
  });
});
