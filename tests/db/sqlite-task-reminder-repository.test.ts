import { beforeAll, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createSqliteTaskReminderRepository } from '@/db/persistence/sqlite-task-reminder-repository';
import {
  describeTaskReminderRepositoryContract,
  TASK_REMINDER_BASE_TIME,
  TASK_REMINDER_DELIVERY_CONTEXT,
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
        DELETE FROM connector_configs
        WHERE id IN ('deleted-reminder-connector', 'connector-delete-race');
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
          deleted_at, created_at, updated_at, last_synced_at
        ) VALUES (?, ?, 'local', ?, ?, ?, 'none', ?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        `local:${input.id}`,
        input.connectorInstanceId ?? 'local',
        `Task ${input.id}`,
        input.status ?? 'todo',
        input.reminderAt,
        input.reminderRelative ?? null,
        input.reminderDueTime ?? null,
        input.deletedAt ?? null,
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
    async seedConnector(id, deletedAt = null) {
      const now = TASK_REMINDER_BASE_TIME.toISOString();
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at, deleted_at
        ) VALUES (?, 'test', ?, 1, 'poll', '{}', '{}', '{}', '[]', ?, ?, ?)
      `).run(id, id, now, now, deletedAt);
    },
    async setConnectorDeleted(id, deletedAt) {
      sqlite.prepare(`UPDATE connector_configs SET deleted_at = ? WHERE id = ?`)
        .run(deletedAt, id);
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

  it('advances a persistent reminder and updates one grouped notification', async () => {
    const harness = await createHarness();
    await harness.reset();
    const scheduledAt = '2026-08-31T11:55:00.000Z';
    sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        priority, reminder_at, reminder_nag_interval, reminder_nag_series_id,
        reminder_nag_sequence, created_at, updated_at, last_synced_at
      ) VALUES (
        'nag-task', 'local:nag-task', 'local', 'local', 'Submit permit', 'todo',
        'none', ?, 5, 'series-1', 0, ?, ?, ?
      )
    `).run(
      scheduledAt,
      TASK_REMINDER_BASE_TIME.toISOString(),
      TASK_REMINDER_BASE_TIME.toISOString(),
      TASK_REMINDER_BASE_TIME.toISOString(),
    );

    const firstClaim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 300_000,
      maxAttempts: 5,
    });
    expect(firstClaim).toMatchObject({ seriesId: 'series-1', sequence: 0 });
    await harness.repository.fire(firstClaim!, {
      now: TASK_REMINDER_BASE_TIME,
      delivery: TASK_REMINDER_DELIVERY_CONTEXT,
    });

    const nextAt = '2026-08-31T12:05:00.000Z';
    expect(sqlite.prepare(`
      SELECT reminder_at, reminder_nag_sequence FROM tasks WHERE id = 'nag-task'
    `).get()).toMatchObject({
      reminder_at: nextAt,
      reminder_nag_sequence: 1,
    });

    const secondNow = new Date(nextAt);
    const secondClaim = await harness.repository.claimNext({
      now: secondNow,
      leaseMs: 300_000,
      maxAttempts: 5,
    });
    expect(secondClaim).toMatchObject({ seriesId: 'series-1', sequence: 1 });
    await harness.repository.fire(secondClaim!, {
      now: secondNow,
      delivery: TASK_REMINDER_DELIVERY_CONTEXT,
    });

    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE source_id = 'task-reminder:series:series-1'
    `).get()).toEqual({ count: 1 });
    expect(sqlite.prepare(`
      SELECT body FROM notifications WHERE source_id = 'task-reminder:series:series-1'
    `).get()).toEqual({ body: 'Still pending · alerted 2 times.' });
    expect(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM task_reminder_occurrences
      WHERE series_id = 'series-1'
    `).get()).toEqual({ count: 2 });
    const apnsDeliveries = sqlite.prepare(`
      SELECT id, payload_snapshot
      FROM notification_delivery_events
      WHERE channel = 'apns'
      ORDER BY created_at, id
    `).all() as Array<{ id: string; payload_snapshot: unknown }>;
    expect(apnsDeliveries).toHaveLength(2);
    for (const delivery of apnsDeliveries) {
      expect(parseJson(delivery.payload_snapshot)).toMatchObject({
        deliveryId: delivery.id,
        collapseId: expect.stringMatching(/^mc:/),
        kind: 'task_reminder',
      });
    }
    expect(new Set(apnsDeliveries.map((delivery) => (
      (parseJson(delivery.payload_snapshot) as { collapseId: string }).collapseId
    ))).size).toBe(1);
  });

  it('revives a cancelled occurrence under the task current series identity', async () => {
    const harness = await createHarness();
    await harness.reset();
    const scheduledAt = '2026-08-31T11:55:00.000Z';
    const now = TASK_REMINDER_BASE_TIME.toISOString();
    sqlite.prepare(`
      INSERT INTO tasks (
        id, source_id, connector_type, connector_instance_id, title, status,
        priority, reminder_at, reminder_nag_interval, reminder_nag_series_id,
        reminder_nag_sequence, created_at, updated_at, last_synced_at
      ) VALUES (
        'revived-task', 'local:revived-task', 'local', 'local', 'Submit permit',
        'todo', 'none', ?, 5, 'series-current', 3, ?, ?, ?
      )
    `).run(scheduledAt, now, now, now);
    sqlite.prepare(`
      INSERT INTO task_reminder_occurrences (
        id, task_id, scheduled_at, series_id, sequence, state, attempt_count,
        cancelled_at, created_at, updated_at
      ) VALUES (
        'cancelled-occurrence', 'revived-task', ?, 'series-old', 1, 'cancelled',
        1, ?, ?, ?
      )
    `).run(scheduledAt, now, now, now);

    const claim = await harness.repository.claimNext({
      now: TASK_REMINDER_BASE_TIME,
      leaseMs: 300_000,
      maxAttempts: 5,
    });

    expect(claim).toMatchObject({
      id: 'cancelled-occurrence',
      seriesId: 'series-current',
      sequence: 3,
      attemptCount: 1,
    });
  });
});
