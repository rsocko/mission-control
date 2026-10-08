import { beforeEach, describe, expect, it } from 'vitest';
import type {
  TaskCorePersistence,
  TaskTimeActivityMutationOutcome,
} from '@/lib/tasks/core/contracts';

const START_A = '00000000-0000-4000-8000-000000000001';
const START_B = '00000000-0000-4000-8000-000000000002';
const START_C = '00000000-0000-4000-8000-000000000007';
const PAUSE = '00000000-0000-4000-8000-000000000003';
const RESUME = '00000000-0000-4000-8000-000000000004';
const COMPLETE = '00000000-0000-4000-8000-000000000005';
const CANCEL = '00000000-0000-4000-8000-000000000006';
const T0 = '2026-09-18T12:00:00.000Z';

interface Harness {
  persistence: TaskCorePersistence;
  reset(): Promise<void>;
  insertTasks(rows: Array<{
    id: string;
    title?: string;
    updatedAt?: string;
  }>): Promise<void>;
}

function activity(outcome: TaskTimeActivityMutationOutcome) {
  if (outcome.kind !== 'committed' && outcome.kind !== 'replayed') {
    throw new Error(`Expected activity outcome, received ${outcome.kind}`);
  }
  return outcome.activity;
}

export function describeTaskTimeActivityContract(
  name: string,
  createHarness: () => Promise<Harness>,
): void {
  describe(`${name} task time activity`, () => {
    let harness: Harness;

    beforeEach(async () => {
      harness = await createHarness();
      await harness.reset();
      await harness.insertTasks([
        { id: 'task-a', updatedAt: T0 },
        { id: 'task-b', updatedAt: T0 },
      ]);
    });

    it('transitions with server elapsed time and replays exact commands', async () => {
      const repository = harness.persistence.timeActivities;
      const started = await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: T0,
      });
      expect(activity(started)).toMatchObject({ state: 'running', version: 0 });
      expect((await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: '2026-09-18T12:00:03.000Z',
      })).kind).toBe('replayed');

      expect(await repository.start({
        taskId: 'task-b',
        commandId: START_B,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: '2026-09-18T12:00:05.000Z',
      })).toMatchObject({ kind: 'conflict', reason: 'active-timer', activeTaskId: 'task-a' });

      const paused = await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: PAUSE,
        action: 'pause',
        expectedVersion: 0,
        serverNow: '2026-09-18T12:00:10.000Z',
      });
      expect(activity(paused)).toMatchObject({ state: 'paused', elapsedSeconds: 10, version: 1 });
      expect((await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: PAUSE,
        action: 'pause',
        expectedVersion: 0,
        serverNow: '2026-09-18T12:00:12.000Z',
      })).kind).toBe('replayed');

      const resumed = await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: RESUME,
        action: 'resume',
        expectedVersion: 1,
        serverNow: '2026-09-18T12:00:20.000Z',
      });
      expect(activity(resumed)).toMatchObject({ state: 'running', version: 2 });
      const completed = await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: COMPLETE,
        action: 'complete',
        expectedVersion: 2,
        serverNow: '2026-09-18T12:00:25.000Z',
      });
      expect(activity(completed)).toMatchObject({
        state: 'completed',
        elapsedSeconds: 15,
        version: 3,
      });
      expect(await repository.hasDurableTimeActivity('task-a')).toBe(true);
    });

    it('counts cancelled activity only after server-recorded elapsed time', async () => {
      const repository = harness.persistence.timeActivities;
      await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: T0,
      });
      await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: CANCEL,
        action: 'cancel',
        expectedVersion: 0,
        serverNow: T0,
      });
      expect(await repository.hasDurableTimeActivity('task-a')).toBe(false);
    });

    it('completes elapsed timers before pausing or starting another task', async () => {
      const repository = harness.persistence.timeActivities;
      await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'deadline',
        targetSeconds: 5,
        serverNow: T0,
      });
      expect((await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'deadline',
        targetSeconds: 4,
        serverNow: '2026-09-18T12:00:01.000Z',
      })).kind).toBe('replayed');
      const paused = await repository.transition({
        taskId: 'task-a',
        activityId: START_A,
        commandId: PAUSE,
        action: 'pause',
        expectedVersion: 0,
        serverNow: '2026-09-18T12:00:05.000Z',
      });
      expect(activity(paused)).toMatchObject({ state: 'completed', elapsedSeconds: 5 });
      await repository.start({
        taskId: 'task-b',
        commandId: START_B,
        mode: 'focus',
        targetSeconds: 5,
        serverNow: '2026-09-18T12:00:06.000Z',
      });
      const next = await repository.start({
        taskId: 'task-a',
        commandId: START_C,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: '2026-09-18T12:00:12.000Z',
      });
      expect(activity(next)).toMatchObject({ taskId: 'task-a', state: 'running' });
      expect((await repository.getTaskActivity(
        'task-b',
        '2026-09-18T12:00:12.000Z',
      )).activity).toMatchObject({ state: 'completed', elapsedSeconds: 5 });
    });

    it('cancels but retains elapsed activity when a task is soft deleted', async () => {
      const repository = harness.persistence.timeActivities;
      await repository.start({
        taskId: 'task-a',
        commandId: START_A,
        mode: 'focus',
        targetSeconds: 60,
        serverNow: T0,
      });
      const removed = await harness.persistence.removals.applyTaskRemoval({
        taskId: 'task-a',
        expectedUpdatedAt: T0,
        mode: 'local-delete',
        now: '2026-09-18T12:00:07.000Z',
      });
      expect(removed.kind).toBe('committed');
      expect(await repository.hasDurableTimeActivity('task-a')).toBe(true);
      expect(await repository.getTaskActivity(
        'task-a',
        '2026-09-18T12:00:08.000Z',
      )).toEqual({ taskExists: false, activity: null });
    });
  });
}
