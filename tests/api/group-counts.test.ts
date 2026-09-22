import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const getGroupCounts = vi.fn();

describe('GET /api/tasks/group-counts', () => {
  beforeEach(() => {
    getGroupCounts.mockReset();
    getGroupCounts.mockResolvedValue({ 'To Do': 2 });
    registerFakeTaskCorePersistence({
      taskReads: { getGroupCounts },
    });
  });

  it('passes the portable canonical filter to the task-read repository', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status&quickFilter=inbox',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ counts: { 'To Do': 2 } });
    expect(getGroupCounts).toHaveBeenCalledWith({
      spec: expect.objectContaining({
        quickFilter: 'inbox',
        localDispositions: ['active'],
      }),
      groupBy: 'status',
    });
  });

  it.each(['source', 'effort', 'tag', 'project'] as const)(
    'delegates %s grouping without changing the response shape',
    async (groupBy) => {
      getGroupCounts.mockResolvedValue({ Example: 3 });
      const { GET } = await import('@/app/api/tasks/group-counts/route');
      const response = await GET(new Request(
        `http://localhost/api/tasks/group-counts?groupBy=${groupBy}`,
      ));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ counts: { Example: 3 } });
      expect(getGroupCounts).toHaveBeenCalledWith(expect.objectContaining({ groupBy }));
    },
  );

  it('rejects unsupported groupings before querying', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=unknown',
    ));

    expect(response.status).toBe(400);
    expect(getGroupCounts).not.toHaveBeenCalled();
  });

  it('preserves parent and source-list filters in the portable spec', async () => {
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status&parentOnly=true'
        + '&source=microsoft-todo&listId=phone-and-tech',
    ));

    expect(response.status).toBe(200);
    expect(getGroupCounts).toHaveBeenCalledWith({
      spec: expect.objectContaining({
        parentOnly: true,
        connectorTypes: ['microsoft-todo'],
        sourceListIds: ['phone-and-tech'],
      }),
      groupBy: 'status',
    });
  });

  it('rejects over-budget filters before querying', async () => {
    const values = Array.from({ length: 21 }, (_, index) => `tag-${index}`).join(',');
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      `http://localhost/api/tasks/group-counts?groupBy=status&tagSlugs=${values}`,
    ));

    expect(response.status).toBe(422);
    expect(getGroupCounts).not.toHaveBeenCalled();
  });

  it('preserves the existing internal-error response', async () => {
    getGroupCounts.mockRejectedValue(new Error('read failed'));
    const { GET } = await import('@/app/api/tasks/group-counts/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/group-counts?groupBy=status',
    ));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: 'Internal server error' });
  });
});
