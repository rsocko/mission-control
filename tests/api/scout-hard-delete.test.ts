import { beforeEach, describe, expect, it, vi } from 'vitest';

const { hardDeleteScoutTask } = vi.hoisted(() => ({
  hardDeleteScoutTask: vi.fn(),
}));

vi.mock('@/lib/tasks/scout-hard-delete', () => ({ hardDeleteScoutTask }));
vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DELETE /api/tasks/[id]/hard-delete', () => {
  it('returns the explicit Scout suppression contract', async () => {
    hardDeleteScoutTask.mockReturnValue({
      kind: 'deleted',
      taskId: 'task-1',
      sourceId: 'scout:email:item-1',
      deletedTaskIds: ['task-1'],
    });
    const { DELETE } = await import('@/app/api/tasks/[id]/hard-delete/route');

    const response = await DELETE(
      new Request('http://localhost/api/tasks/task-1/hard-delete', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'task-1' }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      action: 'hard-deleted',
      sourceId: 'scout:email:item-1',
      suppressedFromIngest: true,
    });
  });

  it('keeps missing and non-Scout tasks outside the destructive contract', async () => {
    const { DELETE } = await import('@/app/api/tasks/[id]/hard-delete/route');
    hardDeleteScoutTask.mockReturnValueOnce({ kind: 'not-found' });
    const missing = await DELETE(
      new Request('http://localhost/api/tasks/missing/hard-delete', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'missing' }) },
    );
    hardDeleteScoutTask.mockReturnValueOnce({ kind: 'not-scout' });
    const nonScout = await DELETE(
      new Request('http://localhost/api/tasks/local/hard-delete', { method: 'DELETE' }),
      { params: Promise.resolve({ id: 'local' }) },
    );

    expect(missing.status).toBe(404);
    expect(nonScout.status).toBe(400);
  });
});
