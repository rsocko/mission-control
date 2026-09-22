import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const listDistinctTaskAssignees = vi.fn();

describe('GET /api/tasks/filter-options', () => {
  beforeEach(() => {
    listDistinctTaskAssignees.mockReset();
    listDistinctTaskAssignees.mockResolvedValue(['   ', ' alice', 'alice ', 'bob']);
    registerFakeTaskCorePersistence({
      taskReads: { listDistinctTaskAssignees },
    });
  });

  it('trims non-empty assignees without collapsing post-trim duplicates', async () => {
    const { GET } = await import('@/app/api/tasks/filter-options/route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assignees: ['alice', 'alice', 'bob'],
    });
    expect(listDistinctTaskAssignees).toHaveBeenCalledOnce();
  });

  it('preserves the existing internal-error response', async () => {
    listDistinctTaskAssignees.mockRejectedValue(new Error('read failed'));
    const { GET } = await import('@/app/api/tasks/filter-options/route');
    const response = await GET();

    expect(response.status).toBe(500);
  });
});
