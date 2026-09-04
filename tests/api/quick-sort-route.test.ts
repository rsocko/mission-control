import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFakeTaskCorePersistence } from '../fixtures/task-core-fake';

const taskReads = vi.hoisted(() => ({
  listQuickSortTasks: vi.fn(),
  getQuickSortCounts: vi.fn(),
  listQuickSortSources: vi.fn(),
}));

describe('GET /api/tasks/quick-sort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    taskReads.listQuickSortTasks.mockResolvedValue([]);
    taskReads.getQuickSortCounts.mockResolvedValue({
      no_priority: 0,
      quadrant: 0,
      no_effort: 0,
      no_tags: 0,
      no_planning_horizon: 0,
    });
    taskReads.listQuickSortSources.mockResolvedValue({ rows: [], definitions: [] });
    registerFakeTaskCorePersistence({ taskReads });
  });

  it('returns repository queue rows with policy and compact context', async () => {
    taskReads.listQuickSortTasks.mockResolvedValue([{
      id: 'critical-task',
      title: 'Critical task',
      description: 'Important context',
      priority: 'critical',
      effort: 2,
      status: 'todo',
      connectorType: 'local',
      connectorInstanceId: 'local',
      sourceId: 'local:critical-task',
      sourceListId: null,
      sourceListName: null,
      dueDate: null,
      planningHorizon: null,
      createdAt: '2026-07-30T12:00:00.000Z',
      localDisposition: 'active',
      tags: [],
      projects: [{ id: 'project-1', name: 'Launch', color: '#6366f1' }],
      phases: [{ id: 'phase-1', name: 'Delivery', projectId: 'project-1' }],
    }]);

    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    const response = await GET(new Request(
      'http://localhost/api/tasks/quick-sort?mode=no_planning_horizon',
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      hasNotes: true,
      projects: [{ id: 'project-1', name: 'Launch', color: '#6366f1' }],
      phases: [{ id: 'phase-1', name: 'Delivery', projectId: 'project-1' }],
      taskSourceModel: 'mc-owned',
    });
    expect(body.tasks[0].description).toBeUndefined();
    expect(taskReads.listQuickSortTasks).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'no_planning_horizon',
      order: 'smart',
      limit: 50,
      sourceTypes: [],
    }));
  });

  it('returns badge counts before mode validation', async () => {
    taskReads.getQuickSortCounts.mockResolvedValue({
      no_priority: 1,
      quadrant: 1,
      no_effort: 2,
      no_tags: 3,
      no_planning_horizon: 4,
    });

    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    const response = await GET(new Request('http://localhost/api/tasks/quick-sort?counts=true'));

    await expect(response.json()).resolves.toEqual({
      counts: {
        no_priority: 1,
        quadrant: 1,
        no_effort: 2,
        no_tags: 3,
        no_planning_horizon: 4,
      },
    });
    expect(taskReads.listQuickSortTasks).not.toHaveBeenCalled();
  });

  it('preserves source-list-id precedence in the repository scope', async () => {
    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    await GET(new Request(
      'http://localhost/api/tasks/quick-sort?mode=no_tags'
        + '&source=github&sourceList=Legacy&sourceListId=repo-1&connectorId=gh-1',
    ));

    expect(taskReads.listQuickSortTasks).toHaveBeenCalledWith(expect.objectContaining({
      sourceListId: 'repo-1',
      sourceListName: null,
      connectorInstanceId: 'gh-1',
      sourceTypes: expect.any(Array),
    }));
  });

  it('groups legacy Mission Control sources under Local and keeps list metadata', async () => {
    taskReads.listQuickSortSources.mockResolvedValue({
      rows: [
        {
          connectorType: 'mission-control',
          connectorInstanceId: 'mc-local',
          sourceListId: 'local',
          sourceListName: 'Local',
          count: 3,
        },
        {
          connectorType: 'local',
          connectorInstanceId: 'local',
          sourceListId: 'local',
          sourceListName: 'Local',
          count: 2,
        },
        {
          connectorType: 'github-issues',
          connectorInstanceId: 'github',
          sourceListId: 'rsocko/mission-control',
          sourceListName: 'rsocko/mission-control',
          count: 4,
        },
      ],
      definitions: [{
        connectorInstanceId: 'github',
        sourceId: 'rsocko/mission-control',
        name: 'rsocko/mission-control',
        userDisplayName: null,
        type: 'repo',
        icon: 'dash:github',
        iconColor: null,
        hidden: false,
      }],
    });

    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    const response = await GET(new Request('http://localhost/api/tasks/quick-sort?sources=true'));
    const body = await response.json();

    expect(body.sources).not.toHaveProperty('mission-control');
    expect(body.sources.local).toMatchObject({ count: 5, lists: [] });
    expect(body.sources['github-issues'].lists).toEqual([{
      connectorId: 'github',
      sourceListId: 'rsocko/mission-control',
      name: 'rsocko/mission-control',
      count: 4,
      type: 'repo',
      icon: 'dash:github',
      iconColor: null,
    }]);
    expect(taskReads.getQuickSortCounts).not.toHaveBeenCalled();
  });
});
