import { describe, expect, it, vi } from 'vitest';
import type {
  ClaimedTaskReminder,
  TaskReminderRepository,
} from '@/db/persistence/task-reminders';
import {
  calculateTaskReminderRetryDelayMs,
  runDueTaskReminders,
} from '@/lib/push/task-reminders';

const delivery = {
  currentHour: 12,
  webPushConfigured: false,
  apns: null,
  globalMaxPerHour: 100,
} as const;

function createRepository(claims: ClaimedTaskReminder[]): TaskReminderRepository {
  return {
    cancelInvalidated: vi.fn(async () => 0),
    recordInvalidTimestamps: vi.fn(async () => 0),
    claimNext: vi.fn(async () => claims.shift() ?? null),
    fail: vi.fn(async () => true),
    fire: vi.fn(async () => ({ outcome: 'fired', pendingDelivery: false })),
  };
}

describe('task reminder orchestration', () => {
  it('clamps batches to 1..500 and defaults to 100', async () => {
    for (const [batchSize, expected] of [
      [undefined, 100],
      [0, 1],
      [999, 500],
    ] as const) {
      const claims = Array.from({ length: expected + 1 }, (_, index) => ({
        id: `occurrence-${index}`,
        taskId: `task-${index}`,
        scheduledAt: '2026-08-31T11:00:00.000Z',
        attemptCount: 1,
        claimToken: `token-${index}`,
      }));
      const repository = createRepository(claims);
      const result = await runDueTaskReminders({
        now: new Date('2026-08-31T12:00:00.000Z'),
        ...(batchSize === undefined ? {} : { batchSize }),
        repository,
        delivery,
      });
      expect(result.examined).toBe(expected);
      expect(repository.cancelInvalidated).toHaveBeenCalledWith(
        expect.objectContaining({ limit: expected }),
      );
      expect(repository.recordInvalidTimestamps).toHaveBeenCalledWith(
        expect.objectContaining({ limit: expected, maxAttempts: 5 }),
      );
    }
  });

  it('uses one, two, four, eight, and capped fifteen minute retry delays', () => {
    expect([1, 2, 3, 4, 5, 8].map(calculateTaskReminderRetryDelayMs)).toEqual([
      60_000,
      120_000,
      240_000,
      480_000,
      900_000,
      900_000,
    ]);
  });
});
