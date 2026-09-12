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
  capabilities: {
    read: true,
    write: true,
    delete: true,
    sync: true,
    subtasks: true,
    lists: true,
    tags: true,
    tagWriteBack: true,
  },
  credentials: {},
  settings: {},
  syncedLists: [],
} satisfies ConnectorConfig;

describe('Microsoft To Do list moves', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves and URL-encodes opaque list and task IDs', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });

      if (init?.method === 'POST') {
        return Response.json({ id: 'created/task-id' }, { status: 201 });
      }
      if (init?.method === 'DELETE') {
        return new Response(null, { status: 204 });
      }
      return Response.json({
        title: 'Move me',
        status: 'notStarted',
        importance: 'normal',
      });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    const newSourceId = await connector.moveTaskToList(
      'source/list:segment:task/opaque',
      'target/list:segment',
    );

    expect(calls.map(({ url }) => url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/todo/lists/source%2Flist%3Asegment/tasks/task%2Fopaque',
      'https://graph.microsoft.com/v1.0/me/todo/lists/target%2Flist%3Asegment/tasks',
      'https://graph.microsoft.com/v1.0/me/todo/lists/source%2Flist%3Asegment/tasks/task%2Fopaque',
    ]);
    expect(newSourceId).toBe('target/list:segment:created/task-id');
  });
});
