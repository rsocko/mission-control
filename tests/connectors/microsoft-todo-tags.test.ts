import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';

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

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(async () => 'test-token'),
  getSubstrateToken: vi.fn(async () => 'test-token'),
  invalidateToken: vi.fn(),
}));

const config = {
  id: 'todo-test',
  type: 'microsoft-todo',
  name: 'Microsoft Todo',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {},
  credentials: {},
  settings: {},
  syncedLists: [],
} satisfies ConnectorConfig;

describe('Microsoft To Do tag write-back', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches the full task because Graph rejects $select on To Do task reads', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.includes('$select')) return new Response(null, { status: 400 });
      if (init?.method === 'PATCH') return Response.json({}, { status: 200 });
      return Response.json({ title: 'Review plan' }, { status: 200 });
    }));
    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await connector.addTagsToTask('list-1:task-1', ['Next Action']);

    expect(calls[0].url).toContain('/me/todo/lists/list-1/tasks/task-1');
    expect(calls[0].url).not.toContain('$select');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({
      title: 'Review plan #Next-Action',
    });
  });

  it('uses the same compatible read when removing a tag', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      if (url.includes('$select')) return new Response(null, { status: 400 });
      if (init?.method === 'PATCH') return Response.json({}, { status: 200 });
      return Response.json({ title: 'Review plan #Next-Action' }, { status: 200 });
    }));
    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await connector.removeTagFromTask('list-1:task-1', 'Next Action');

    expect(calls[0].url).not.toContain('$select');
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ title: 'Review plan' });
  });
});
