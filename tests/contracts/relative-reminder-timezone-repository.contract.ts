import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  RelativeReminderRecomputeResult,
  RelativeReminderRecomputeUpdates,
  RelativeReminderTaskSnapshot,
  RelativeReminderTimezoneRepository,
} from '@/db/persistence/relative-reminder-timezone';

export interface RelativeReminderTimezoneHarness {
  repository: RelativeReminderTimezoneRepository;
  /** Inserts a `tasks` row with every column `applyTimezoneRecompute` filters/reads. */
  seedTask(input: {
    id: string;
    status?: string;
    dueDate?: string | null;
    reminderAt?: string | null;
    reminderRelative?: string | null;
    reminderDueTime?: string | null;
  }): Promise<void> | void;
  /** Reads back the current persisted row for assertions. */
  getTask(id: string): Promise<(RelativeReminderTaskSnapshot & { updatedAt: string }) | null>;
  close(): Promise<void> | void;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');
const FUTURE_REMINDER_AT = '2026-06-01T00:00:00.000Z';
const PAST_REMINDER_AT = '2025-01-01T00:00:00.000Z';

const succeed = (updates: RelativeReminderRecomputeUpdates): RelativeReminderRecomputeResult => (
  { success: true, updates }
);
const fail = (): RelativeReminderRecomputeResult => ({ success: false });

/**
 * Cross-backend behavioral contract for `RelativeReminderTimezoneRepository`
 * (see `docs/architecture/persistence-boundaries.md`, "Web/API PostgreSQL
 * parity: Layer L02"). Uses a deterministic, caller-supplied `recompute`
 * stub rather than the real `resolveRelativeReminderMutation` domain
 * function -- that function has its own dedicated unit tests
 * (`tests/unit/relative-reminder.test.ts`) and
 * `tests/api/settings-mode-route.test.ts` already proves the route wires
 * the real function through correctly. This contract instead pins the
 * *repository's* own responsibilities identically on both backends: which
 * rows are selected as candidates, atomic all-or-nothing persistence, and
 * the exact `invalidCount` semantics.
 */
export function describeRelativeReminderTimezoneContract(
  name: string,
  createHarness: () => RelativeReminderTimezoneHarness | Promise<RelativeReminderTimezoneHarness>,
): void {
  describe(`${name} relative reminder timezone repository contract`, () => {
    let harness: RelativeReminderTimezoneHarness;

    beforeEach(async () => {
      harness = await createHarness();
    });

    afterEach(async () => {
      await harness.close();
    });

    it('recomputes and persists updates plus updatedAt for every eligible candidate', async () => {
      await harness.seedTask({
        id: 'task-eligible',
        status: 'todo',
        dueDate: '2026-06-02',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      });

      const { invalidCount } = await harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: () => succeed({ reminderAt: '2026-06-01T09:00:00.000Z' }),
      });

      expect(invalidCount).toBe(0);
      const task = await harness.getTask('task-eligible');
      expect(task?.reminderAt).toBe('2026-06-01T09:00:00.000Z');
      expect(task?.updatedAt).toBe(NOW.toISOString());
    });

    it('mutates no row and reports every failure when any candidate recompute fails', async () => {
      await harness.seedTask({
        id: 'task-a',
        status: 'todo',
        dueDate: '2026-06-02',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      });
      await harness.seedTask({
        id: 'task-b',
        status: 'in_progress',
        dueDate: '2026-06-03',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '10:00',
      });

      const { invalidCount } = await harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: (task) => (task.id === 'task-b' ? fail() : succeed({ reminderAt: 'unused' })),
      });

      expect(invalidCount).toBe(1);
      const taskA = await harness.getTask('task-a');
      const taskB = await harness.getTask('task-b');
      expect(taskA?.reminderAt).toBe(FUTURE_REMINDER_AT);
      expect(taskB?.reminderAt).toBe(FUTURE_REMINDER_AT);
    });

    it('excludes tasks whose reminderAt is not strictly after now', async () => {
      await harness.seedTask({
        id: 'task-past',
        status: 'todo',
        dueDate: '2025-01-02',
        reminderAt: PAST_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      });

      let recomputeCalls = 0;
      await harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: () => {
          recomputeCalls += 1;
          return succeed({});
        },
      });

      expect(recomputeCalls).toBe(0);
    });

    it('excludes tasks whose status is neither todo nor in_progress', async () => {
      await harness.seedTask({
        id: 'task-done',
        status: 'done',
        dueDate: '2026-06-02',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      });

      let recomputeCalls = 0;
      await harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: () => {
          recomputeCalls += 1;
          return succeed({});
        },
      });

      expect(recomputeCalls).toBe(0);
    });

    it('excludes tasks missing any of reminderRelative/reminderAt/dueDate/reminderDueTime', async () => {
      await harness.seedTask({
        id: 'task-no-relative',
        status: 'todo',
        dueDate: '2026-06-02',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: null,
        reminderDueTime: '09:00',
      });
      await harness.seedTask({
        id: 'task-no-due-date',
        status: 'todo',
        dueDate: null,
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: '09:00',
      });
      await harness.seedTask({
        id: 'task-no-due-time',
        status: 'todo',
        dueDate: '2026-06-02',
        reminderAt: FUTURE_REMINDER_AT,
        reminderRelative: '1_day_before',
        reminderDueTime: null,
      });

      let recomputeCalls = 0;
      await harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: () => {
          recomputeCalls += 1;
          return succeed({});
        },
      });

      expect(recomputeCalls).toBe(0);
    });

    it('resolves invalidCount: 0 and touches no row when there are zero candidates', async () => {
      await expect(harness.repository.applyTimezoneRecompute({
        now: NOW,
        recompute: () => succeed({}),
      })).resolves.toEqual({ invalidCount: 0 });
    });
  });
}
