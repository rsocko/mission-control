import { beforeEach, describe, expect, it, vi } from 'vitest';

const cronMocks = vi.hoisted(() => ({
  callback: null as null | (() => Promise<void>),
  start: vi.fn(),
  stop: vi.fn(),
}));
const reminderMocks = vi.hoisted(() => ({
  runDueTaskReminders: vi.fn(),
}));

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn((_schedule: string, callback: () => Promise<void>) => {
      cronMocks.callback = callback;
      return { start: cronMocks.start, stop: cronMocks.stop };
    }),
  },
}));
vi.mock('@/lib/push/task-reminders', () => ({
  runDueTaskReminders: reminderMocks.runDueTaskReminders,
}));

import { TaskReminderScheduler } from '@/lib/push/task-reminder-scheduler';

const EMPTY_RESULT = {
  examined: 0,
  claimed: 0,
  fired: 0,
  cancelled: 0,
  failed: 0,
};

describe('task reminder scheduler', () => {
  beforeEach(() => {
    cronMocks.callback = null;
    cronMocks.start.mockReset();
    cronMocks.stop.mockReset();
    reminderMocks.runDueTaskReminders.mockReset();
  });

  it('coalesces a scheduled tick with an active reminder scan', async () => {
    let finishRun: ((result: typeof EMPTY_RESULT) => void) | undefined;
    reminderMocks.runDueTaskReminders.mockImplementation(() => new Promise((resolve) => {
      finishRun = resolve;
    }));
    const scheduler = new TaskReminderScheduler();

    const startup = scheduler.start();
    await vi.waitFor(() => expect(reminderMocks.runDueTaskReminders).toHaveBeenCalledTimes(1));
    const overlappingTick = cronMocks.callback?.();

    expect(reminderMocks.runDueTaskReminders).toHaveBeenCalledTimes(1);
    finishRun?.(EMPTY_RESULT);
    await Promise.all([startup, overlappingTick]);
  });

  it('allows the next tick after the active scan completes', async () => {
    reminderMocks.runDueTaskReminders.mockResolvedValue(EMPTY_RESULT);
    const scheduler = new TaskReminderScheduler();
    await scheduler.start();

    await cronMocks.callback?.();

    expect(reminderMocks.runDueTaskReminders).toHaveBeenCalledTimes(2);
  });
});
