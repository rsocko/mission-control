import { and, eq, gt, inArray, sql } from 'drizzle-orm';
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
        // NOTE: the null checks below use raw `sql` fragments (not drizzle's typed
        // `isNotNull()` helper) to match this codebase's established convention for
        // "IS NOT NULL" predicates against Postgres (see e.g. `schema/tasks.ts`'s own
        // index definitions and the raw-SQL repositories under `src/db/postgres`).
        const candidates = (await tx.select({
          id: tasks.id,
          dueDate: tasks.dueDate,
          reminderAt: tasks.reminderAt,
          reminderRelative: tasks.reminderRelative,
          reminderDueTime: tasks.reminderDueTime,
        }).from(tasks).where(and(
          sql`${tasks.reminderRelative} IS NOT NULL`,
          sql`${tasks.reminderAt} IS NOT NULL`,
          sql`${tasks.dueDate} IS NOT NULL`,
          sql`${tasks.reminderDueTime} IS NOT NULL`,
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
