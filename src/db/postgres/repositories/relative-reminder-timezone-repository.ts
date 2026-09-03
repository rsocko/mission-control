import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import { tasks } from '../schema';
import type { PostgresDatabase } from '../runtime';
import type {
  RelativeReminderTaskSnapshot,
  RelativeReminderTimezoneRepository,
} from '@/db/persistence/relative-reminder-timezone';

export function createPostgresRelativeReminderTimezoneRepository(
  db: PostgresDatabase,
): RelativeReminderTimezoneRepository {
  return {
    async applyTimezoneRecompute({ now, recompute }) {
      const nowIso = now.toISOString();
      return db.transaction(async (tx) => {
        const candidates = (await tx.select({
          id: tasks.id,
          dueDate: tasks.dueDate,
          reminderAt: tasks.reminderAt,
          reminderRelative: tasks.reminderRelative,
          reminderDueTime: tasks.reminderDueTime,
        }).from(tasks).where(and(
          isNotNull(tasks.reminderRelative),
          isNotNull(tasks.reminderAt),
          isNotNull(tasks.dueDate),
          isNotNull(tasks.reminderDueTime),
          inArray(tasks.status, ['todo', 'in_progress']),
          gt(tasks.reminderAt, nowIso),
        ))) as RelativeReminderTaskSnapshot[];

        const recomputed = candidates.map((task) => ({ task, result: recompute(task) }));
        const invalid = recomputed.filter(({ result }) => !result.success);
        if (invalid.length > 0) return { invalidCount: invalid.length };

        for (const { task, result } of recomputed) {
          if (!result.success) continue;
          await tx.update(tasks)
            .set({ ...result.updates, updatedAt: nowIso })
            .where(eq(tasks.id, task.id));
        }
        return { invalidCount: 0 };
      });
    },
  };
}
