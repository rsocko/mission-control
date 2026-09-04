import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AnalyticsPersistence } from '@/db/persistence/analytics';

/**
 * One behaviour suite for both analytics backends (L17).
 *
 * Beyond the ordinary read shapes it pins the four translations where SQLite
 * and PostgreSQL would otherwise diverge: `julianday()` instant comparison
 * (malformed, `NULL`, offsetless, date-only, sub-second, and offset-bearing
 * text), ASCII-only case folding, the Drizzle `notificationNeedsAttention()`
 * predicate, and `jsonb` cadence normalization — plus every ordering
 * tiebreaker this layer defines and the numeric type of every count.
 *
 * Rows are described once here and written through the harness' generic
 * `insert`, so both drivers seed byte-identical fixtures.
 *
 * Every fixture instant sits in the past. SQLite carries production triggers
 * that append a `baseline` history row on task insert and a `project_added`
 * row on membership insert, stamped with the wall clock; PostgreSQL has no
 * such triggers. Because those stamps always fall outside the fixture ranges
 * asserted below, both backends return exactly the seeded rows, and the SQLite
 * append-only guard on `task_history_events` is never disturbed.
 */

export interface AnalyticsHarness {
  repository: AnalyticsPersistence;
  insert(table: string, row: Record<string, unknown>): Promise<void>;
  close(): void | Promise<void>;
}

const NOW = '2026-03-10T12:00:00.000Z';

function task(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source_id: id,
    connector_type: 'local',
    connector_instance_id: 'connector-live',
    title: `Task ${id}`,
    created_at: NOW,
    updated_at: NOW,
    last_synced_at: NOW,
    ...overrides,
  };
}

function notification(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    source_id: id,
    connector_type: 'document-intelligence',
    connector_instance_id: 'connector-live',
    title: `Notification ${id}`,
    received_at: NOW,
    sort_at: NOW,
    disposition: 'inbox',
    source_state: 'active',
    read_state: 'unread',
    level: 'fyi',
    category: 'document',
    ...overrides,
  };
}

function historyEvent(overrides: Record<string, unknown>) {
  return {
    task_id: 'task-1',
    event_type: 'status_changed',
    occurred_at: NOW,
    recorded_at: NOW,
    provenance: 'local',
    ...overrides,
  };
}

export function describeAnalyticsRepositoriesContract(
  name: string,
  createHarness: () => AnalyticsHarness | Promise<AnalyticsHarness>,
): void {
  describe(`${name} analytics repositories contract`, () => {
    let harness: AnalyticsHarness;
    const insert = (table: string, row: Record<string, unknown>) => harness.insert(table, row);

    beforeEach(async () => {
      harness = await createHarness();
      await insert('connector_configs', {
        id: 'connector-live',
        type: 'local',
        name: 'Live',
        capabilities: '{}',
        created_at: NOW,
        updated_at: NOW,
      });
    });

    afterEach(async () => {
      await harness.close();
    });

    // ─── KPI counts ───────────────────────────────────────────────────────

    it('counts open work by status, due window, priority, assignee, and source', async () => {
      await insert('tasks', task('open-1', { status: 'todo', due_date: '2026-03-01', priority: 'high' }));
      await insert('tasks', task('open-2', { status: 'in_progress', due_date: '2026-03-12', assignee: 'me' }));
      await insert('tasks', task('done-1', { status: 'done', due_date: '2026-03-01' }));
      await insert('tasks', task('cancelled-1', { status: 'cancelled', due_date: '2026-03-01' }));
      await insert('tasks', task('doc-1', { status: 'todo', connector_type: 'document-intelligence' }));

      const kpis = harness.repository.kpis;
      expect(await kpis.countOpenTasks()).toBe(3);
      expect(await kpis.countOpenTasksDueBefore('2026-03-10')).toBe(1);
      expect(await kpis.countOpenTasksDueBetween({ from: '2026-03-10', to: '2026-03-20' })).toBe(1);
      expect(await kpis.countOpenTasksWithPriorities(['high', 'critical'])).toBe(1);
      expect(await kpis.countOpenTasksWithAssignee()).toBe(1);
      expect(await kpis.countOpenTasksByConnectorType('document-intelligence')).toBe(1);
      expect(typeof await kpis.countOpenTasks()).toBe('number');
    });

    it('scopes My Day and Focus reads to the requested day', async () => {
      await insert('tasks', task('task-1', { status: 'done' }));
      await insert('tasks', task('task-2', { status: 'todo' }));
      await insert('my_day_items', { id: 'md-1', task_id: 'task-2', date: '2026-03-10', added_at: NOW });
      await insert('my_day_items', { id: 'md-2', task_id: 'task-1', date: '2026-03-09', added_at: NOW });
      await insert('focus_items', {
        id: 'focus-1', task_id: 'task-1', scope: 'today', date: '2026-03-10', slot: 1, added_at: NOW,
      });
      await insert('focus_items', {
        id: 'focus-2', task_id: 'task-2', scope: 'today', date: '2026-03-10', slot: 2, added_at: NOW,
      });
      await insert('focus_items', {
        id: 'focus-3', task_id: 'task-2', scope: 'week', date: '2026-03-10', slot: 3, added_at: NOW,
      });

      const kpis = harness.repository.kpis;
      expect(await kpis.listMyDayTaskIds('2026-03-10')).toEqual(['task-2']);
      expect(await kpis.countOpenTasksInIds(['task-2'])).toBe(1);
      const focus = await kpis.listFocusItemStatuses('today', '2026-03-10');
      expect(focus.map((item) => item.id).sort()).toEqual(['focus-1', 'focus-2']);
      expect(focus.filter((item) => item.status === 'done')).toHaveLength(1);
    });

    it('counts triage backlog and staleness by captured text order', async () => {
      const triage = (id: string, status: string, capturedAt: string) => ({
        id,
        source_platform: 'web',
        source_id: id,
        source_url: `https://example.test/${id}`,
        title: id,
        captured_at: capturedAt,
        ingested_at: NOW,
        status,
      });
      await insert('triage_items', triage('t-old', 'pending', '2026-01-01T00:00:00.000Z'));
      await insert('triage_items', triage('t-new', 'pending', '2026-03-09T00:00:00.000Z'));
      await insert('triage_items', triage('t-done', 'actioned', '2026-01-01T00:00:00.000Z'));

      const kpis = harness.repository.kpis;
      expect(await kpis.countTriageItemsWithStatus('pending')).toBe(2);
      expect(await kpis.countTriageItemsWithStatusCapturedBefore(
        'pending',
        '2026-03-03T00:00:00.000Z',
      )).toBe(1);
    });

    // ─── Notification attention predicate ─────────────────────────────────

    it('reproduces the notificationNeedsAttention lifecycle predicate exactly', async () => {
      await insert('notifications', notification('n-plain'));
      await insert('notifications', notification('n-urgent', { level: 'urgent' }));
      await insert('notifications', notification('n-digest', { level: 'digest' }));
      await insert('notifications', notification('n-read', { read_state: 'read' }));
      await insert('notifications', notification('n-handled', { disposition: 'handled' }));
      await insert('notifications', notification('n-dead', { source_state: 'deleted' }));
      await insert('notifications', notification('n-snoozed', {
        snoozed_until: '2099-01-01T00:00:00.000Z',
      }));
      await insert('notifications', notification('n-woken', {
        snoozed_until: '2000-01-01T00:00:00.000Z',
      }));
      await insert('notifications', notification('n-medical', { category: 'medical' }));

      const kpis = harness.repository.kpis;
      // n-plain, n-urgent, n-woken, n-medical. Each of the other four is
      // excluded by exactly one clause: digest level, read state, a non-inbox
      // disposition, and a dead source state.
      expect(await kpis.countNotificationsNeedingAttention()).toBe(4);
      expect(await kpis.countNotificationsNeedingAttentionInCategory(
        'document-intelligence',
        'document',
      )).toBe(3);
      expect(await kpis.countNotificationsNeedingAttentionInCategory(
        'document-intelligence',
        'medical',
      )).toBe(1);
    });

    // ─── Instant comparison parity ────────────────────────────────────────

    it('compares stored timestamps by instant and drops unparsable text', async () => {
      await insert('tasks', task('in-utc', { status: 'done', completed_at: '2026-03-10T01:00:00.000Z' }));
      await insert('tasks', task('in-precise', { status: 'done', completed_at: '2026-03-10T01:00:00.1234567Z' }));
      await insert('tasks', task('in-offsetless', { status: 'done', completed_at: '2026-03-10T02:00:00' }));
      await insert('tasks', task('in-offset', { status: 'done', completed_at: '2026-03-10T08:00:00+05:00' }));
      await insert('tasks', task('in-dateonly', { status: 'done', completed_at: '2026-03-10' }));
      await insert('tasks', task('out-late', { status: 'done', completed_at: '2026-03-11T00:00:00.000Z' }));
      await insert('tasks', task('out-null', { status: 'done', completed_at: null }));
      await insert('tasks', task('out-garbage', { status: 'done', completed_at: 'not-a-timestamp' }));

      const range = {
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      };
      // in-utc, in-precise, in-offsetless (read as UTC), in-offset (03:00Z), in-dateonly
      expect(await harness.repository.kpis.countTasksCompletedIn(range)).toBe(5);
      expect(await harness.repository.insights.countTasksCompletedIn(range)).toBe(5);
      expect(await harness.repository.insights.listCompletedTimestampsIn(range)).toHaveLength(5);
    });

    it('treats the instant range as half open at both ends', async () => {
      await insert('tasks', task('edge-start', { status: 'done', completed_at: '2026-03-10T00:00:00.000Z' }));
      await insert('tasks', task('edge-end', { status: 'done', completed_at: '2026-03-11T00:00:00.000Z' }));

      expect(await harness.repository.kpis.countTasksCompletedIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      })).toBe(1);
    });

    /**
     * SQLite validates each date/time field against its own fixed range and
     * then computes a Julian day arithmetically, so a day or hour that is in
     * range but past the end of its month or day rolls forward rather than
     * being rejected. A backend that casts the text instead would reject these
     * and silently drop the rows from every count and list.
     */
    it('rolls overflowing calendar dates and hours forward instead of rejecting them', async () => {
      const done = (id: string, completedAt: string) => (
        insert('tasks', task(id, { status: 'done', completed_at: completedAt }))
      );
      await done('feb-31', '2026-02-31T00:00:00Z'); // 2026-02-01 + 30d -> 2026-03-03
      await done('apr-31', '2026-04-31T00:00:00Z'); // 2026-04-01 + 30d -> 2026-05-01
      await done('hour-24', '2026-03-10T24:30:00Z'); // -> 2026-03-11T00:30Z
      // Outside every field range, so excluded rather than raising.
      await done('day-32', '2026-03-32T00:00:00Z');
      await done('month-13', '2026-13-01T00:00:00Z');
      await done('hour-25', '2026-03-10T25:00:00Z');
      await done('second-60', '2026-03-10T01:00:60Z');

      const kpis = harness.repository.kpis;
      const day = (from: string, to: string) => kpis.countTasksCompletedIn({
        startInclusive: `${from}T00:00:00.000Z`,
        endExclusive: `${to}T00:00:00.000Z`,
      });

      expect(await day('2026-03-03', '2026-03-04')).toBe(1);
      expect(await day('2026-05-01', '2026-05-02')).toBe(1);
      expect(await day('2026-03-11', '2026-03-12')).toBe(1);
      // The literal, unnormalized days hold nothing.
      expect(await day('2026-02-28', '2026-03-01')).toBe(0);
      expect(await day('2026-04-30', '2026-05-01')).toBe(0);
      // Only the four out-of-domain rows name 2026-03-10, and all are dropped.
      expect(await day('2026-03-10', '2026-03-11')).toBe(0);
    });

    /**
     * SQLite's zone parser requires the colon inside a numeric offset and caps
     * the offset at 14 hours. PostgreSQL accepts `+0500` and larger offsets, so
     * a backend that casts the text would silently shift or admit rows SQLite
     * drops.
     */
    it('accepts a timestamp zone only in the exact form SQLite accepts', async () => {
      const done = (id: string, completedAt: string) => (
        insert('tasks', task(id, { status: 'done', completed_at: completedAt }))
      );
      await done('offset-colon', '2026-03-10T06:00:00+05:00'); // -> 01:00Z
      await done('zulu-lowercase', '2026-03-10 02:00:00z'); // space separator, lowercase zone
      await done('offset-spaced', '2026-03-10T08:00:00 +05:00'); // -> 03:00Z
      // Rejected by SQLite: the colon is mandatory, and the offset caps at 14h.
      await done('offset-colonless', '2026-03-10T06:00:00+0500');
      await done('offset-too-large', '2026-03-10T06:00:00+15:00');
      // `z` is a valid zone but `t` is not a valid separator.
      await done('separator-lowercase', '2026-03-10t02:00:00Z');

      expect(await harness.repository.kpis.countTasksCompletedIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      })).toBe(3);
    });

    it('excludes subtasks and checklist items from created counts', async () => {
      const createdAt = '2026-03-10T05:00:00.000Z';
      await insert('tasks', task('root', { created_at: createdAt }));
      await insert('tasks', task('sub', { created_at: createdAt, depth: 1 }));
      await insert('tasks', task('check', { created_at: createdAt, is_checklist_item: true }));

      expect(await harness.repository.insights.countTopLevelTasksCreatedIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      })).toBe(1);
    });

    // ─── Insights aggregates and ordering ─────────────────────────────────

    it('orders the source breakdown by count then connector type', async () => {
      const completedAt = '2026-03-10T01:00:00.000Z';
      for (const id of ['a1', 'a2']) {
        await insert('tasks', task(id, { status: 'done', completed_at: completedAt, connector_type: 'zeta' }));
      }
      await insert('tasks', task('b1', { status: 'done', completed_at: completedAt, connector_type: 'beta' }));
      await insert('tasks', task('c1', { status: 'done', completed_at: completedAt, connector_type: 'alpha' }));

      const rows = await harness.repository.insights.sourceBreakdownIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      });
      expect(rows).toEqual([
        { source: 'zeta', count: 2 },
        { source: 'alpha', count: 1 },
        { source: 'beta', count: 1 },
      ]);
      expect(typeof rows[0].count).toBe('number');
    });

    it('joins planning-friction signals to their top-level task', async () => {
      await insert('tasks', task('task-1', { title: 'Plan launch', due_date: '2026-03-20', source_list_name: 'Work' }));
      await insert('tasks', task('task-sub', { depth: 1 }));
      await insert('task_history_events', historyEvent({
        task_id: 'task-1',
        event_type: 'due_date_pushed',
        previous_value: '2026-03-01',
        new_value: '2026-03-06',
        occurred_at: '2026-03-10T01:00:00.000Z',
      }));
      await insert('task_history_events', historyEvent({
        task_id: 'task-sub',
        event_type: 'due_date_pushed',
        occurred_at: '2026-03-10T01:00:00.000Z',
      }));
      await insert('task_history_events', historyEvent({
        task_id: 'task-1',
        event_type: 'my_day_missed',
        occurred_at: '2026-03-20T01:00:00.000Z',
      }));

      const rows = await harness.repository.insights.listPlanningFrictionEvents(
        ['due_date_pushed', 'my_day_missed'],
        { startInclusive: '2026-03-10T00:00:00.000Z', endExclusive: '2026-03-11T00:00:00.000Z' },
      );
      expect(rows).toEqual([{
        taskId: 'task-1',
        eventType: 'due_date_pushed',
        previousValue: '2026-03-01',
        newValue: '2026-03-06',
        title: 'Plan launch',
        dueDate: '2026-03-20',
        pushCount: 0,
        sourceListName: 'Work',
      }]);
      expect(typeof rows[0].pushCount).toBe('number');
    });

    it('orders active projects by name then id and counts per-project activity', async () => {
      const project = (id: string, name: string, overrides: Record<string, unknown> = {}) => ({
        id, name, color: '#3b82f6', status: 'active', hidden: false,
        created_at: NOW, updated_at: NOW, ...overrides,
      });
      await insert('hub_projects', project('p-b', 'Same Name'));
      await insert('hub_projects', project('p-a', 'Same Name'));
      await insert('hub_projects', project('p-z', 'Archived', { status: 'archived' }));
      await insert('tasks', task('done-1', { status: 'done', completed_at: '2026-03-10T01:00:00.000Z' }));
      await insert('tasks', task('open-1', { status: 'todo' }));
      await insert('task_projects', { task_id: 'done-1', project_id: 'p-a' });
      await insert('task_projects', { task_id: 'open-1', project_id: 'p-a' });

      const insights = harness.repository.insights;
      expect((await insights.listActiveProjects()).map((row) => row.id)).toEqual(['p-a', 'p-b']);
      const range = {
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      };
      expect(await insights.countProjectTasksCompletedIn('p-a', range)).toBe(1);
      expect(await insights.countProjectOpenTasks('p-a')).toBe(1);
      // Both tasks were created inside the range and are top-level.
      expect(await insights.countProjectTopLevelTasksCreatedIn('p-a', range)).toBe(2);
    });

    it('normalizes routine cadence config and orders routines and completions', async () => {
      const routine = (id: string, overrides: Record<string, unknown> = {}) => ({
        id, name: `Routine ${id}`, cadence_type: 'specific_days', icon: null,
        cadence_config: '{"target":3,"days":[1,2,3]}', is_active: true, is_archived: false,
        created_at: NOW, updated_at: NOW, ...overrides,
      });
      await insert('routines', routine('r-b'));
      await insert('routines', routine('r-a'));
      await insert('routines', routine('r-off', { is_active: false }));
      await insert('routines', routine('r-gone', { is_archived: true }));
      const completion = (id: string, routineId: string, date: string) => ({
        id, routine_id: routineId, date, completed_at: NOW,
      });
      await insert('routine_completions', completion('c-3', 'r-b', '2026-03-09'));
      await insert('routine_completions', completion('c-1', 'r-a', '2026-03-10'));
      await insert('routine_completions', completion('c-2', 'r-a', '2026-03-09'));
      await insert('routine_completions', completion('c-0', 'r-a', '2026-03-01'));

      const insights = harness.repository.insights;
      const routines = await insights.listActiveRoutines();
      expect(routines.map((row) => row.id)).toEqual(['r-a', 'r-b']);
      expect(routines[0].cadenceConfig).toEqual({ target: 3, days: [1, 2, 3] });
      expect(routines[0].cadenceType).toBe('specific_days');

      expect(await insights.listRoutineCompletionsBetween({ from: '2026-03-09', to: '2026-03-10' }))
        .toEqual([
          { routineId: 'r-a', date: '2026-03-09' },
          { routineId: 'r-a', date: '2026-03-10' },
          { routineId: 'r-b', date: '2026-03-09' },
        ]);
      expect(await insights.listRoutineCompletionsInHalfOpenRange('2026-03-01', '2026-03-09'))
        .toEqual([{ routineId: 'r-a', date: '2026-03-01' }]);
      expect(await insights.countRoutineCompletionsByDate({ from: '2026-03-09', to: '2026-03-10' })
        .then((rows) => [...rows].sort((a, b) => a.date.localeCompare(b.date))))
        .toEqual([
          { date: '2026-03-09', count: 2 },
          { date: '2026-03-10', count: 1 },
        ]);
    });

    it('lists delivery records and filter options deterministically', async () => {
      await insert('hub_projects', {
        id: 'p-1', name: 'Visible', color: '#000000', status: 'active', hidden: false,
        created_at: NOW, updated_at: NOW,
      });
      await insert('hub_projects', {
        id: 'p-hidden', name: 'Hidden', color: '#000000', status: 'active', hidden: true,
        created_at: NOW, updated_at: NOW,
      });
      const completedAt = '2026-03-10T01:00:00.000Z';
      await insert('tasks', task('d-b', {
        status: 'done', completed_at: completedAt, connector_type: 'zeta', status_reason: 'completed',
      }));
      await insert('tasks', task('d-a', { status: 'done', completed_at: completedAt, connector_type: 'alpha' }));
      await insert('task_projects', { task_id: 'd-a', project_id: 'p-1' });
      await insert('task_projects', { task_id: 'd-a', project_id: 'p-hidden' });

      const insights = harness.repository.insights;
      const range = {
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      };
      const all = await insights.listDeliveryRecords(range, {});
      expect(all.map((row) => row.id)).toEqual(['d-a', 'd-b']);
      expect(all[1]).toMatchObject({ source: 'zeta', statusReason: 'completed', createdAt: NOW });

      expect((await insights.listDeliveryRecords(range, { source: 'alpha' })).map((r) => r.id))
        .toEqual(['d-a']);
      // The membership join must not duplicate a task in two projects.
      expect((await insights.listDeliveryRecords(range, { projectId: 'p-1' })).map((r) => r.id))
        .toEqual(['d-a']);

      expect(await insights.deliveryFilterOptions()).toEqual({
        projects: [{ value: 'p-1', label: 'Visible' }],
        sources: ['alpha', 'zeta'],
      });
    });

    it('lists open-task creation timestamps and completion spans', async () => {
      await insert('tasks', task('open-1', { status: 'todo', created_at: '2026-03-01T00:00:00.000Z' }));
      await insert('tasks', task('done-1', {
        status: 'done',
        created_at: '2026-03-08T00:00:00.000Z',
        completed_at: '2026-03-10T00:00:00.000Z',
      }));

      const insights = harness.repository.insights;
      expect(await insights.listOpenTaskCreatedTimestamps()).toEqual(['2026-03-01T00:00:00.000Z']);
      expect(await insights.listCompletionSpansIn({
        startInclusive: '2026-03-10T00:00:00.000Z',
        endExclusive: '2026-03-11T00:00:00.000Z',
      })).toEqual([{
        createdAt: '2026-03-08T00:00:00.000Z',
        completedAt: '2026-03-10T00:00:00.000Z',
      }]);
      expect(await insights.listCompletedTimestampsSince('2026-03-09T00:00:00.000Z'))
        .toEqual(['2026-03-10T00:00:00.000Z']);
    });

    // ─── Flow ─────────────────────────────────────────────────────────────

    it('projects flow inputs and orders transitions by occurrence then id', async () => {
      await insert('hub_projects', {
        id: 'p-1', name: 'Flow', color: '#3b82f6', status: 'active', hidden: false,
        created_at: NOW, updated_at: NOW,
      });
      await insert('tasks', task('task-1', { status: 'in_progress', priority: 'high' }));
      await insert('tasks', task('task-check', { is_checklist_item: true }));
      await insert('task_projects', { task_id: 'task-1', project_id: 'p-1' });
      await insert('task_history_events', historyEvent({
        task_id: 'task-1', event_type: 'baseline', occurred_at: '2026-03-02T00:00:00.000Z',
        new_value: '{"status":"todo"}',
      }));
      await insert('task_history_events', historyEvent({
        task_id: 'task-1', event_type: 'status_changed', occurred_at: '2026-03-01T00:00:00.000Z',
        previous_value: 'todo', new_value: 'in_progress',
      }));
      await insert('task_history_events', historyEvent({
        task_id: 'task-1', event_type: 'project_added', occurred_at: '2026-03-01T00:00:00.000Z',
        project_id: 'p-1',
      }));

      const flow = harness.repository.flow;
      expect((await flow.listFlowTasks()).map((row) => row.id)).toEqual(['task-1']);
      expect(await flow.listTaskProjectMemberships()).toEqual([
        { taskId: 'task-1', projectId: 'p-1' },
      ]);
      expect(await flow.listVisibleProjects()).toEqual([
        { id: 'p-1', name: 'Flow', color: '#3b82f6' },
      ]);

      const range = {
        startInclusive: '0001-01-01T00:00:00.000Z',
        endExclusive: '2026-03-10T00:00:00.000Z',
      };
      const transitions = await flow.listTaskTransitions(
        range,
        ['baseline', 'status_changed', 'project_added'],
      );
      expect(transitions.map((row) => [row.eventType, row.occurredAt])).toEqual([
        ['status_changed', '2026-03-01T00:00:00.000Z'],
        ['project_added', '2026-03-01T00:00:00.000Z'],
        ['baseline', '2026-03-02T00:00:00.000Z'],
      ]);
      expect(typeof transitions[0].id).toBe('number');
      expect(transitions[0].id).toBeLessThan(transitions[1].id);
      expect(await flow.listTaskTransitions(range, [])).toEqual([]);
    });

    // ─── Tag insights ─────────────────────────────────────────────────────

    it('narrows synthetic tag candidates with ASCII-only folding', async () => {
      const tag = (id: string, name: string) => ({
        id, name, slug: id, type: 'hub', created_at: NOW, color: null,
      });
      await insert('tags', tag('t-priority', '  PRIORITY:High  '));
      await insert('tags', tag('t-p1', 'P1'));
      await insert('tags', tag('t-effort', 'Effort:3'));
      await insert('tags', tag('t-mc', 'MC:internal'));
      await insert('tags', tag('t-shirt', 'T-Shirt:L'));
      await insert('tags', tag('t-plain', 'planning'));
      // Non-ASCII uppercase must NOT fold, exactly as SQLite's lower() behaves.
      await insert('tags', tag('t-unicode', 'PRİORITY'));

      const candidates = await harness.repository.tagInsights.listSyntheticTagCandidates();
      expect(candidates.map((row) => row.id).sort()).toEqual([
        't-effort', 't-mc', 't-p1', 't-priority', 't-shirt',
      ]);
    });

    it('bounds tagged tasks, ranks top tags, and orders tag links', async () => {
      for (const id of ['task-a', 'task-b', 'task-c']) await insert('tasks', task(id));
      const tag = (id: string, name: string) => ({
        id, name, slug: id, type: 'hub', created_at: NOW, color: '#3b82f6',
      });
      await insert('tags', tag('tag-z', 'Zeta'));
      await insert('tags', tag('tag-a', 'Alpha'));
      await insert('tags', tag('tag-synth', 'priority:high'));
      for (const taskId of ['task-a', 'task-b']) {
        await insert('task_tags', { task_id: taskId, tag_id: 'tag-z' });
      }
      await insert('task_tags', { task_id: 'task-a', tag_id: 'tag-a' });
      await insert('task_tags', { task_id: 'task-c', tag_id: 'tag-synth' });

      const tagInsights = harness.repository.tagInsights;
      // Excluding the synthetic tag drops task-c, which carries only that tag.
      const bounded = await tagInsights.listBoundedTaggedTasks(['tag-synth'], 10);
      expect(bounded.map((row) => row.id)).toEqual(['task-a', 'task-b']);
      expect(bounded[0]).toMatchObject({ title: 'Task task-a', status: 'todo' });
      expect((await tagInsights.listBoundedTaggedTasks(['tag-synth'], 1)).map((r) => r.id))
        .toEqual(['task-a']);
      expect((await tagInsights.listBoundedTaggedTasks([], 10)).map((r) => r.id))
        .toEqual(['task-a', 'task-b', 'task-c']);

      const top = await tagInsights.listTopTags(['task-a', 'task-b'], ['tag-synth'], 10);
      expect(top).toEqual([
        { id: 'tag-z', name: 'Zeta', color: '#3b82f6', usageCount: 2 },
        { id: 'tag-a', name: 'Alpha', color: '#3b82f6', usageCount: 1 },
      ]);
      expect(typeof top[0].usageCount).toBe('number');

      expect(await tagInsights.listTaskTagLinks(['task-a', 'task-b'], ['tag-z', 'tag-a']))
        .toEqual([
          { taskId: 'task-a', tagId: 'tag-a' },
          { taskId: 'task-a', tagId: 'tag-z' },
          { taskId: 'task-b', tagId: 'tag-z' },
        ]);
    });

    // ─── Word insights ────────────────────────────────────────────────────

    it('excludes soft-deleted connectors and bounds ranked relationships', async () => {
      await insert('connector_configs', {
        id: 'connector-dead', type: 'local', name: 'Dead', capabilities: '{}',
        created_at: NOW, updated_at: NOW, deleted_at: NOW,
      });
      await insert('tasks', task('task-a', { description: 'Alpha notes', source_list_name: 'Inbox', source_list_id: 'list-1' }));
      await insert('tasks', task('task-b'));
      await insert('tasks', task('task-dead', { connector_instance_id: 'connector-dead' }));
      const tag = (id: string, name: string) => ({
        id, name, slug: id, type: 'hub', created_at: NOW, color: null,
      });
      await insert('tags', tag('tag-c', 'Carol'));
      await insert('tags', tag('tag-a', 'Alice'));
      await insert('tags', tag('tag-b', 'Bob'));
      for (const tagId of ['tag-a', 'tag-b', 'tag-c']) {
        await insert('task_tags', { task_id: 'task-a', tag_id: tagId });
      }
      await insert('hub_projects', {
        id: 'p-1', name: 'Gateway', color: '#000000', status: 'active', hidden: false,
        created_at: NOW, updated_at: NOW,
      });
      await insert('task_projects', { task_id: 'task-a', project_id: 'p-1' });
      await insert('project_phases', {
        id: 'phase-1', project_id: 'p-1', name: 'Rollout', created_at: NOW, updated_at: NOW,
      });
      await insert('project_phase_items', {
        id: 'item-1', phase_id: 'phase-1', task_id: 'task-a', created_at: NOW,
      });

      const wordInsights = harness.repository.wordInsights;
      const tasks = await wordInsights.listTasksWithLiveConnector(10);
      expect(tasks.map((row) => row.id)).toEqual(['task-a', 'task-b']);
      expect(tasks[0]).toMatchObject({
        description: 'Alpha notes',
        sourceListId: 'list-1',
        sourceListName: 'Inbox',
        status: 'todo',
      });
      expect((await wordInsights.listTasksWithLiveConnector(1)).map((r) => r.id)).toEqual(['task-a']);

      // Per-task rank cap of 2 keeps the two alphabetically-first tags.
      expect(await wordInsights.listRankedTaskTags(['task-a'], 2, 10)).toEqual([
        { taskId: 'task-a', id: 'tag-a', name: 'Alice' },
        { taskId: 'task-a', id: 'tag-b', name: 'Bob' },
      ]);
      expect(await wordInsights.listRankedTaskProjects(['task-a'], 2, 10)).toEqual([
        { taskId: 'task-a', id: 'p-1', name: 'Gateway' },
      ]);
      expect(await wordInsights.listRankedTaskPhases(['task-a'], 2, 10)).toEqual([
        { taskId: 'task-a', id: 'phase-1', name: 'Rollout' },
      ]);
      expect(await wordInsights.listRankedTaskTags(['task-a'], 2, 1)).toHaveLength(1);
    });
  });
}
