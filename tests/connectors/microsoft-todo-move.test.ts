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
      'AQMk/source+=:AAMk/task+=',
      'AQMk/target+=',
    );

    expect(calls.map(({ url }) => url)).toEqual([
      'https://graph.microsoft.com/v1.0/me/todo/lists/AQMk%2Fsource%2B%3D/tasks/AAMk%2Ftask%2B%3D',
      'https://graph.microsoft.com/v1.0/me/todo/lists/AQMk%2Ftarget%2B%3D/tasks',
      'https://graph.microsoft.com/v1.0/me/todo/lists/AQMk%2Fsource%2B%3D/tasks/AAMk%2Ftask%2B%3D',
    ]);
    expect(newSourceId).toBe('AQMk/target+=:created/task-id');
  });

  it('uses the same encoded identity for attachments', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      calls.push(input.toString());
      return Response.json({ value: [] });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await expect(connector.listAttachments(
      'AQMk/source+=:AAMk/task+=',
    )).resolves.toEqual([]);
    expect(calls).toEqual([
      'https://graph.microsoft.com/v1.0/me/todo/lists/AQMk%2Fsource%2B%3D/tasks/AAMk%2Ftask%2B%3D/attachments',
    ]);
  });

  it('encodes the task identity in both My Day write paths', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      calls.push({ url, init });
      return new Response(null, {
        status: url.startsWith('https://substrate.office.com') ? 400 : 200,
      });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await connector.setMyDay('AQMk/source+=:AAMk/task+=', true);

    expect(calls.map(({ url }) => url)).toEqual([
      'https://substrate.office.com/todob2/api/v1/tasks/AAMk%2Ftask%2B%3D',
      'https://graph.microsoft.com/beta/me/todo/lists/AQMk%2Fsource%2B%3D/tasks/AAMk%2Ftask%2B%3D',
    ]);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      CommittedDay: expect.stringMatching(/T00:00:00Z$/),
    });
    expect(JSON.parse(String(calls[1].init?.body))).toEqual({ isInMyDay: true });
  });

  it('keeps checklist-item IDs out of parent task paths', async () => {
    const { parseSourceId } = await import(
      '@/lib/connectors/microsoft-todo/task-transformer'
    );

    expect(parseSourceId('list-id:task-id:checklist/item')).toEqual({
      listId: 'list-id',
      taskId: 'task-id',
      checklistItemId: 'checklist/item',
    });
    expect(() => parseSourceId('missing-separator')).toThrow(
      'Invalid Microsoft To Do task source ID',
    );
    expect(() => parseSourceId('list-only:')).toThrow(
      'Invalid Microsoft To Do task source ID',
    );
  });

  it('deletes checklist items without deleting their parent task', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: input.toString(), init });
      return new Response(null, { status: 204 });
    }));

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await connector.deleteTask('AQMk/source+=:AAMk/task+=:check/item+=');

    expect(calls).toEqual([{
      url: 'https://graph.microsoft.com/v1.0/me/todo/lists/AQMk%2Fsource%2B%3D/tasks/AAMk%2Ftask%2B%3D/checklistItems/check%2Fitem%2B%3D',
      init: expect.objectContaining({ method: 'DELETE' }),
    }]);
  });

  it('rejects checklist identities in parent task operations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { MicrosoftTodoConnector } = await import('@/lib/connectors/microsoft-todo');
    const connector = new MicrosoftTodoConnector();
    await connector.initialize(config);

    await expect(connector.updateTask(
      'AQMk/source+=:AAMk/task+=:check/item+=',
      { title: 'Do not update the parent' },
    )).rejects.toThrow(
      'Microsoft To Do checklist item ID cannot be used as a parent task ID',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
