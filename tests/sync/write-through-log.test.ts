import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  values: vi.fn().mockResolvedValue(undefined),
  error: vi.fn(),
}));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: vi.fn(async () => ({
    syncRuns: { append: mocks.values },
  })),
}));
vi.mock('@/lib/logger', () => ({
  syncLogger: { error: mocks.error },
}));
vi.mock('node:crypto', () => ({
  default: { randomUUID: vi.fn(() => 'write-through-log-id') },
  randomUUID: vi.fn(() => 'write-through-log-id'),
}));

import { logWriteThrough } from '@/lib/sync/write-through-log';

describe('write-through sync logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a focused audit entry without advancing pull duration', async () => {
    await logWriteThrough({
      connectorId: 'github-1',
      action: 'updated',
      taskId: 'task-1',
      taskTitle: 'Keep compatibility',
      taskSourceId: 'owner/repo:1222',
    });

    expect(mocks.values).toHaveBeenCalledWith(expect.objectContaining({
      id: 'write-through-log-id',
      connectorId: 'github-1',
      success: true,
      tasksAdded: 0,
      tasksUpdated: 1,
      tasksPushed: 1,
      durationMs: 0,
      details: [{
        action: 'pushed',
        taskId: 'task-1',
        taskTitle: 'Keep compatibility',
        taskSourceId: 'owner/repo:1222',
        reason: 'Write-through: updated',
      }],
    }));
  });

  it('logs persistence failures without rejecting the write-through caller', async () => {
    const failure = new Error('database unavailable');
    mocks.values.mockRejectedValueOnce(failure);
    const params = {
      connectorId: 'github-1',
      action: 'completed' as const,
      taskId: 'task-1',
      taskTitle: 'Keep compatibility',
      taskSourceId: 'owner/repo:1222',
    };

    await expect(logWriteThrough(params)).resolves.toBeUndefined();
    expect(mocks.error).toHaveBeenCalledWith(
      { err: failure, ...params },
      'Failed to log write-through to sync_log',
    );
  });
});
