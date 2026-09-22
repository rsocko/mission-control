import { beforeEach, describe, expect, it } from 'vitest';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';

export const PLANNING_DATE = '2026-09-05';
export const PLANNING_WEEK_MONDAY = '2026-08-31';
export const PLANNING_NOW = '2026-09-05T12:00:00.000Z';

export interface DailyPlanningTaskSeed {
  id: string;
  title?: string;
  status?: string;
  priority?: string;
  dueDate?: string | null;
  completedAt?: string | null;
  updatedAt?: string;
  createdAt?: string;
  parentId?: string | null;
  depth?: number;
  pushCount?: number;
  planningHorizon?: string | null;
  localDisposition?: string;
  connectorType?: string;
  connectorInstanceId?: string;
  sourceId?: string;
  sourceListId?: string | null;
  sourceListName?: string | null;
  description?: string | null;
  microStatus?: string | null;
}

export interface DailyPlanningContractHarness {
  persistence: DailyPlanningPersistence;
  reset(): Promise<void>;
  seedTasks(tasks: readonly DailyPlanningTaskSeed[]): Promise<void>;
  countPlanningSignals(taskId: string, eventType: string): Promise<number>;
  countMyDayExclusions(taskId: string, date: string): Promise<number>;
}

const SIGNAL = { provenance: 'contract', metadata: { origin: 'explicit-local' } };

export function describeDailyPlanningPersistenceContract(
  label: string,
  createHarness: () => DailyPlanningContractHarness | Promise<DailyPlanningContractHarness>,
): void {
  describe(`${label} daily-planning persistence contract`, () => {
    let harness: DailyPlanningContractHarness;
    let persistence: DailyPlanningPersistence;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
      persistence = harness.persistence;
    });

    it('replaces the energy check-in for a date and keeps other dates intact', async () => {
      await expect(persistence.energy.getForDate(PLANNING_DATE)).resolves.toBeNull();

      await persistence.energy.replaceForDate({
        id: 'energy-1',
        date: PLANNING_DATE,
        level: 'low',
        note: null,
        createdAt: PLANNING_NOW,
      });
      await persistence.energy.replaceForDate({
        id: 'energy-2',
        date: PLANNING_DATE,
        level: 'high',
        note: 'second wind',
        createdAt: '2026-09-05T18:00:00.000Z',
      });
      await persistence.energy.replaceForDate({
        id: 'energy-other',
        date: '2026-09-06',
        level: 'medium',
        note: null,
        createdAt: PLANNING_NOW,
      });

      await expect(persistence.energy.getForDate(PLANNING_DATE)).resolves.toEqual({
        id: 'energy-2',
        date: PLANNING_DATE,
        level: 'high',
        note: 'second wind',
        createdAt: '2026-09-05T18:00:00.000Z',
      });
      await expect(persistence.energy.getForDate('2026-09-06')).resolves.toMatchObject({
        id: 'energy-other',
        level: 'medium',
        note: null,
      });
    });

    it('allocates focus slots, rejects duplicates and capacity, and signals only today', async () => {
      await harness.seedTasks([
        { id: 'focus-a' }, { id: 'focus-b' }, { id: 'focus-c' }, { id: 'focus-d' },
      ]);

      const add = (taskId: string, scope: 'today' | 'week' = 'today') => persistence.focus.add({
        id: `focus-item-${taskId}-${scope}`,
        taskId,
        scope,
        date: scope === 'week' ? PLANNING_WEEK_MONDAY : PLANNING_DATE,
        addedAt: PLANNING_NOW,
        isAiSuggested: false,
        maxSlots: 3,
        signal: SIGNAL,
      });

      await expect(add('focus-a')).resolves.toEqual({
        outcome: 'added', id: 'focus-item-focus-a-today', slot: 1,
      });
      await expect(add('focus-b')).resolves.toMatchObject({ outcome: 'added', slot: 2 });
      await expect(add('focus-c')).resolves.toMatchObject({ outcome: 'added', slot: 3 });
      await expect(add('focus-a')).resolves.toEqual({ outcome: 'duplicate' });
      await expect(add('focus-d')).resolves.toEqual({ outcome: 'full' });
      await expect(add('focus-d', 'week')).resolves.toMatchObject({ outcome: 'added', slot: 1 });

      await expect(harness.countPlanningSignals('focus-a', 'focus_committed')).resolves.toBe(1);
      // Week-scope focus never records a today commitment.
      await expect(harness.countPlanningSignals('focus-d', 'focus_committed')).resolves.toBe(0);

      const board = await persistence.focus.listBoard({
        date: PLANNING_DATE,
        weekMonday: PLANNING_WEEK_MONDAY,
      });
      expect(board.today.map((item) => [item.taskId, item.slot])).toEqual([
        ['focus-a', 1], ['focus-b', 2], ['focus-c', 3],
      ]);
      expect(board.today[0]).toMatchObject({
        scope: 'today',
        date: PLANNING_DATE,
        isAiSuggested: false,
        title: 'focus-a',
      });
      expect(board.week.map((item) => item.taskId)).toEqual(['focus-d']);
    });

    it('swaps an occupied focus slot and withdraws by id or by task', async () => {
      await harness.seedTasks([{ id: 'swap-a' }, { id: 'swap-b' }]);
      await persistence.focus.add({
        id: 'swap-item-a',
        taskId: 'swap-a',
        scope: 'today',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        isAiSuggested: false,
        maxSlots: 3,
        signal: SIGNAL,
      });
      await persistence.focus.add({
        id: 'swap-item-b',
        taskId: 'swap-b',
        scope: 'today',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        isAiSuggested: true,
        maxSlots: 3,
        signal: SIGNAL,
      });

      await expect(persistence.focus.moveToSlot({ id: 'swap-item-b', slot: 1 }))
        .resolves.toEqual({ outcome: 'moved' });
      await expect(persistence.focus.moveToSlot({ id: 'missing', slot: 1 }))
        .resolves.toEqual({ outcome: 'not-found' });

      const board = await persistence.focus.listBoard({
        date: PLANNING_DATE,
        weekMonday: PLANNING_WEEK_MONDAY,
      });
      expect(board.today.map((item) => [item.id, item.slot])).toEqual([
        ['swap-item-b', 1], ['swap-item-a', 2],
      ]);
      expect(board.today[0].isAiSuggested).toBe(true);

      await expect(persistence.focus.removeById({
        id: 'swap-item-b',
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ removed: true });
      await expect(persistence.focus.removeById({
        id: 'swap-item-b',
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ removed: false });
      await expect(harness.countPlanningSignals('swap-b', 'focus_withdrawn')).resolves.toBe(1);

      await expect(persistence.focus.removeByTask({
        taskId: 'swap-a',
        scope: 'today',
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ removed: true });
      await expect(persistence.focus.removeByTask({
        taskId: 'swap-a',
        scope: 'today',
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ removed: false });
      await expect(harness.countPlanningSignals('swap-a', 'focus_withdrawn')).resolves.toBe(1);
    });

    it('upserts, lists and removes task schedules keyed by task', async () => {
      await harness.seedTasks([
        { id: 'sched-a', title: 'Blocked', dueDate: '2026-09-05' },
        { id: 'sched-b', title: 'Loose' },
      ]);

      await persistence.schedule.upsert({
        taskId: 'sched-a',
        scheduledDate: PLANNING_DATE,
        scheduledTime: '09:00',
        estimatedDuration: 45,
        isTimeBlocked: true,
        recurrence: 'daily',
      });
      await persistence.schedule.upsert({
        taskId: 'sched-b',
        scheduledDate: PLANNING_DATE,
        scheduledTime: null,
        estimatedDuration: null,
        isTimeBlocked: false,
        recurrence: null,
      });
      // A second upsert replaces the row rather than creating a duplicate.
      await persistence.schedule.upsert({
        taskId: 'sched-a',
        scheduledDate: PLANNING_DATE,
        scheduledTime: '10:30',
        estimatedDuration: 60,
        isTimeBlocked: true,
        recurrence: null,
      });

      const scheduled = await persistence.schedule.listForDate(PLANNING_DATE);
      expect(scheduled.map((row) => row.taskId)).toEqual(['sched-b', 'sched-a']);
      expect(scheduled[1]).toMatchObject({
        taskId: 'sched-a',
        scheduledTime: '10:30',
        estimatedDuration: 60,
        isTimeBlocked: true,
        recurrence: null,
        title: 'Blocked',
        dueDate: '2026-09-05',
      });
      expect(scheduled[0]).toMatchObject({
        scheduledTime: null,
        estimatedDuration: null,
        isTimeBlocked: false,
      });

      await persistence.schedule.remove('sched-a');
      await expect(persistence.schedule.listForDate(PLANNING_DATE)).resolves.toHaveLength(1);
      await expect(persistence.schedule.listForDate('2026-09-06')).resolves.toEqual([]);
    });

    it('projects recent completions newest-first with their recurrence', async () => {
      await harness.seedTasks([
        { id: 'win-old', status: 'done', completedAt: '2026-09-01T10:00:00.000Z' },
        { id: 'win-new', status: 'done', completedAt: '2026-09-04T10:00:00.000Z' },
        { id: 'win-stale', status: 'done', completedAt: '2026-08-01T10:00:00.000Z' },
        { id: 'win-open', status: 'todo' },
      ]);
      await persistence.schedule.upsert({
        taskId: 'win-new',
        scheduledDate: PLANNING_DATE,
        scheduledTime: null,
        estimatedDuration: null,
        isTimeBlocked: false,
        recurrence: 'weekly',
      });

      const wins = await persistence.recentWins.listRecentCompletions({
        completedFrom: '2026-08-29T00:00:00.000Z',
      });
      expect(wins.map((win) => win.id)).toEqual(['win-new', 'win-old']);
      expect(wins[0]).toMatchObject({ recurrence: 'weekly' });
      expect(wins[1]).toMatchObject({ recurrence: null });
    });

    it('adds, orders, removes and excludes My Day items atomically', async () => {
      await harness.seedTasks([{ id: 'day-a' }, { id: 'day-b' }, { id: 'day-c' }]);

      await expect(persistence.myDay.add({
        id: 'md-a',
        taskId: 'day-a',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ outcome: 'added', id: 'md-a', order: 1 });
      await expect(persistence.myDay.add({
        id: 'md-b',
        taskId: 'day-b',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ outcome: 'added', id: 'md-b', order: 2 });
      await expect(persistence.myDay.add({
        id: 'md-duplicate',
        taskId: 'day-a',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ outcome: 'exists', id: 'md-a' });
      await expect(harness.countPlanningSignals('day-a', 'my_day_committed')).resolves.toBe(1);

      await expect(persistence.myDay.replaceOrder({
        date: PLANNING_DATE,
        orderedItemIds: ['md-b', 'md-a'],
      })).resolves.toEqual({ outcome: 'saved' });
      await expect(persistence.myDay.replaceOrder({
        date: PLANNING_DATE,
        orderedItemIds: ['md-b'],
      })).resolves.toEqual({ outcome: 'stale' });

      const view = await persistence.myDay.dayView(dayViewQuery());
      expect(view.items.map((item) => item.id)).toEqual(['md-b', 'md-a']);
      expect(view.items[0]).toMatchObject({
        taskId: 'day-b',
        isAutoIncluded: false,
        hasDescription: false,
        tags: [],
        subtaskTotal: 0,
        subtaskDone: 0,
        hubProjectIds: [],
        projectPhases: [],
        estimatedDuration: null,
      });

      await expect(persistence.myDay.remove({
        itemId: 'md-a',
        taskId: null,
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        exclusionId: 'mde-a',
        signal: SIGNAL,
      })).resolves.toEqual({ taskId: 'day-a' });
      await expect(harness.countMyDayExclusions('day-a', PLANNING_DATE)).resolves.toBe(1);
      await expect(harness.countPlanningSignals('day-a', 'my_day_withdrawn')).resolves.toBe(1);

      // Removing an absent task still resolves the requested identity so the
      // route keeps its Microsoft To Do write-back behavior.
      await expect(persistence.myDay.remove({
        itemId: null,
        taskId: 'day-c',
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        exclusionId: 'mde-c',
        signal: SIGNAL,
      })).resolves.toEqual({ taskId: 'day-c' });
      await expect(harness.countMyDayExclusions('day-c', PLANNING_DATE)).resolves.toBe(0);
    });

    it('auto-includes the day\'s completed tasks exactly once and honours exclusions', async () => {
      await harness.seedTasks([
        { id: 'auto-done', status: 'done', completedAt: '2026-09-05T15:00:00.000Z' },
        { id: 'auto-other-day', status: 'done', completedAt: '2026-09-04T15:00:00.000Z' },
        { id: 'auto-open', status: 'todo' },
        { id: 'auto-excluded', status: 'done', completedAt: '2026-09-05T16:00:00.000Z' },
      ]);
      await persistence.myDay.remove({
        itemId: null,
        taskId: 'auto-excluded',
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        exclusionId: 'mde-excluded',
        signal: SIGNAL,
      });
      // No row existed, so the exclusion must be recorded through an explicit add/remove.
      await persistence.myDay.add({
        id: 'md-excluded',
        taskId: 'auto-excluded',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      });
      await persistence.myDay.remove({
        itemId: 'md-excluded',
        taskId: null,
        date: PLANNING_DATE,
        removedAt: PLANNING_NOW,
        exclusionId: 'mde-excluded-2',
        signal: SIGNAL,
      });

      const bounds = {
        date: PLANNING_DATE,
        dayStart: '2026-09-05T00:00:00.000Z',
        nextDayStart: '2026-09-06T00:00:00.000Z',
      };
      await expect(persistence.myDay.includeCompletedTasks(bounds))
        .resolves.toEqual({ outcome: 'applied', inserted: 1 });
      await expect(persistence.myDay.includeCompletedTasks(bounds))
        .resolves.toEqual({ outcome: 'noop' });

      const view = await persistence.myDay.dayView(dayViewQuery());
      expect(view.items.map((item) => item.taskId)).toEqual(['auto-done']);
      expect(view.items[0]).toMatchObject({
        isAutoIncluded: true,
        addedAt: '2026-09-05T15:00:00.000Z',
        status: 'done',
      });
    });

    it('projects bounded My Day suggestion groups without already-planned tasks', async () => {
      await harness.seedTasks([
        { id: 'planned', status: 'todo' },
        { id: 'overdue', status: 'todo', dueDate: '2026-09-01' },
        { id: 'due-today', status: 'todo', dueDate: PLANNING_DATE },
        { id: 'due-week', status: 'todo', dueDate: '2026-09-09' },
        { id: 'next', status: 'todo', planningHorizon: 'next' },
        { id: 'high', status: 'todo', priority: 'high' },
        { id: 'pushed', status: 'todo', pushCount: 4 },
        { id: 'hidden', status: 'todo', localDisposition: 'handled' },
        { id: 'child', status: 'todo', parentId: 'planned', depth: 1 },
      ]);
      await persistence.myDay.add({
        id: 'md-planned',
        taskId: 'planned',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      });

      const view = await persistence.myDay.dayView(dayViewQuery());
      const ids = (group: keyof typeof view.suggestions) =>
        view.suggestions[group].map((task) => task.id).sort();

      expect(ids('overdue')).toEqual(['overdue']);
      expect(ids('dueToday')).toEqual(['due-today']);
      expect(ids('dueThisWeek')).toEqual(['due-week']);
      expect(ids('planningNext')).toEqual(['next']);
      expect(ids('highPriority')).toEqual(['high']);
      expect(ids('repeatedlyRescheduled')).toEqual(['pushed']);
      // Already-planned, hidden-disposition and subtask rows never surface.
      for (const group of Object.keys(view.suggestions) as Array<keyof typeof view.suggestions>) {
        expect(ids(group)).not.toContain('planned');
        expect(ids(group)).not.toContain('hidden');
        expect(ids(group)).not.toContain('child');
      }
    });

    it('serializes weekly one-thing selection and stamps completion once', async () => {
      await harness.seedTasks([
        { id: 'ot-task', title: 'Ship it', status: 'in_progress' },
        { id: 'ot-other', title: 'Other' },
      ]);

      await expect(persistence.oneThing.getForWeek(PLANNING_WEEK_MONDAY)).resolves.toBeNull();
      await expect(persistence.oneThing.selectManual({
        id: 'ot-missing',
        taskId: 'nope',
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })).resolves.toEqual({ outcome: 'task-not-found' });

      await expect(persistence.oneThing.selectAuto({
        id: 'ot-auto',
        taskId: 'ot-task',
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })).resolves.toEqual({ outcome: 'selected' });
      await expect(persistence.oneThing.selectAuto({
        id: 'ot-auto-2',
        taskId: 'ot-other',
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })).resolves.toEqual({ outcome: 'existing' });

      await expect(persistence.oneThing.getForWeek(PLANNING_WEEK_MONDAY)).resolves.toMatchObject({
        id: 'ot-auto',
        taskId: 'ot-task',
        isManualOverride: false,
        completedAt: null,
        title: 'Ship it',
        status: 'in_progress',
      });

      await expect(persistence.oneThing.selectManual({
        id: 'ot-manual',
        taskId: 'ot-other',
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })).resolves.toEqual({ outcome: 'selected' });
      await expect(persistence.oneThing.getForWeek(PLANNING_WEEK_MONDAY)).resolves.toMatchObject({
        id: 'ot-manual',
        isManualOverride: true,
      });

      await persistence.oneThing.markCompleted({
        id: 'ot-manual',
        completedAt: '2026-09-05T20:00:00.000Z',
      });
      await persistence.oneThing.markCompleted({
        id: 'ot-manual',
        completedAt: '2026-09-06T20:00:00.000Z',
      });
      await expect(persistence.oneThing.getForWeek(PLANNING_WEEK_MONDAY)).resolves.toMatchObject({
        completedAt: '2026-09-05T20:00:00.000Z',
      });

      await persistence.oneThing.clearForWeek(PLANNING_WEEK_MONDAY);
      await expect(persistence.oneThing.getForWeek(PLANNING_WEEK_MONDAY)).resolves.toBeNull();
    });

    it('scores one-thing candidates from bounded top-level open tasks', async () => {
      await harness.seedTasks([
        { id: 'cand-open' },
        { id: 'cand-done', status: 'done', completedAt: PLANNING_NOW },
        { id: 'cand-cancelled', status: 'cancelled' },
        { id: 'cand-child', parentId: 'cand-open', depth: 1 },
      ]);
      await persistence.myDay.add({
        id: 'md-cand',
        taskId: 'cand-open',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      });

      await expect(persistence.oneThing.listCandidates(200))
        .resolves.toMatchObject([{ id: 'cand-open', depth: 0 }]);
      await expect(persistence.oneThing.listMyDayTaskIds(PLANNING_DATE))
        .resolves.toEqual(['cand-open']);
      await expect(persistence.oneThing.subtaskProgress('cand-open'))
        .resolves.toEqual({ total: 1, done: 0 });
    });

    it('summarizes the mobile dashboard and navigation counts from the same rows', async () => {
      await harness.seedTasks([
        { id: 'nav-open', status: 'todo', dueDate: '2026-09-01', priority: 'none' },
        { id: 'nav-progress', status: 'in_progress', priority: 'high' },
        { id: 'nav-done', status: 'done', completedAt: '2026-09-05T15:00:00.000Z' },
        { id: 'nav-child', status: 'todo', parentId: 'nav-open', depth: 1 },
      ]);
      await persistence.myDay.add({
        id: 'md-nav',
        taskId: 'nav-open',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      });

      await expect(persistence.dashboard.snapshot({
        overdueBefore: PLANNING_DATE,
        queueOverdueBefore: PLANNING_DATE,
        completedFrom: '2026-09-05T00:00:00.000Z',
        completedTo: '2026-09-06T00:00:00.000Z',
        recentActivityLimit: 5,
      })).resolves.toMatchObject({
        totalOpen: 2,
        completedToday: 1,
        inProgress: 1,
        overdue: 1,
        queues: { triage: 0, sort: 1, overdue: 1 },
        recentActivity: [{ id: 'nav-done', title: 'nav-done' }],
      });

      await expect(persistence.navigation.counts({
        date: PLANNING_DATE,
        now: PLANNING_NOW,
      })).resolves.toEqual({
        myDay: 1,
        triage: 0,
        quickSort: 1,
        reconciliation: 0,
        overdue: 1,
        notifications: {
          attention: 0, unread: 0, urgent: 0, actionNeeded: 0, headsUp: 0, fyi: 0,
        },
      });
    });

    it('reconciles My Day against remote identity without duplicating rows', async () => {
      await harness.seedTasks([
        {
          id: 'sync-a',
          sourceId: 'list-1:a',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          dueDate: PLANNING_DATE,
        },
        {
          id: 'sync-b',
          sourceId: 'list-1:b',
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'todo-1',
          status: 'done',
          completedAt: PLANNING_NOW,
        },
        {
          id: 'sync-other',
          sourceId: 'list-2:c',
          connectorType: 'github-issues',
          connectorInstanceId: 'gh-1',
        },
      ]);

      await expect(persistence.myDaySync.findTasksBySourceIds({
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        sourceIds: ['list-1:a', 'list-1:b', 'list-2:c'],
      })).resolves.toMatchObject([
        { id: 'sync-a', sourceId: 'list-1:a', status: 'todo' },
        { id: 'sync-b', sourceId: 'list-1:b', status: 'done' },
      ]);

      await expect(persistence.myDaySync.listOpenDueTodayTaskIds({
        connectorType: 'microsoft-todo',
        date: PLANNING_DATE,
      })).resolves.toEqual(['sync-a']);
      await expect(persistence.myDaySync.listOpenDueTodayTasks({
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'todo-1',
        date: PLANNING_DATE,
      })).resolves.toMatchObject([{ id: 'sync-a', sourceId: 'list-1:a' }]);

      const rows = [{
        id: 'md-sync-a',
        taskId: 'sync-a',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        isAutoIncluded: true,
      }];
      await expect(persistence.myDaySync.applyReconciliation({
        date: PLANNING_DATE,
        committedRows: rows,
        autoIncludedRows: [],
        removeItemIds: [],
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ added: 1, dueTodayAdded: 0, removed: 0 });
      await expect(persistence.myDaySync.applyReconciliation({
        date: PLANNING_DATE,
        committedRows: [{ ...rows[0], id: 'md-sync-a-again' }],
        autoIncludedRows: [],
        removeItemIds: [],
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ added: 0, dueTodayAdded: 0, removed: 0 });
      await expect(harness.countPlanningSignals('sync-a', 'my_day_committed'))
        .resolves.toBe(1);
      await expect(persistence.myDaySync.listMyDayTaskIds(PLANNING_DATE))
        .resolves.toEqual(['sync-a']);

      await expect(persistence.myDaySync.createTaskFromRemote({
        id: 'sync-created',
        sourceId: 'list-1:new',
        connectorInstanceId: 'todo-1',
        title: 'Fresh from substrate',
        priority: 'high',
        dueDate: PLANNING_DATE,
        createdAt: PLANNING_NOW,
        updatedAt: PLANNING_NOW,
        lastSyncedAt: PLANNING_NOW,
        sourceListId: 'list-1',
      })).resolves.toMatchObject({
        created: true,
        task: { id: 'sync-created', sourceId: 'list-1:new', status: 'todo' },
      });
      await expect(persistence.myDaySync.createTaskFromRemote({
        id: 'sync-created-again',
        sourceId: 'list-1:new',
        connectorInstanceId: 'todo-1',
        title: 'Duplicate',
        priority: 'none',
        dueDate: null,
        createdAt: PLANNING_NOW,
        updatedAt: PLANNING_NOW,
        lastSyncedAt: PLANNING_NOW,
        sourceListId: 'list-1',
      })).resolves.toMatchObject({ created: false, task: { id: 'sync-created' } });

      await expect(persistence.myDaySync.resolveTaskIdsBySourceIds({
        connectorInstanceId: 'todo-1',
        sourceIds: ['list-1:a', 'list-1:missing'],
      })).resolves.toEqual([{ id: 'sync-a', sourceId: 'list-1:a' }]);

      const snapshot = await persistence.myDaySync.snapshot({
        date: PLANNING_DATE,
        connectorInstanceId: 'todo-1',
        archivedDuplicateReasonPrefix: 'Duplicate open Microsoft To Do recurrence',
      });
      expect(snapshot.localItems).toMatchObject([
        { id: 'md-sync-a', taskId: 'sync-a', sourceId: 'list-1:a', isAutoIncluded: true },
      ]);
      expect(snapshot.excludedTaskIds).toEqual([]);
      expect(snapshot.archivedDuplicateSourceIds).toEqual([]);
      expect(snapshot.recurringHistory.map((row) => row.title).sort())
        .toEqual(['Fresh from substrate', 'sync-a', 'sync-b']);

      await expect(persistence.myDaySync.listCompletedMyDaySiblings({
        connectorInstanceId: 'todo-1',
        date: PLANNING_DATE,
      })).resolves.toEqual([]);

      await expect(persistence.myDaySync.applyReconciliation({
        date: PLANNING_DATE,
        committedRows: [],
        autoIncludedRows: [],
        removeItemIds: ['md-sync-a', 'missing'],
        removedAt: PLANNING_NOW,
        signal: SIGNAL,
      })).resolves.toEqual({ added: 0, dueTodayAdded: 0, removed: 1 });
      await expect(harness.countPlanningSignals('sync-a', 'my_day_withdrawn'))
        .resolves.toBe(1);
    });
  });
}

export function dayViewQuery() {
  return {
    date: PLANNING_DATE,
    yesterday: '2026-09-04',
    dueThrough: '2026-09-12',
    activitySince: '2026-09-03',
    frictionSince: '2026-06-07T00:00:00.000Z',
    frictionEventTypes: [
      'due_date_pushed',
      'my_day_missed',
      'focus_missed',
      'snooze_extended',
      'scheduled_block_elapsed',
      'became_overdue',
    ] as const,
    carriedForwardMinimum: 3,
    suggestionLimit: 200,
  };
}
