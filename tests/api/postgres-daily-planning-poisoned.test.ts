import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});
vi.mock('@/db/schema', () => {
  throw new Error('SQLite schema module must not be evaluated');
});
vi.mock('@/db/contention', () => {
  throw new Error('SQLite contention helpers must not be evaluated');
});
vi.mock('@/db/task-history', () => {
  throw new Error('SQLite task-history helpers must not be evaluated');
});
vi.mock('@/lib/utils/sqlite-date', () => {
  throw new Error('SQLite date helpers must not be evaluated');
});

const calls = vi.hoisted(() => ({
  energyReplace: vi.fn(async () => undefined),
  focusAdd: vi.fn(async () => ({ outcome: 'added' as const, id: 'focus-1', slot: 2 })),
  focusRemoveById: vi.fn(async () => ({ removed: true })),
  focusRemoveByTask: vi.fn(async () => ({ removed: true })),
  focusMove: vi.fn(async () => ({ outcome: 'moved' as const })),
  scheduleUpsert: vi.fn(async () => undefined),
  scheduleRemove: vi.fn(async () => undefined),
  myDayAdd: vi.fn(async () => ({ outcome: 'added' as const, id: 'md-1', order: 3 })),
  myDayRemove: vi.fn(async () => ({ taskId: 'task-1' })),
  myDayReplaceOrder: vi.fn(async () => ({ outcome: 'saved' as const })),
  includeCompleted: vi.fn(async () => ({ outcome: 'noop' as const })),
  oneThingSelectAuto: vi.fn(async () => ({ outcome: 'selected' as const })),
  oneThingSelectManual: vi.fn(async () => ({ outcome: 'selected' as const })),
  oneThingClear: vi.fn(async () => undefined),
  settingsSet: vi.fn(async () => undefined),
  settingsDelete: vi.fn(async () => true),
  applyReconciliation: vi.fn(async () => ({ added: 0, dueTodayAdded: 0, removed: 0 })),
}));

const dailyPlanning = {
  energy: {
    getForDate: async () => ({
      id: 'energy-1',
      date: '2026-09-05',
      level: 'high',
      note: null,
      createdAt: '2026-09-05T12:00:00.000Z',
    }),
    replaceForDate: calls.energyReplace,
  },
  focus: {
    listBoard: async () => ({
      today: [{
        id: 'focus-1',
        taskId: 'task-1',
        scope: 'today' as const,
        date: '2026-09-05',
        slot: 1,
        addedAt: '2026-09-05T12:00:00.000Z',
        isAiSuggested: false,
        title: 'Focus task',
        status: 'todo',
        microStatus: null,
        priority: 'high',
        dueDate: null,
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceId: 'source-1',
        sourceListId: null,
        sourceListName: null,
      }],
      week: [],
    }),
    add: calls.focusAdd,
    removeById: calls.focusRemoveById,
    removeByTask: calls.focusRemoveByTask,
    moveToSlot: calls.focusMove,
  },
  dashboard: {
    snapshot: async () => ({
      totalOpen: 4,
      completedToday: 2,
      inProgress: 1,
      overdue: 3,
      queues: { triage: 5, sort: 6, overdue: 3 },
      recentActivity: [{ id: 'task-1', title: 'Done', completedAt: '2026-09-05T11:00:00.000Z' }],
    }),
  },
  navigation: {
    counts: async () => ({
      myDay: 1,
      triage: 2,
      quickSort: 3,
      reconciliation: 4,
      overdue: 5,
      notifications: {
        attention: 6, unread: 7, urgent: 0, actionNeeded: 2, headsUp: 1, fyi: 3,
      },
    }),
  },
  myDay: {
    dayView: async () => ({
      items: [{
        id: 'md-1',
        taskId: 'task-1',
        order: 1,
        isAutoIncluded: false,
        addedAt: '2026-09-05T12:00:00.000Z',
        title: 'Planned task',
        hasDescription: true,
        status: 'todo',
        statusReason: null,
        priority: 'high',
        planningHorizon: null,
        dueDate: null,
        pushCount: 0,
        connectorType: 'local',
        connectorInstanceId: 'local',
        sourceId: 'source-1',
        sourceListId: null,
        sourceListName: null,
        assignee: null,
        createdAt: '2026-09-04T12:00:00.000Z',
        completedAt: null,
        metadata: {},
        effort: null,
        microStatus: null,
        localDisposition: 'active',
        tags: [],
        subtaskTotal: 0,
        subtaskDone: 0,
        hubProjectIds: ['project-1'],
        projectPhases: [{ projectId: 'project-1', phaseId: 'phase-1', phaseName: 'Build' }],
        estimatedDuration: 30,
      }],
      suggestions: {
        planningSignals: [],
        planningNext: [],
        yesterday: [{
          id: 'task-2',
          title: 'Yesterday task',
          status: 'todo',
          microStatus: null,
          priority: 'none',
          planningHorizon: null,
          dueDate: null,
          pushCount: 0,
          connectorType: 'local',
          connectorInstanceId: 'local',
          sourceId: 'source-2',
          sourceListId: null,
          sourceListName: null,
          metadata: {},
          localDisposition: 'active',
        }],
        overdue: [],
        dueToday: [],
        dueThisWeek: [],
        highPriority: [],
        aiRecommended: [],
        recentlyAdded: [],
        carriedForward: [],
        repeatedlyRescheduled: [],
      },
    }),
    includeCompletedTasks: calls.includeCompleted,
    replaceOrder: calls.myDayReplaceOrder,
    add: calls.myDayAdd,
    remove: calls.myDayRemove,
    getRemoteIdentity: async () => null,
  },
  myDaySync: {
    snapshot: async () => ({
      localItems: [],
      excludedTaskIds: [],
      recurringHistory: [],
      archivedDuplicateSourceIds: [],
    }),
    findTasksBySourceIds: async () => [],
    listCompletedMyDaySiblings: async () => [],
    createTaskFromRemote: async () => ({ created: false, task: null }),
    applyReconciliation: calls.applyReconciliation,
    listOpenDueTodayTaskIds: async () => [],
    listOpenDueTodayTasks: async () => [],
    listMyDayTaskIds: async () => [],
    resolveTaskIdsBySourceIds: async () => [],
  },
  oneThing: {
    getForWeek: async () => null,
    markCompleted: async () => undefined,
    subtaskProgress: async () => ({ total: 0, done: 0 }),
    listCandidates: async () => [{
      id: 'task-1',
      title: 'Candidate',
      status: 'todo',
      priority: 'critical',
      dueDate: null,
      connectorType: 'local',
      sourceListName: null,
      updatedAt: '2026-09-05T12:00:00.000Z',
      depth: 0,
    }],
    listMyDayTaskIds: async () => [],
    selectAuto: calls.oneThingSelectAuto,
    selectManual: calls.oneThingSelectManual,
    clearForWeek: calls.oneThingClear,
  },
  schedule: {
    listForDate: async () => [{
      taskId: 'task-1',
      scheduledDate: '2026-09-05',
      scheduledTime: '09:00',
      estimatedDuration: 45,
      isTimeBlocked: true,
      recurrence: null,
      title: 'Blocked',
      status: 'todo',
      priority: 'high',
      dueDate: null,
      connectorType: 'local',
      sourceListName: null,
    }],
    upsert: calls.scheduleUpsert,
    remove: calls.scheduleRemove,
  },
  recentWins: {
    listRecentCompletions: async () => [{
      id: 'task-1',
      title: 'Shipped it',
      priority: 'high',
      completedAt: '2026-09-05T11:00:00.000Z',
      connectorType: 'local',
      sourceListName: 'Work',
      dueDate: null,
      recurrence: null,
    }],
  },
};

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    connectors: { listEnabled: async () => [] },
    dailyPlanning,
  }),
}));

vi.mock('@/lib/tasks/core/runtime', () => ({
  getTaskCorePersistence: async () => ({
    queries: { countTasks: async () => 0 },
  }),
}));

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    settings: {
      get: async () => null,
      set: calls.settingsSet,
      delete: calls.settingsDelete,
    },
  }),
}));

vi.mock('@/lib/tasks/edit-policy', () => ({
  resolveTaskEditPolicies: async (rows: ReadonlyArray<{ id: string }>) => new Map(
    rows.map((row) => [row.id, { sourceModel: 'local', canEdit: true }]),
  ),
  requireTaskEditPolicy: (
    policies: ReadonlyMap<string, unknown>,
    taskId: string,
  ) => policies.get(taskId) ?? { sourceModel: 'local', canEdit: true },
}));

vi.mock('@/lib/utils/resolve-task-list-names', () => ({
  buildSourceListNameMap: async () => new Map<string, string>(),
  resolveTaskListName: (task: { sourceListName: string | null }) => task.sourceListName,
}));

vi.mock('@/lib/planning-signals', () => ({
  appendPlanningSignal: vi.fn(async () => true),
  finalizePlanningSignals: vi.fn(async () => undefined),
  finalizePlanningSignalsIfDue: vi.fn(async () => null),
  planningFrictionEventTypes: () => ['my_day_missed'],
}));

vi.mock('@/lib/connectors/registry-runtime', () => ({
  connectorRegistry: { getConnector: () => undefined },
}));

vi.mock('@/lib/connectors/microsoft-todo', () => ({
  MicrosoftTodoConnector: class {
    initialize = vi.fn().mockResolvedValue(undefined);
    fetchMyDayTasks = vi.fn().mockResolvedValue([]);
    fetchMyDaySuggestions = vi.fn().mockResolvedValue([]);
  },
}));

const BASE = 'http://localhost:3099';

function request(path: string, init?: RequestInit) {
  return new Request(`${BASE}${path}`, init);
}

function json(path: string, method: string, body: unknown) {
  return request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('poisoned-SQLite daily-planning web surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serves the energy check-in lifecycle without evaluating SQLite', async () => {
    const route = await import('@/app/api/energy/route');

    const read = await route.GET(request('/api/energy?date=2026-09-05'));
    expect(read.status).toBe(200);
    expect((await read.json()).checkin).toMatchObject({ level: 'high' });

    const written = await route.POST(json('/api/energy', 'POST', {
      level: 'low',
      note: 'tired',
      date: '2026-09-05',
    }));
    expect(written.status).toBe(200);
    expect(calls.energyReplace).toHaveBeenCalledWith(
      expect.objectContaining({ date: '2026-09-05', level: 'low', note: 'tired' }),
    );
    expect((await route.POST(json('/api/energy', 'POST', { level: 'nope' }))).status).toBe(400);
  });

  it('serves the Focus 3 board and its mutations without evaluating SQLite', async () => {
    const route = await import('@/app/api/focus-items/route');

    const board = await route.GET(request('/api/focus-items?date=2026-09-05'));
    expect(board.status).toBe(200);
    expect((await board.json()).today[0]).toMatchObject({ taskId: 'task-1', slot: 1 });

    expect((await route.POST(json('/api/focus-items', 'POST', {
      taskId: 'task-2',
      scope: 'today',
    }))).status).toBe(201);
    expect(calls.focusAdd).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'today', maxSlots: 3 }),
    );

    calls.focusAdd.mockResolvedValueOnce({ outcome: 'full' } as never);
    expect((await route.POST(json('/api/focus-items', 'POST', {
      taskId: 'task-3',
      scope: 'today',
    }))).status).toBe(409);

    expect((await route.DELETE(request('/api/focus-items?id=focus-1', {
      method: 'DELETE',
    }))).status).toBe(200);
    expect(calls.focusRemoveById).toHaveBeenCalled();
    expect((await route.DELETE(request(
      '/api/focus-items?taskId=task-1&scope=week',
      { method: 'DELETE' },
    ))).status).toBe(200);
    expect(calls.focusRemoveByTask).toHaveBeenCalled();

    expect((await route.PATCH(json('/api/focus-items', 'PATCH', {
      id: 'focus-1',
      slot: 2,
    }))).status).toBe(200);
    calls.focusMove.mockResolvedValueOnce({ outcome: 'not-found' } as never);
    expect((await route.PATCH(json('/api/focus-items', 'PATCH', {
      id: 'missing',
      slot: 2,
    }))).status).toBe(404);
  });

  it('serves the mobile dashboard and navigation counts without evaluating SQLite', async () => {
    const [dashboard, navigation] = await Promise.all([
      import('@/app/api/mobile-dashboard/route'),
      import('@/app/api/navigation/counts/route'),
    ]);

    const dashboardResponse = await dashboard.GET(
      request('/api/mobile-dashboard?today=2026-09-05'),
    );
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.json()).toMatchObject({
      today: { totalOpen: 4, completedToday: 2, inProgress: 1, overdue: 3 },
      queues: { triage: 5, sort: 6, overdue: 3 },
    });

    const navigationResponse = await navigation.GET(
      request('/api/navigation/counts?date=2026-09-05'),
    );
    expect(navigationResponse.status).toBe(200);
    expect(await navigationResponse.json()).toMatchObject({
      myDay: 1,
      triage: 2,
      quickSort: 3,
      reconciliation: 4,
      overdue: 5,
      unreadNotifications: 7,
    });
  });

  it('serves the My Day view and mutations without evaluating SQLite', async () => {
    const route = await import('@/app/api/my-day/route');

    const view = await route.GET(request('/api/my-day?date=2026-09-05'));
    expect(view.status).toBe(200);
    const body = await view.json();
    expect(body.items[0]).toMatchObject({
      id: 'md-1',
      taskId: 'task-1',
      hasDescription: true,
      estimatedDuration: 30,
      projectPhaseMemberships: [
        { projectId: 'project-1', phaseId: 'phase-1', phaseName: 'Build' },
      ],
    });
    expect(body.items[0]).not.toHaveProperty('projectPhases');
    expect(body.suggestions.yesterday[0]).toMatchObject({ id: 'task-2' });
    expect(body.suggestions.yesterday[0]).not.toHaveProperty('localDisposition');

    expect((await route.POST(json('/api/my-day', 'POST', { taskId: 'task-9' }))).status)
      .toBe(201);
    calls.myDayAdd.mockResolvedValueOnce({ outcome: 'exists', id: 'md-existing' } as never);
    expect((await route.POST(json('/api/my-day', 'POST', { taskId: 'task-9' }))).status)
      .toBe(200);

    expect((await route.PATCH(json('/api/my-day', 'PATCH', {
      date: '2026-09-05',
      orderedItemIds: ['md-1'],
    }))).status).toBe(200);
    calls.myDayReplaceOrder.mockResolvedValueOnce({ outcome: 'stale' } as never);
    expect((await route.PATCH(json('/api/my-day', 'PATCH', {
      date: '2026-09-05',
      orderedItemIds: ['md-1'],
    }))).status).toBe(409);

    expect((await route.DELETE(request('/api/my-day?id=md-1', { method: 'DELETE' }))).status)
      .toBe(200);
    expect(calls.myDayRemove).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 'md-1', exclusionId: expect.any(String) }),
    );
  });

  it('reconciles My Day against Microsoft To Do without evaluating SQLite', async () => {
    const route = await import('@/app/api/my-day/sync/route');

    const response = await route.POST(json('/api/my-day/sync', 'POST', {
      date: '2026-09-05',
    }));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: 'No Microsoft Todo connector configured',
      synced: 0,
    });
  });

  it('serves the weekly one thing without evaluating SQLite', async () => {
    const route = await import('@/app/api/one-thing/route');

    const selected = await route.GET(request('/api/one-thing?date=2026-09-05'));
    expect(selected.status).toBe(200);
    expect((await selected.json()).oneThing).toMatchObject({ taskId: 'task-1' });
    expect(calls.oneThingSelectAuto).toHaveBeenCalled();

    expect((await route.POST(json('/api/one-thing', 'POST', { taskId: 'task-1' }))).status)
      .toBe(201);
    calls.oneThingSelectManual.mockResolvedValueOnce({ outcome: 'task-not-found' } as never);
    expect((await route.POST(json('/api/one-thing', 'POST', { taskId: 'missing' }))).status)
      .toBe(404);
    expect((await route.DELETE(request('/api/one-thing', { method: 'DELETE' }))).status)
      .toBe(200);
    expect(calls.oneThingClear).toHaveBeenCalled();
  });

  it('serves the schedule lifecycle without evaluating SQLite', async () => {
    const route = await import('@/app/api/schedule/route');

    const listed = await route.GET(request('/api/schedule?date=2026-09-05'));
    expect(listed.status).toBe(200);
    expect(await listed.json()).toMatchObject({
      stats: { totalTasks: 1, totalMinutes: 45, blockedMinutes: 45 },
    });

    expect((await route.POST(json('/api/schedule', 'POST', {
      taskId: 'task-1',
      date: '2026-09-05',
      time: '09:00',
    }))).status).toBe(200);
    expect(calls.scheduleUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-1', scheduledDate: '2026-09-05' }),
    );
    expect((await route.DELETE(request('/api/schedule?taskId=task-1', {
      method: 'DELETE',
    }))).status).toBe(200);
    expect(calls.scheduleRemove).toHaveBeenCalledWith('task-1');
  });

  it('serves recent wins, dismissal, and settings without evaluating SQLite', async () => {
    const [wins, dismiss, settings] = await Promise.all([
      import('@/app/api/recent-wins/route'),
      import('@/app/api/recent-wins/dismiss/route'),
      import('@/app/api/recent-wins/settings/route'),
    ]);

    const listed = await wins.GET();
    expect(listed.status).toBe(200);
    expect((await listed.json()).totalCount).toBe(1);

    expect((await dismiss.POST(json('/api/recent-wins/dismiss', 'POST', {
      action: 'snooze-day',
    }))).status).toBe(200);
    expect(calls.settingsSet).toHaveBeenCalledWith(
      'recent-wins-snoozed',
      expect.objectContaining({ type: 'day' }),
    );

    expect((await settings.GET()).status).toBe(200);
    expect((await settings.PUT(json('/api/recent-wins/settings', 'PUT', {
      deprioritizedLists: ['Chores'],
    }))).status).toBe(200);
    expect(calls.settingsSet).toHaveBeenCalledWith(
      'recent-wins-deprioritized-lists',
      ['Chores'],
    );
  });
});
