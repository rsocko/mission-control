/**
 * Backend-neutral contract for the one PATCH `/api/settings/mode` operation
 * that touches `tasks`: re-validating (and, if every affected task still
 * resolves, recomputing) relative reminders when the configured timezone
 * changes. Scoped narrowly to this single use case — see
 * `docs/architecture/persistence-boundaries.md`, "Web/API PostgreSQL parity:
 * Layer L02" — rather than exposing a general task query facade.
 */
export interface RelativeReminderTaskSnapshot {
  id: string;
  dueDate: string | null;
  reminderAt: string | null;
  reminderRelative: string | null;
  reminderDueTime: string | null;
}

export type RelativeReminderRecomputeUpdates = Partial<
  Pick<RelativeReminderTaskSnapshot, 'reminderAt' | 'reminderRelative' | 'reminderDueTime'>
>;

export type RelativeReminderRecomputeResult =
  | { success: true; updates: RelativeReminderRecomputeUpdates }
  | { success: false };

export interface RelativeReminderTimezoneRepository {
  /**
   * Finds every active (`todo`/`in_progress`) task with a fully-specified
   * relative reminder whose reminder fires strictly after `now`, and calls
   * `recompute` once per task. If every call succeeds, persists the
   * returned partial updates (plus `updatedAt: now`) for all affected tasks
   * atomically in a single transaction and resolves `{ invalidCount: 0 }`.
   * If any call fails, no row is mutated and the resolved `invalidCount` is
   * the number of tasks that would become invalid/past under the new
   * timezone, so the caller can reject the change instead.
   */
  applyTimezoneRecompute(input: {
    now: Date;
    recompute: (task: RelativeReminderTaskSnapshot) => RelativeReminderRecomputeResult;
  }): Promise<{ invalidCount: number }>;
}
