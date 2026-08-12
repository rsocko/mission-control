import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CustomRestConnector } from '@/lib/connectors/custom-rest';
import type { ConnectorCapabilities, ConnectorConfig } from '@/types';

const BASE_CAPABILITIES: ConnectorCapabilities = {
  read: true,
  write: false,
  delete: false,
  sync: true,
  subtasks: false,
  lists: false,
  tags: false,
  tagWriteBack: false,
};

function config(settings: Record<string, unknown>): ConnectorConfig {
  return {
    id: 'custom-rest-1',
    type: 'custom-rest',
    name: 'Custom REST',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 15,
    capabilities: BASE_CAPABILITIES,
    credentials: {},
    settings: {
      baseUrl: 'https://tasks.example.test',
      tasksEndpoint: '/tasks',
      headers: { Authorization: 'Bearer test' },
      taskMapping: {
        id: 'task_id',
        title: 'summary',
        status: 'state',
        priority: 'severity',
      },
      statusMap: { open: 'todo', closed: 'done' },
      priorityMap: { p1: 'critical', p3: 'medium' },
      ...settings,
    },
    syncedLists: [],
  };
}

describe('Custom REST task authority', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
  });

  it('keeps create-only instances read-only for existing tasks', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(
      JSON.stringify({ task_id: 'created-42' }),
      { status: 200 },
    ));
    const connector = new CustomRestConnector();
    await connector.initialize(config({ createEndpoint: '/tasks' }));

    expect(connector.capabilities).toMatchObject({
      taskSourceModel: 'remote-mirror',
      write: false,
      taskCreate: true,
      delete: false,
    });

    const created = await connector.createTask({ title: 'Created remotely' });
    expect(created.sourceId).toBe('created-42');
    expect(fetch).toHaveBeenCalledWith(
      'https://tasks.example.test/tasks',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ summary: 'Created remotely' }),
      }),
    );
  });

  it('writes configured update fields and reverse-maps source values', async () => {
    const connector = new CustomRestConnector();
    await connector.initialize(config({
      updateEndpoint: 'PATCH /tasks/:id',
      deleteEndpoint: 'DELETE /tasks/:id',
    }));

    expect(connector.capabilities).toMatchObject({
      taskSourceModel: 'remote-managed',
      write: true,
      taskCreate: false,
      delete: true,
    });
    await connector.updateTask('task/id', {
      title: 'Updated',
      status: 'done',
      priority: 'critical',
    });

    expect(fetch).toHaveBeenCalledWith(
      'https://tasks.example.test/tasks/task%2Fid',
      expect.objectContaining({
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          summary: 'Updated',
          state: 'closed',
          severity: 'p1',
        }),
      }),
    );

    await connector.deleteTask('task/id');
    expect(fetch).toHaveBeenLastCalledWith(
      'https://tasks.example.test/tasks/task%2Fid',
      expect.objectContaining({
        method: 'DELETE',
      }),
    );
  });

  it('rejects create responses without the configured upstream ID', async () => {
    const connector = new CustomRestConnector();
    await connector.initialize(config({ createEndpoint: '/tasks' }));

    await expect(connector.createTask({ title: 'Missing ID' }))
      .rejects.toThrow('configured task ID');
  });
});
