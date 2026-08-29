import { beforeEach, describe, expect, it, vi } from 'vitest';
import { desc, inArray, isNull, lte } from 'drizzle-orm';

const mocks = vi.hoisted(() => {
  const terminals: unknown[] = [];
  const orderBy = vi.fn();

  function chainable(terminal: unknown) {
    const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve(terminal);
        }
        if (prop === 'orderBy') {
          return (...args: unknown[]) => {
            orderBy(...args);
            return chain;
          };
        }
        return vi.fn(() => chain);
      },
    });
    return chain;
  }

  return {
    terminals,
    orderBy,
    select: vi.fn(() => chainable(terminals.shift() ?? [])),
  };
});

vi.mock('@/db', () => ({
  default: {
    select: mocks.select,
  },
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'id',
    title: 'title',
    description: 'description',
    priority: 'priority',
    effort: 'effort',
    status: 'status',
    connectorType: 'connectorType',
    connectorInstanceId: 'connectorInstanceId',
    sourceListId: 'sourceListId',
    sourceListName: 'sourceListName',
    dueDate: 'dueDate',
    planningHorizon: 'planningHorizon',
    createdAt: 'createdAt',
    parentId: 'parentId',
    snoozedUntil: 'snoozedUntil',
  },
  taskTags: { taskId: 'taskId', tagId: 'tagId' },
  taskProjects: { taskId: 'taskId', projectId: 'projectId' },
  tags: { id: 'tagId', name: 'tagName', slug: 'tagSlug', color: 'tagColor' },
  hubProjects: { id: 'projectId', name: 'projectName', color: 'projectColor' },
  projectPhaseItems: { taskId: 'taskId', phaseId: 'phaseId', isProposed: 'isProposed' },
  projectPhases: { id: 'phaseId', name: 'phaseName', projectId: 'phaseProjectId' },
  sourceLists: {
    connectorInstanceId: 'sourceListConnectorInstanceId',
    sourceId: 'sourceListSourceId',
    name: 'sourceListDefinitionName',
    userDisplayName: 'sourceListUserDisplayName',
    type: 'sourceListType',
    icon: 'sourceListIcon',
    iconColor: 'sourceListIconColor',
    hidden: 'sourceListHidden',
  },
}));

describe('GET /api/tasks/quick-sort', () => {
  beforeEach(() => {
    mocks.terminals.length = 0;
    mocks.select.mockClear();
    mocks.orderBy.mockClear();
    vi.mocked(inArray).mockClear();
    vi.mocked(isNull).mockClear();
    vi.mocked(lte).mockClear();
    vi.mocked(desc).mockClear();
  });

  it('returns tasks without planning horizons in priority-first order', async () => {
    mocks.terminals.push([
      {
        id: 'critical-task',
        title: 'Critical task',
        description: 'Important context',
        priority: 'critical',
        effort: 2,
        status: 'todo',
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceListId: null,
        sourceListName: null,
        dueDate: null,
        planningHorizon: null,
        createdAt: '2026-07-30T12:00:00.000Z',
      },
    ],
    [],
    [{
      taskId: 'critical-task',
      projectId: 'project-1',
      projectName: 'Launch',
      projectColor: '#6366f1',
    }],
    [{
      taskId: 'critical-task',
      phaseId: 'phase-1',
      phaseName: 'Delivery',
      projectId: 'project-1',
    }]);

    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    const response = await GET(new Request('http://localhost/api/tasks/quick-sort?mode=no_planning_horizon'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.tasks).toHaveLength(1);
    expect(body.tasks[0]).toMatchObject({
      hasNotes: true,
      projects: [{ id: 'project-1', name: 'Launch', color: '#6366f1' }],
      phases: [{ id: 'phase-1', name: 'Delivery', projectId: 'project-1' }],
    });
    expect(body.tasks[0].description).toBeUndefined();
    expect(isNull).toHaveBeenCalledWith('planningHorizon');
    expect(isNull).toHaveBeenCalledWith('snoozedUntil');
    expect(lte).toHaveBeenCalledWith('snoozedUntil', expect.any(String));
    expect(desc).toHaveBeenCalledWith('createdAt');
    expect(mocks.orderBy).toHaveBeenCalled();
  });

  it('includes the plan/schedule queue in badge counts', async () => {
    mocks.terminals.push(
      [{ count: 1 }],
      [{ count: 2 }],
      [{ count: 3 }],
      [{ count: 4 }],
    );

    const { GET } = await import('@/app/api/tasks/quick-sort/route');
    const response = await GET(new Request('http://localhost/api/tasks/quick-sort?counts=true'));
    const body = await response.json();

    expect(body.counts).toEqual({
      no_priority: 1,
      quadrant: 1,
      no_effort: 2,
      no_tags: 3,
      no_planning_horizon: 4,
    });
  });

  it('groups legacy Mission Control tasks under Local and includes list icon metadata', async () => {
    mocks.terminals.push(
      [
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
        {
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo',
          sourceListId: null,
          sourceListName: 'Work',
          count: 6,
        },
      ],
      [
        {
          connectorInstanceId: 'github',
          sourceId: 'rsocko/mission-control',
          name: 'rsocko/mission-control',
          userDisplayName: null,
          type: 'repo',
          icon: 'dash:github',
          iconColor: null,
          hidden: false,
        },
        {
          connectorInstanceId: 'todo',
          sourceId: 'work-list',
          name: 'Work',
          userDisplayName: null,
          type: 'list',
          icon: 'mdi:briefcase',
          iconColor: '#60a5fa',
          hidden: false,
        },
      ],
    );

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
    expect(body.sources['microsoft-todo'].lists).toEqual([{
      connectorId: 'todo',
      sourceListId: 'work-list',
      name: 'Work',
      count: 6,
      type: 'list',
      icon: 'mdi:briefcase',
      iconColor: '#60a5fa',
    }]);
  });
});
