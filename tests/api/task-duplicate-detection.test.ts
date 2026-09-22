import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const mocks = vi.hoisted(() => ({
  tasks: [] as Array<{
    id: string;
    title: string;
    status: string;
    sourceId: string;
    connectorType: string;
    createdAt: string;
  }>,
  listDuplicateDetectionTasks: vi.fn(),
}));

function task(index: number, title = `Task ${index}`) {
  return {
    id: `task-${index}`,
    title,
    status: 'todo',
    sourceId: `source-${index}`,
    connectorType: 'test',
    createdAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
  };
}

describe('GET /api/tasks/detect-duplicates', () => {
  beforeEach(() => {
    mocks.tasks = [];
    mocks.listDuplicateDetectionTasks.mockReset();
    mocks.listDuplicateDetectionTasks.mockImplementation(async () => mocks.tasks);
    registerFakeTaskCorePersistence({
      taskReads: {
        listDuplicateDetectionTasks: mocks.listDuplicateDetectionTasks,
      },
    });
  });

  it('rejects global scans that exceed the comparison budget', async () => {
    mocks.tasks = Array.from({ length: 449 }, (_, index) => task(index));
    const { GET } = await import('@/app/api/tasks/detect-duplicates/route');

    const response = await GET(new Request(
      'http://localhost/api/tasks/detect-duplicates?threshold=0.70',
    ));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: expect.stringContaining('Provide taskId'),
      code: 'VALIDATION_ERROR',
    });
    expect(mocks.listDuplicateDetectionTasks).toHaveBeenCalledWith({
      includeClosedTasks: false,
    });
  });

  it('keeps per-task scans available above the global limit', async () => {
    mocks.tasks = [
      task(0, 'Prepare quarterly report'),
      ...Array.from({ length: 448 }, (_, index) => task(index + 1)),
      task(450, 'Prepare quarterly report'),
    ];
    const { GET } = await import('@/app/api/tasks/detect-duplicates/route');

    const response = await GET(new Request(
      'http://localhost/api/tasks/detect-duplicates?taskId=task-0',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      taskId: 'task-0',
      duplicates: [
        expect.objectContaining({ id: 'task-450', score: 1 }),
      ],
    });
    expect(mocks.listDuplicateDetectionTasks).toHaveBeenCalledWith({
      includeClosedTasks: false,
    });
  });

  it('still groups duplicates in bounded global scans', async () => {
    mocks.tasks = [
      task(0, 'Prepare quarterly report'),
      task(1, 'Prepare quarterly report'),
      task(2, 'Buy groceries'),
    ];
    const { GET } = await import('@/app/api/tasks/detect-duplicates/route');

    const response = await GET(new Request(
      'http://localhost/api/tasks/detect-duplicates',
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalGroups: 1,
      groups: [
        {
          canonical: expect.objectContaining({ id: 'task-0' }),
          duplicates: [expect.objectContaining({ id: 'task-1', score: 1 })],
        },
      ],
    });
  });
});
