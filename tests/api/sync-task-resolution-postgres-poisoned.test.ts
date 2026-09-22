import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sqliteTouched: vi.fn(),
  findTask: vi.fn(),
}));

vi.mock('@/db', () => {
  mocks.sqliteTouched();
  throw new Error('POISONED: sync task resolution must not import SQLite');
});
vi.mock('@/lib/tasks/local-task-lifecycle', () => ({
  getTaskByRetentionIdentity: mocks.findTask,
}));

import { GET } from '@/app/api/sync/tasks/resolve/route';

describe('GET /api/sync/tasks/resolve with SQLite poisoned', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates both identity components before persistence access', async () => {
    const response = await GET(new Request(
      'http://localhost/api/sync/tasks/resolve?connectorId=connector-1',
    ));

    expect(response.status).toBe(400);
    expect(mocks.findTask).not.toHaveBeenCalled();
  });

  it('resolves the canonical connector/source identity without SQLite', async () => {
    mocks.findTask.mockResolvedValue({ id: 'task-1' });

    const response = await GET(new Request(
      'http://localhost/api/sync/tasks/resolve?connectorId=connector-1&sourceId=remote-1',
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: 'task-1' });
    expect(mocks.findTask).toHaveBeenCalledWith({
      connectorId: 'connector-1',
      taskSourceId: 'remote-1',
    });
    expect(mocks.sqliteTouched).not.toHaveBeenCalled();
  });

  it('returns a null task id for an unknown identity', async () => {
    mocks.findTask.mockResolvedValue(null);

    const response = await GET(new Request(
      'http://localhost/api/sync/tasks/resolve?connectorId=connector-1&sourceId=missing',
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskId: null });
  });
});
