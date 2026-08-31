import { afterAll, describe, expect, it, vi } from 'vitest';
import { createPostgresTaskReminderRepository } from '@/db/postgres/repositories/task-reminder-repository';
import {
  describeTaskReminderRepositoryContract,
  TASK_REMINDER_BASE_TIME,
  type TaskReminderContractHarness,
} from '../contracts/task-reminder-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const webPushMocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: webPushMocks,
}));

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL task reminders');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;
const originalVapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const originalVapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
let runtime: typeof import('@/db/runtime') | null = null;
let initialized = false;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-task-reminder-test';
  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  initialized = true;
}

function currentPool() {
  if (!runtime) throw new Error('PostgreSQL task reminder runtime is not initialized');
  return runtime.getPostgresPersistenceBackend().context.pool;
}

async function createHarness(): Promise<TaskReminderContractHarness> {
  await initialize();
  return {
    repository: createPostgresTaskReminderRepository(currentPool()),
    async reset() {
      await currentPool().query(`
        DELETE FROM notification_delivery_events
        WHERE notification_id IN (
          SELECT id FROM notifications WHERE source_id LIKE 'task-reminder:%'
        )
      `);
      await currentPool().query(`
        DELETE FROM notification_actions
        WHERE notification_id IN (
          SELECT id FROM notifications WHERE source_id LIKE 'task-reminder:%'
        )
      `);
      await currentPool().query(`DELETE FROM notifications WHERE source_id LIKE 'task-reminder:%'`);
      await currentPool().query(`
        DELETE FROM task_schedules
        WHERE task_id IN (
          'missed', 'ownership', 'retry', 'invalid-a', 'invalid-b',
          'invalid-local', 'invalid-calendar',
          'future-offset', 'due-offset', 'due-z', 'rescheduled',
          'completed', 'deleted', 'race', 'one-shot', 'crashed-final',
          'ready-after-crash', 'postgres-smoke'
        )
      `);
      await currentPool().query(`
        DELETE FROM tasks
        WHERE id IN (
          'missed', 'ownership', 'retry', 'invalid-a', 'invalid-b',
          'invalid-local', 'invalid-calendar',
          'future-offset', 'due-offset', 'due-z', 'rescheduled',
          'completed', 'deleted', 'race', 'one-shot', 'crashed-final',
          'ready-after-crash', 'postgres-smoke'
        )
      `);
      await currentPool().query(`
        DELETE FROM push_subscriptions WHERE id = 'postgres-reminder-web'
      `);
      await currentPool().query(`
        DELETE FROM notification_push_rules
        WHERE connector_instance_id = 'push-triggers'
          AND template_key IN ('task_reminder', '*')
      `);
      await currentPool().query(`DELETE FROM push_preferences WHERE id = 'default'`);
      await currentPool().query(`DELETE FROM app_settings WHERE key = 'push_delivery_enabled'`);
    },
    async seedTask(input) {
      const now = TASK_REMINDER_BASE_TIME.toISOString();
      await currentPool().query(
        `
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            priority, reminder_at, reminder_relative, reminder_due_time,
            created_at, updated_at, last_synced_at
          ) VALUES ($1, $2, 'local', 'local', $3, $4, 'none', $5, $6, $7, $8, $8, $8)
        `,
        [
          input.id,
          `local:${input.id}`,
          `Task ${input.id}`,
          input.status ?? 'todo',
          input.reminderAt,
          input.reminderRelative ?? null,
          input.reminderDueTime ?? null,
          now,
        ],
      );
      if (input.recurrence) {
        await currentPool().query(
          `
            INSERT INTO task_schedules (task_id, scheduled_date, recurrence)
            VALUES ($1, '2026-09-01', $2)
          `,
          [input.id, input.recurrence],
        );
      }
    },
    async seedOccurrence(input) {
      const now = TASK_REMINDER_BASE_TIME.toISOString();
      await currentPool().query(
        `
          INSERT INTO task_reminder_occurrences (
            id, task_id, scheduled_at, state, attempt_count, claim_token,
            lease_expires_at, next_attempt_at, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9)
        `,
        [
          input.id,
          input.taskId,
          input.scheduledAt,
          input.state,
          input.attemptCount ?? 0,
          input.claimToken ?? null,
          input.leaseExpiresAt ?? null,
          input.nextAttemptAt ?? null,
          now,
        ],
      );
    },
    async updateTask(id, values) {
      if ('reminderAt' in values) {
        await currentPool().query(
          `UPDATE tasks SET reminder_at = $1 WHERE id = $2`,
          [values.reminderAt ?? null, id],
        );
      }
      if (values.status !== undefined) {
        await currentPool().query(
          `UPDATE tasks SET status = $1 WHERE id = $2`,
          [values.status, id],
        );
      }
    },
    async deleteTask(id) {
      await currentPool().query(`DELETE FROM tasks WHERE id = $1`, [id]);
    },
    async setOccurrenceProcessing(id, claimToken, attemptCount) {
      await currentPool().query(
        `
          UPDATE task_reminder_occurrences
          SET state = 'processing', claim_token = $1, attempt_count = $2
          WHERE id = $3
        `,
        [claimToken, attemptCount, id],
      );
    },
    async getOccurrence(taskId, scheduledAt) {
      const result = await currentPool().query<{
        state: string;
        attempt_count: number;
        claim_token: string | null;
        next_attempt_at: string | null;
        notification_id: string | null;
      }>(
        `
          SELECT state, attempt_count, claim_token, next_attempt_at, notification_id
          FROM task_reminder_occurrences
          WHERE task_id = $1 AND scheduled_at = $2
        `,
        [taskId, scheduledAt],
      );
      const row = result.rows[0];
      return row ? {
        state: row.state,
        attemptCount: row.attempt_count,
        claimToken: row.claim_token,
        nextAttemptAt: row.next_attempt_at,
        notificationId: row.notification_id,
      } : null;
    },
    async getTaskReminder(id) {
      const result = await currentPool().query<{
        reminder_at: string | null;
        reminder_relative: string | null;
        reminder_due_time: string | null;
      }>(
        `
          SELECT reminder_at, reminder_relative, reminder_due_time
          FROM tasks WHERE id = $1
        `,
        [id],
      );
      const row = result.rows[0];
      return row ? {
        reminderAt: row.reminder_at,
        reminderRelative: row.reminder_relative,
        reminderDueTime: row.reminder_due_time,
      } : null;
    },
    async getArtifacts() {
      const notifications = await currentPool().query<{ source_id: string }>(
        `SELECT source_id FROM notifications WHERE source_id LIKE 'task-reminder:%'
         ORDER BY source_id`,
      );
      const actions = await currentPool().query<{
        action_type: string;
        sort_order: number;
        payload: unknown;
      }>(
        `
          SELECT action.action_type, action.sort_order, action.payload
          FROM notification_actions action
          INNER JOIN notifications notification ON notification.id = action.notification_id
          WHERE notification.source_id LIKE 'task-reminder:%'
          ORDER BY action.sort_order
        `,
      );
      const deliveries = await currentPool().query<{
        channel: string;
        status: string;
        dedupe_key: string;
      }>(
        `
          SELECT delivery.channel, delivery.status, delivery.dedupe_key
          FROM notification_delivery_events delivery
          INNER JOIN notifications notification ON notification.id = delivery.notification_id
          WHERE notification.source_id LIKE 'task-reminder:%'
          ORDER BY delivery.channel
        `,
      );
      return {
        notifications: notifications.rows.map((row) => ({ sourceId: row.source_id })),
        actions: actions.rows.map((row) => ({
          actionType: row.action_type,
          sortOrder: row.sort_order,
          payload: row.payload,
        })),
        deliveries: deliveries.rows.map((row) => ({
          channel: row.channel,
          status: row.status,
          dedupeKey: row.dedupe_key,
        })),
      };
    },
  };
}

afterAll(async () => {
  if (initialized) {
    await (await createHarness()).reset();
    await runtime?.shutdownRuntimeDatabase();
  }
  restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
  restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
  restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
  restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  restoreEnvironment('VAPID_PUBLIC_KEY', originalVapidPublicKey);
  restoreEnvironment('VAPID_PRIVATE_KEY', originalVapidPrivateKey);
});

if (connectionString) {
  describe('PostgreSQL task reminder repository', () => {
    describeTaskReminderRepositoryContract(createHarness);

    it('runs a registered scheduler startup through terminal delivery after restart', async () => {
      const harness = await createHarness();
      await harness.reset();
      process.env.VAPID_PUBLIC_KEY = 'inert-public-key';
      process.env.VAPID_PRIVATE_KEY = 'inert-private-key';
      await harness.seedTask({
        id: 'postgres-smoke',
        reminderAt: '2026-08-31T11:55:00.000Z',
      });
      await harness.seedOccurrence({
        id: 'postgres-smoke-occurrence',
        taskId: 'postgres-smoke',
        scheduledAt: '2026-08-31T11:55:00.000Z',
        state: 'processing',
        attemptCount: 1,
        claimToken: 'abandoned-before-restart',
        leaseExpiresAt: '2026-08-31T11:59:00.000Z',
      });
      await currentPool().query(
        `
          INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
          VALUES (
            'postgres-reminder-web', 'web', 'https://push.example.test/reminder',
            '{"p256dh":"key","auth":"auth"}'::jsonb, $1
          )
        `,
        [TASK_REMINDER_BASE_TIME.toISOString()],
      );
      webPushMocks.sendNotification.mockReset();
      webPushMocks.sendNotification.mockResolvedValue({});

      const { TaskReminderScheduler } = await import('@/lib/push/task-reminder-scheduler');
      const { runDueTaskReminders } = await import('@/lib/push/task-reminders');
      const scheduler = new TaskReminderScheduler(
        () => runDueTaskReminders({ now: TASK_REMINDER_BASE_TIME }),
      );
      await scheduler.start();
      scheduler.stop();

      await vi.waitFor(async () => {
        expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
        const occurrence = await harness.getOccurrence(
          'postgres-smoke',
          '2026-08-31T11:55:00.000Z',
        );
        expect(occurrence).toMatchObject({
          state: 'fired',
          attemptCount: 2,
          claimToken: null,
        });
        const delivery = await currentPool().query<{ status: string }>(
          `
            SELECT delivery.status
            FROM notification_delivery_events delivery
            INNER JOIN notifications notification ON notification.id = delivery.notification_id
            WHERE notification.source_id =
              'task-reminder:postgres-smoke:2026-08-31T11:55:00.000Z'
              AND delivery.channel = 'web_push'
          `,
        );
        expect(delivery.rows[0]?.status).toBe('sent');
      });
    });
  });
} else {
  describe('PostgreSQL task reminder repository', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
