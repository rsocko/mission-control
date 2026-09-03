import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type * as schema from '@/db/schema';
import { tasks } from '@/db/schema';
import type {
  RelativeReminderTaskSnapshot,
  RelativeReminderTimezoneRepository,
} from './relative-reminder-timezone';

export function createSqliteRelativeReminderTimezoneRepository(
  db: BetterSQLite3Database<typeof schema>,
): RelativeReminderTimezoneRepository {
  return {
    async applyTimezoneRecompute({ now, recompute }) {
      const nowIso = now.toISOString();
      return db.transaction((tx) => {
        const candidates = tx.select({
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
        )).all() as RelativeReminderTaskSnapshot[];

        const recomputed = candidates.map((task) => ({ task, result: recompute(task) }));
        const invalid = recomputed.filter(({ result }) => !result.success);
        if (invalid.length > 0) return { invalidCount: invalid.length };

        for (const { task, result } of recomputed) {
          if (!result.success) continue;
          tx.update(tasks)
            .set({ ...result.updates, updatedAt: nowIso })
            .where(eq(tasks.id, task.id))
            .run();
        }
        return { invalidCount: 0 };
      });
    },
  };
}
