import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canUndoTaskRemoval,
  bulkTaskRemovalLabel,
  removeTask,
  taskRemovalResultLabel,
  undoTaskRemoval,
} from '@/lib/tasks/task-removal';

function jsonResponse(data: unknown, ok = true) {
  return { ok, json: async () => data } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('task removal client', () => {
  it.each([
    [{ action: 'dismissed', restorable: false }, 'Task dismissed in Mission Control'],
    [{ action: 'cancelled', restorable: false }, 'Task cancelled'],
    [{ action: 'closed', restorable: false }, 'Task closed at source'],
    [{ action: 'deleted', restorable: false }, 'Task deleted from source'],
    [{ action: 'deleted', restorable: true }, 'Task deleted'],
  ] as const)('describes removal result %#', (result, label) => {
    expect(taskRemovalResultLabel(result)).toBe(label);
  });

  it('parses a successful removal and surfaces API errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ action: 'deleted', restorable: true }))
      .mockResolvedValueOnce(jsonResponse({ error: 'Source rejected deletion' }, false));
    vi.stubGlobal('fetch', fetchMock);

    await expect(removeTask('task-1')).resolves.toEqual({
      action: 'deleted',
      restorable: true,
    });
    await expect(removeTask('task-2')).rejects.toThrow('Source rejected deletion');
  });

  it('restores deleted tasks and reactivates dismissed tasks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);

    await undoTaskRemoval('deleted-task', { action: 'deleted', restorable: true }, 'active');
    await undoTaskRemoval('dismissed-task', { action: 'dismissed', restorable: false }, 'handled');

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/tasks/deleted-task/restore',
      { method: 'POST' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      '/api/tasks/dismissed-task',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ localDisposition: 'handled' }),
      }),
    );
  });

  it('only offers undo for locally recoverable removals', () => {
    expect(canUndoTaskRemoval({ action: 'deleted', restorable: true })).toBe(true);
    expect(canUndoTaskRemoval({ action: 'dismissed', restorable: false })).toBe(true);
    expect(canUndoTaskRemoval({ action: 'cancelled', restorable: false })).toBe(false);
    expect(canUndoTaskRemoval({ action: 'closed', restorable: false })).toBe(false);
  });

  it('makes partial bulk undo scope explicit', () => {
    expect(bulkTaskRemovalLabel(3, 0)).toBe('3 tasks removed');
    expect(bulkTaskRemovalLabel(3, 3)).toBe('3 tasks removed');
    expect(bulkTaskRemovalLabel(3, 2)).toBe('3 tasks removed; 2 can be undone');
  });
});
