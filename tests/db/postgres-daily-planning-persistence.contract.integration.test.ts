import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { DailyPlanningPersistence } from '@/db/persistence/daily-planning';
import {
  describeDailyPlanningPersistenceContract,
  PLANNING_DATE,
  PLANNING_NOW,
  PLANNING_WEEK_MONDAY,
  type DailyPlanningContractHarness,
  type DailyPlanningTaskSeed,
} from '../contracts/daily-planning-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const SIGNAL = { provenance: 'contract', metadata: { origin: 'explicit-local' } };

describe.skipIf(!connectionString)('PostgreSQL daily-planning adapter', () => {
  let pool: Pool;
  let persistence: DailyPlanningPersistence;
  let harness: DailyPlanningContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresDailyPlanningPersistence }] = await Promise.all([
      import('pg'),
      import('@/db/postgres/repositories/daily-planning-repository'),
    ]);
    pool = new Pool({ connectionString, max: 16 });
    persistence = createPostgresDailyPlanningPersistence(pool);
    harness = {
      persistence,
      async reset() {
        await pool.query(`
          DELETE FROM my_day_items;
          DELETE FROM my_day_exclusions;
          DELETE FROM focus_items;
          DELETE FROM weekly_one_thing;
          DELETE FROM energy_checkins;
          DELETE FROM task_schedules;
          DELETE FROM task_history_events;
          DELETE FROM task_tags;
          DELETE FROM task_projects;
          DELETE FROM tasks;
          DELETE FROM triage_items;
          DELETE FROM notifications;
          DELETE FROM connector_configs;
        `);
      },
      async seedTasks(tasks: readonly DailyPlanningTaskSeed[]) {
        for (const task of tasks) {
          await pool.query(`
            INSERT INTO tasks (
              id, source_id, connector_type, connector_instance_id, title, description,
              status, local_disposition, priority, planning_horizon, due_date, push_count,
              created_at, updated_at, completed_at, parent_id, depth, is_checklist_item,
              source_list_id, source_list_name, assignee, micro_status, status_reason,
              metadata, sync_status, last_synced_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17,
              FALSE, $18, $19, NULL, $20, NULL, '{}'::jsonb, 'synced', $14
            )
          `, [
            task.id,
            task.sourceId ?? `source-${task.id}`,
            task.connectorType ?? 'local',
            task.connectorInstanceId ?? 'local',
            task.title ?? task.id,
            task.description ?? null,
            task.status ?? 'todo',
            task.localDisposition ?? 'active',
            task.priority ?? 'none',
            task.planningHorizon ?? null,
            task.dueDate ?? null,
            task.pushCount ?? 0,
            task.createdAt ?? '2026-09-04T12:00:00.000Z',
            task.updatedAt ?? '2026-09-04T12:00:00.000Z',
            task.completedAt ?? null,
            task.parentId ?? null,
            task.depth ?? 0,
            task.sourceListId ?? null,
            task.sourceListName ?? null,
            task.microStatus ?? null,
          ]);
        }
      },
      async countPlanningSignals(taskId, eventType) {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM task_history_events
           WHERE task_id = $1 AND event_type = $2`,
          [taskId, eventType],
        );
        return Number(rows[0]?.count ?? 0);
      },
      async countMyDayExclusions(taskId, date) {
        const { rows } = await pool.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM my_day_exclusions
           WHERE task_id = $1 AND date = $2`,
          [taskId, date],
        );
        return Number(rows[0]?.count ?? 0);
      },
    };
  });

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeDailyPlanningPersistenceContract('PostgreSQL', () => harness);

  it('keeps one energy row under overlapping replacements', async () => {
    await harness.reset();

    await Promise.all(Array.from({ length: 6 }, (_, index) => (
      persistence.energy.replaceForDate({
        id: `race-energy-${index}`,
        date: PLANNING_DATE,
        level: index % 2 === 0 ? 'low' : 'high',
        note: null,
        createdAt: PLANNING_NOW,
      })
    )));

    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM energy_checkins WHERE date = $1',
      [PLANNING_DATE],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('allocates each focus slot exactly once under overlapping writers', async () => {
    await harness.reset();
    await harness.seedTasks(
      Array.from({ length: 8 }, (_, index) => ({ id: `race-focus-${index}` })),
    );

    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => (
      persistence.focus.add({
        id: `race-focus-item-${index}`,
        taskId: `race-focus-${index}`,
        scope: 'today',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        isAiSuggested: false,
        maxSlots: 3,
        signal: SIGNAL,
      })
    )));

    const added = results.filter((result) => result.outcome === 'added');
    expect(added).toHaveLength(3);
    expect(added.map((result) => (result as { slot: number }).slot).sort())
      .toEqual([1, 2, 3]);
    expect(results.filter((result) => result.outcome === 'full')).toHaveLength(5);
  });

  it('never duplicates a My Day task or an order under overlapping writers', async () => {
    await harness.reset();
    await harness.seedTasks(
      Array.from({ length: 6 }, (_, index) => ({ id: `race-day-${index}` })),
    );

    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, index) => persistence.myDay.add({
        id: `race-md-${index}`,
        taskId: `race-day-${index}`,
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      })),
      ...Array.from({ length: 4 }, (_, index) => persistence.myDay.add({
        id: `race-md-dup-${index}`,
        taskId: 'race-day-0',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      })),
    ]);

    expect(results.filter((result) => result.outcome === 'added')).toHaveLength(6);
    const { rows } = await pool.query<{ order: number }>(
      'SELECT "order" AS "order" FROM my_day_items WHERE date = $1 ORDER BY "order"',
      [PLANNING_DATE],
    );
    expect(rows.map((row) => Number(row.order))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('accepts exactly one stale-free reorder while a concurrent add lands', async () => {
    await harness.reset();
    await harness.seedTasks([{ id: 'order-a' }, { id: 'order-b' }, { id: 'order-c' }]);
    for (const [index, taskId] of ['order-a', 'order-b'].entries()) {
      await persistence.myDay.add({
        id: `order-md-${index}`,
        taskId,
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      });
    }

    const [reorder, add] = await Promise.all([
      persistence.myDay.replaceOrder({
        date: PLANNING_DATE,
        orderedItemIds: ['order-md-1', 'order-md-0'],
      }),
      persistence.myDay.add({
        id: 'order-md-2',
        taskId: 'order-c',
        date: PLANNING_DATE,
        addedAt: PLANNING_NOW,
        signal: SIGNAL,
      }),
    ]);

    expect(add.outcome).toBe('added');
    expect(['saved', 'stale']).toContain(reorder.outcome);
    const { rows } = await pool.query<{ id: string }>(
      'SELECT id FROM my_day_items WHERE date = $1 ORDER BY "order", id',
      [PLANNING_DATE],
    );
    expect(rows.map((row) => row.id).sort())
      .toEqual(['order-md-0', 'order-md-1', 'order-md-2']);
  });

  it('creates one weekly one-thing row under overlapping auto and manual selection', async () => {
    await harness.reset();
    await harness.seedTasks(
      Array.from({ length: 6 }, (_, index) => ({ id: `race-ot-${index}` })),
    );

    const results = await Promise.all([
      ...Array.from({ length: 4 }, (_, index) => persistence.oneThing.selectAuto({
        id: `race-ot-auto-${index}`,
        taskId: `race-ot-${index}`,
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })),
      ...Array.from({ length: 2 }, (_, index) => persistence.oneThing.selectManual({
        id: `race-ot-manual-${index}`,
        taskId: `race-ot-${index + 4}`,
        weekMonday: PLANNING_WEEK_MONDAY,
        createdAt: PLANNING_NOW,
      })),
    ]);

    expect(results.filter((result) => result.outcome === 'selected').length)
      .toBeGreaterThanOrEqual(1);
    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM weekly_one_thing WHERE week_monday = $1',
      [PLANNING_WEEK_MONDAY],
    );
    expect(Number(rows[0].count)).toBe(1);
  });

  it('inserts each auto-included completion once under overlapping readers', async () => {
    await harness.reset();
    await harness.seedTasks([
      { id: 'auto-race-a', status: 'done', completedAt: '2026-09-05T15:00:00.000Z' },
      { id: 'auto-race-b', status: 'done', completedAt: '2026-09-05T16:00:00.000Z' },
    ]);

    const bounds = {
      date: PLANNING_DATE,
      dayStart: '2026-09-05T00:00:00.000Z',
      nextDayStart: '2026-09-06T00:00:00.000Z',
    };
    const results = await Promise.all(
      Array.from({ length: 6 }, () => persistence.myDay.includeCompletedTasks(bounds)),
    );
    expect(results.every((result) => result.outcome !== 'skipped-write-contention')).toBe(true);

    const { rows } = await pool.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM my_day_items WHERE date = $1',
      [PLANNING_DATE],
    );
    expect(Number(rows[0].count)).toBe(2);
  });
});
