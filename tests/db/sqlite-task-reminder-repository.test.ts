import { beforeAll, describe } from 'vitest';
import type Database from 'better-sqlite3';
import { createSqliteTaskReminderRepository } from '@/db/persistence/sqlite-task-reminder-repository';
import {
  describeTaskReminderRepositoryContract,
  TASK_REMINDER_BASE_TIME,
  type TaskReminderContractHarness,
} from '../contracts/task-reminder-repository.contract';

process.env.MC_DB_PATH = ':memory:';

let sqlite: Database.Database;

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function createHarness(): Promise<TaskReminderContractHarness> {
  return {
    repository: createSqliteTaskReminderRepository(sqlite),
    async reset() {
      sqlite.exec(`
        DELETE FROM notification_delivery_events;
        DELETE FROM notification_actions;
        DELETE FROM notifications;
        DELETE FROM task_schedules;
        DELETE FROM task_reminder_occurrences;
        DELETE FROM tasks;
        DELETE FROM push_subscriptions;
        DELETE FROM apns_registrations;
        DELETE FROM push_preferences;
        DELETE FROM notification_push_rules;
        DELETE FROM app_settings;
      `);
    },
    async seedTask(input) {
      const now = TASK_REMINDER_BASE_TIME.toISOString();
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          priority, reminder_at, reminder_relative, reminder_due_time,
          created_at, updated_at, last_synced_at
        ) VALUES (?, ?, 'local', 'local', ?, ?, 'none', ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        `local:${input.id}`,
        `Task ${input.id}`,
        input.status ?? 'todo',
        input.reminderAt,
        input.reminderRelative ?? null,
        input.reminderDueTime ?? null,
        now,
        now,
        now,
      );
      if (input.recurrence) {
        sqlite.prepare(`
          INSERT INTO task_schedules (task_id, scheduled_date, recurrence)
          VALUES (?, '2026-09-01', ?)
        `).run(input.id, input.recurrence);
      }
    },
    async seedOccurrence(input) {
      const now = TASK_REMINDER_BASE_TIME.toISOString();
      sqlite.prepare(`
        INSERT INTO task_reminder_occurrences (
          id, task_id, scheduled_at, state, attempt_count, claim_token,
          lease_expires_at, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.taskId,
        input.scheduledAt,
        input.state,
        input.attemptCount ?? 0,
        input.claimToken ?? null,
        input.leaseExpiresAt ?? null,
        input.nextAttemptAt ?? null,
        now,
        now,
      );
    },
    async updateTask(id, values) {
      if ('reminderAt' in values) {
        sqlite.prepare(`UPDATE tasks SET reminder_at = ? WHERE id = ?`)
          .run(values.reminderAt ?? null, id);
      }
      if (values.status !== undefined) {
        sqlite.prepare(`UPDATE tasks SET status = ? WHERE id = ?`).run(values.status, id);
      }
    },
    async deleteTask(id) {
      sqlite.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
    },
    async setOccurrenceProcessing(id, claimToken, attemptCount) {
      sqlite.prepare(`
        UPDATE task_reminder_occurrences
        SET state = 'processing', claim_token = ?, attempt_count = ?
        WHERE id = ?
      `).run(claimToken, attemptCount, id);
    },
    async getOccurrence(taskId, scheduledAt) {
      const row = sqlite.prepare(`
        SELECT state, attempt_count, claim_token, next_attempt_at, notification_id
        FROM task_reminder_occurrences
        WHERE task_id = ? AND scheduled_at = ?
      `).get(taskId, scheduledAt) as {
        state: string;
        attempt_count: number;
        claim_token: string | null;
        next_attempt_at: string | null;
        notification_id: string | null;
      } | undefined;
      return row ? {
        state: row.state,
        attemptCount: row.attempt_count,
        claimToken: row.claim_token,
        nextAttemptAt: row.next_attempt_at,
        notificationId: row.notification_id,
      } : null;
    },
    async getTaskReminder(id) {
      const row = sqlite.prepare(`
        SELECT reminder_at, reminder_relative, reminder_due_time
        FROM tasks WHERE id = ?
      `).get(id) as {
        reminder_at: string | null;
        reminder_relative: string | null;
        reminder_due_time: string | null;
      } | undefined;
      return row ? {
        reminderAt: row.reminder_at,
        reminderRelative: row.reminder_relative,
        reminderDueTime: row.reminder_due_time,
      } : null;
    },
    async getArtifacts() {
      const notifications = sqlite.prepare(`
        SELECT source_id FROM notifications ORDER BY source_id
      `).all() as Array<{ source_id: string }>;
      const actions = sqlite.prepare(`
        SELECT action_type, sort_order, payload
        FROM notification_actions ORDER BY sort_order
      `).all() as Array<{ action_type: string; sort_order: number; payload: unknown }>;
      const deliveries = sqlite.prepare(`
        SELECT channel, status, dedupe_key
        FROM notification_delivery_events ORDER BY channel
      `).all() as Array<{ channel: string; status: string; dedupe_key: string }>;
      return {
        notifications: notifications.map((row) => ({ sourceId: row.source_id })),
        actions: actions.map((row) => ({
          actionType: row.action_type,
          sortOrder: row.sort_order,
          payload: parseJson(row.payload),
        })),
        deliveries: deliveries.map((row) => ({
          channel: row.channel,
          status: row.status,
          dedupeKey: row.dedupe_key,
        })),
      };
    },
  };
}

beforeAll(async () => {
  ({ sqlite } = await import('@/db'));
});

describe('SQLite task reminder repository', () => {
  describeTaskReminderRepositoryContract(createHarness);
});
