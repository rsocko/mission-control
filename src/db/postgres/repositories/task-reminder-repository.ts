import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import {
  createTaskReminderDeliveryPlans,
  TASK_REMINDER_CONNECTOR_ID,
  TASK_REMINDER_CONNECTOR_TYPE,
  TASK_REMINDER_OFFSET_TIMESTAMP_PATTERN,
  TASK_REMINDER_SOURCE_PREFIX,
  TASK_REMINDER_TEMPLATE_KEY,
  isValidTaskReminderTimestamp,
  type ClaimedTaskReminder,
  type TaskReminderDeliveryState,
  type TaskReminderPushRule,
  type TaskReminderRepository,
} from '@/db/persistence/task-reminders';
import { isQuietHour } from '@/lib/notifications/quiet-hours-window';

const ACTIVE_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'partial'] as const;

interface CandidateRow {
  task_id: string;
  scheduled_at: string;
}

interface OccurrenceRow {
  id: string;
  task_id: string;
  scheduled_at: string;
  attempt_count: number;
  claim_token: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  reminder_at: string | null;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

function parseBooleanSetting(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === true
  );
}

function isDue(value: string | null, now: Date): value is string {
  return isValidTaskReminderTimestamp(value) && Date.parse(value) <= now.getTime();
}

async function getRule(client: PoolClient): Promise<TaskReminderPushRule | null> {
  const result = await client.query<{
    template_key: string;
    enabled: boolean;
    min_level: string;
    preview: string;
    max_per_hour: number | null;
  }>(
    `
      SELECT template_key, enabled, min_level, preview, max_per_hour
      FROM notification_push_rules
      WHERE connector_instance_id = $1
        AND template_key IN ($2, '*')
      ORDER BY CASE WHEN template_key = $2 THEN 0 ELSE 1 END
      LIMIT 1
    `,
    [TASK_REMINDER_CONNECTOR_ID, TASK_REMINDER_TEMPLATE_KEY],
  );
  const row = result.rows[0];
  return row ? {
    templateKey: row.template_key,
    enabled: row.enabled,
    minLevel: row.min_level,
    preview: row.preview,
    maxPerHour: row.max_per_hour,
  } : null;
}

async function getDeliveryState(
  client: PoolClient,
  now: Date,
  currentHour: number,
  apns: { environment: string; topic: string } | null,
  rule: TaskReminderPushRule | null,
): Promise<TaskReminderDeliveryState> {
  const setting = await client.query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
  );
  const preferences = await client.query<{
    do_not_disturb: boolean;
    quiet_start: number | null;
    quiet_end: number | null;
  }>(`
    SELECT do_not_disturb, quiet_start, quiet_end
    FROM push_preferences WHERE id = 'default'
  `);
  const webSubscriptions = await client.query(
    `SELECT 1 FROM push_subscriptions WHERE platform = 'web' LIMIT 1`,
  );
  const apnsRegistrations = apns
    ? await client.query(
        `
          SELECT 1 FROM apns_registrations
          WHERE invalidated_at IS NULL AND environment = $1 AND topic = $2
          LIMIT 1
        `,
        [apns.environment, apns.topic],
      )
    : { rowCount: 0 };
  const since = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
  const globalCount = await client.query<{ count: string }>(
    `
      SELECT COUNT(DISTINCT notification_id) AS count
      FROM notification_delivery_events
      WHERE created_at >= $1 AND status = ANY($2::text[])
    `,
    [since, ACTIVE_DELIVERY_STATUSES],
  );
  const ruleCount = await client.query<{ count: string }>(
    `
      SELECT COUNT(DISTINCT delivery.notification_id) AS count
      FROM notification_delivery_events delivery
      INNER JOIN notifications notification ON notification.id = delivery.notification_id
      WHERE delivery.created_at >= $1
        AND delivery.status = ANY($2::text[])
        AND notification.connector_instance_id = $3
        ${rule?.templateKey === '*' ? '' : 'AND notification.template_key = $4'}
    `,
    [
      since,
      ACTIVE_DELIVERY_STATUSES,
      TASK_REMINDER_CONNECTOR_ID,
      ...(rule?.templateKey === '*' ? [] : [TASK_REMINDER_TEMPLATE_KEY]),
    ],
  );
  const preference = preferences.rows[0];
  return {
    channelEnabled: setting.rows[0] ? parseBooleanSetting(setting.rows[0].value) : true,
    doNotDisturb: preference?.do_not_disturb ?? false,
    quietHours: preference
      ? isQuietHour(currentHour, preference.quiet_start, preference.quiet_end)
      : false,
    webPushSubscriptions: (webSubscriptions.rowCount ?? 0) > 0,
    apnsRegistrations: (apnsRegistrations.rowCount ?? 0) > 0,
    globalActiveCount: Number(globalCount.rows[0]?.count ?? 0),
    ruleActiveCount: Number(ruleCount.rows[0]?.count ?? 0),
  };
}

async function cancelClaim(
  client: PoolClient,
  claim: ClaimedTaskReminder,
  nowIso: string,
  message: string,
): Promise<'cancelled' | 'lost'> {
  const result = await client.query(
    `
      UPDATE task_reminder_occurrences
      SET state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
          cancelled_at = $1, last_error = $2, updated_at = $1
      WHERE id = $3 AND state = 'processing' AND claim_token = $4
    `,
    [nowIso, message, claim.id, claim.claimToken],
  );
  return result.rowCount === 1 ? 'cancelled' : 'lost';
}

export function createPostgresTaskReminderRepository(pool: Pool): TaskReminderRepository {
  return {
    async cancelInvalidated(input) {
      const result = await pool.query(
        `
          WITH candidate AS (
            SELECT occurrence.id
            FROM task_reminder_occurrences occurrence
            LEFT JOIN tasks task ON task.id = occurrence.task_id
            WHERE occurrence.state IN ('pending', 'processing', 'failed')
              AND (
                task.id IS NULL
                OR task.reminder_at IS NULL
                OR task.reminder_at <> occurrence.scheduled_at
                OR task.status IN ('done', 'cancelled')
              )
            ORDER BY occurrence.updated_at, occurrence.id
            FOR UPDATE OF occurrence SKIP LOCKED
            LIMIT $1
          )
          UPDATE task_reminder_occurrences occurrence
          SET state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
              cancelled_at = $2, last_error = $3, updated_at = $2
          FROM candidate
          WHERE occurrence.id = candidate.id
            AND occurrence.state IN ('pending', 'processing', 'failed')
        `,
        [
          input.limit,
          input.now.toISOString(),
          'Task was completed, cancelled, deleted, or rescheduled',
        ],
      );
      return result.rowCount ?? 0;
    },

    async recordInvalidTimestamps(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const tasks = await client.query<{ id: string; reminder_at: string }>(
          `
            SELECT task.id, task.reminder_at
            FROM tasks task
            WHERE task.reminder_at IS NOT NULL
              AND task.status NOT IN ('done', 'cancelled')
              AND NOT (
                task.reminder_at ~ $1
                AND pg_input_is_valid(task.reminder_at, 'timestamp with time zone')
              )
              AND NOT EXISTS (
                SELECT 1 FROM task_reminder_occurrences occurrence
                WHERE occurrence.task_id = task.id
                  AND occurrence.scheduled_at = task.reminder_at
              )
            ORDER BY task.id
            FOR UPDATE OF task SKIP LOCKED
            LIMIT $2
          `,
          [TASK_REMINDER_OFFSET_TIMESTAMP_PATTERN, input.limit],
        );
        let recorded = 0;
        for (const task of tasks.rows) {
          const inserted = await client.query(
            `
              INSERT INTO task_reminder_occurrences (
                id, task_id, scheduled_at, state, attempt_count, last_error,
                created_at, updated_at
              ) VALUES ($1, $2, $3, 'failed', $4, 'Invalid reminder timestamp', $5, $5)
              ON CONFLICT(task_id, scheduled_at) DO NOTHING
            `,
            [
              randomUUID(),
              task.id,
              task.reminder_at,
              input.maxAttempts,
              input.now.toISOString(),
            ],
          );
          recorded += inserted.rowCount ?? 0;
        }
        await client.query('COMMIT');
        return recorded;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async claimNext(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const nowIso = input.now.toISOString();
        await client.query(
          `
            WITH exhausted AS (
              SELECT id
              FROM task_reminder_occurrences
              WHERE state = 'processing'
                AND attempt_count >= $1
                AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
              ORDER BY updated_at, id
              FOR UPDATE SKIP LOCKED
              LIMIT 100
            )
            UPDATE task_reminder_occurrences occurrence
            SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
                next_attempt_at = NULL, last_error = 'retry_limit_exhausted',
                updated_at = $2
            FROM exhausted
            WHERE occurrence.id = exhausted.id
          `,
          [input.maxAttempts, nowIso],
        );
        const candidate = await client.query<CandidateRow>(
          `
            SELECT task.id AS task_id, task.reminder_at AS scheduled_at
            FROM tasks task
            LEFT JOIN task_reminder_occurrences occurrence
              ON occurrence.task_id = task.id
             AND occurrence.scheduled_at = task.reminder_at
            WHERE task.reminder_at IS NOT NULL
              AND task.status NOT IN ('done', 'cancelled')
              AND (
                CASE
                  WHEN task.reminder_at ~ $2
                    AND pg_input_is_valid(task.reminder_at, 'timestamp with time zone')
                  THEN task.reminder_at::timestamptz
                  ELSE NULL
                END
              ) <= $1::timestamptz
              AND (
                occurrence.id IS NULL
                OR occurrence.state = 'cancelled'
                OR (
                  occurrence.attempt_count < $3
                  AND (
                    occurrence.state = 'pending'
                    OR (
                      occurrence.state = 'failed'
                      AND (
                        occurrence.next_attempt_at IS NULL
                        OR occurrence.next_attempt_at <= $4
                      )
                    )
                    OR (
                      occurrence.state = 'processing'
                      AND (
                        occurrence.lease_expires_at IS NULL
                        OR occurrence.lease_expires_at <= $4
                      )
                    )
                  )
                )
              )
            ORDER BY (
              CASE
                WHEN task.reminder_at ~ $2
                  AND pg_input_is_valid(task.reminder_at, 'timestamp with time zone')
                THEN task.reminder_at::timestamptz
                ELSE NULL
              END
            ), task.id
            FOR UPDATE OF task SKIP LOCKED
            LIMIT 1
          `,
          [
            nowIso,
            TASK_REMINDER_OFFSET_TIMESTAMP_PATTERN,
            input.maxAttempts,
            nowIso,
          ],
        );
        const selected = candidate.rows[0];
        if (!selected) {
          await client.query('COMMIT');
          return null;
        }
        await client.query(
          `
            INSERT INTO task_reminder_occurrences (
              id, task_id, scheduled_at, state, created_at, updated_at
            ) VALUES ($1, $2, $3, 'pending', $4, $4)
            ON CONFLICT(task_id, scheduled_at) DO NOTHING
          `,
          [randomUUID(), selected.task_id, selected.scheduled_at, nowIso],
        );
        const claimToken = randomUUID();
        const claimed = await client.query<OccurrenceRow>(
          `
            UPDATE task_reminder_occurrences
            SET state = 'processing', claim_token = $1, claimed_at = $2,
                lease_expires_at = $3,
                attempt_count = CASE WHEN state = 'cancelled' THEN 1 ELSE attempt_count + 1 END,
                last_error = NULL, next_attempt_at = NULL, cancelled_at = NULL, updated_at = $2
            WHERE task_id = $4 AND scheduled_at = $5
              AND (state = 'cancelled' OR attempt_count < $6)
              AND (
                state IN ('pending', 'cancelled')
                OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= $2))
                OR (
                  state = 'processing'
                  AND (lease_expires_at IS NULL OR lease_expires_at <= $2)
                )
              )
            RETURNING id, task_id, scheduled_at, attempt_count, claim_token
          `,
          [
            claimToken,
            nowIso,
            new Date(input.now.getTime() + input.leaseMs).toISOString(),
            selected.task_id,
            selected.scheduled_at,
            input.maxAttempts,
          ],
        );
        await client.query('COMMIT');
        const row = claimed.rows[0];
        return row ? {
          id: row.id,
          taskId: row.task_id,
          scheduledAt: row.scheduled_at,
          attemptCount: row.attempt_count,
          claimToken: row.claim_token,
        } : null;
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async fail(claim, input) {
      const result = await pool.query(
        `
          UPDATE task_reminder_occurrences
          SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
              last_error = $1, next_attempt_at = $2, updated_at = $3
          WHERE id = $4 AND state = 'processing' AND claim_token = $5
        `,
        [
          input.lastError.slice(0, 1_000),
          input.nextAttemptAt,
          input.now.toISOString(),
          claim.id,
          claim.claimToken,
        ],
      );
      return result.rowCount === 1;
    },

    async fire(claim, input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const taskResult = await client.query<TaskRow>(
          `
            SELECT id, title, status, reminder_at
            FROM tasks WHERE id = $1
            FOR UPDATE
          `,
          [claim.taskId],
        );
        const occurrence = await client.query(
          `
            SELECT id FROM task_reminder_occurrences
            WHERE id = $1 AND state = 'processing' AND claim_token = $2
            FOR UPDATE
          `,
          [claim.id, claim.claimToken],
        );
        if ((occurrence.rowCount ?? 0) === 0) {
          await client.query('COMMIT');
          return { outcome: 'lost' as const, pendingDelivery: false };
        }
        const task = taskResult.rows[0];
        const nowIso = input.now.toISOString();
        if (
          !task
          || task.reminder_at !== claim.scheduledAt
          || ['done', 'cancelled'].includes(task.status)
          || !isDue(task.reminder_at, input.now)
        ) {
          const outcome = await cancelClaim(
            client,
            claim,
            nowIso,
            'Task was completed, cancelled, deleted, or rescheduled before delivery',
          );
          await client.query('COMMIT');
          return { outcome, pendingDelivery: false };
        }

        const sourceId = `${TASK_REMINDER_SOURCE_PREFIX}:${task.id}:${claim.scheduledAt}`;
        const navigationTarget = `/today?taskId=${encodeURIComponent(task.id)}`;
        await client.query(
          `
            INSERT INTO notifications (
              id, source_id, connector_type, connector_instance_id, title, body,
              level, level_rank, category, template_key, state, read_state,
              disposition, source_state, sync_state, last_source_activity_at,
              last_source_synced_at, is_actionable, received_at, sort_at, dedupe_key,
              related_task_id, related_entity_type, related_entity_id, navigation_target,
              metadata, presentation
            ) VALUES (
              $1, $2, $3, $4, $5, $6, 'heads_up', 2, 'tasks', $7, 'unread', 'unread',
              'inbox', 'active', 'synced', $8, $8, true, $8, $8, $2,
              $9, 'task', $9, $10, $11::jsonb, '{}'::jsonb
            )
            ON CONFLICT(source_id) DO NOTHING
          `,
          [
            randomUUID(),
            sourceId,
            TASK_REMINDER_CONNECTOR_TYPE,
            TASK_REMINDER_CONNECTOR_ID,
            `Reminder: ${task.title}`,
            'This task is ready for your attention.',
            TASK_REMINDER_TEMPLATE_KEY,
            nowIso,
            task.id,
            navigationTarget,
            JSON.stringify({
              scheduledAt: claim.scheduledAt,
              reminderOccurrenceId: claim.id,
            }),
          ],
        );
        const notificationResult = await client.query<{
          id: string;
          connector_type: string;
          connector_instance_id: string;
        }>(
          `
            SELECT id, connector_type, connector_instance_id
            FROM notifications WHERE source_id = $1
          `,
          [sourceId],
        );
        const notification = notificationResult.rows[0];
        if (!notification) throw new Error('Task reminder notification was not persisted');
        if (
          notification.connector_type !== TASK_REMINDER_CONNECTOR_TYPE
          || notification.connector_instance_id !== TASK_REMINDER_CONNECTOR_ID
        ) {
          throw new Error('Task reminder notification source identity is already owned');
        }

        const actions = [
          ['view', 'navigate', 'View task', 'arrow-right', 'primary', true, 0,
            JSON.stringify({ target: navigationTarget })],
          ['remind-later', 'remind_later', 'Remind later', 'clock', 'secondary', false, 1, '{}'],
          ['complete', 'complete_task', 'Complete task', 'check-circle', 'secondary', false, 2, '{}'],
          ['dismiss', 'dismiss_reminder', 'Dismiss reminder', 'x', 'danger', false, 3, '{}'],
        ] as const;
        for (const action of actions) {
          await client.query(
            `
              INSERT INTO notification_actions (
                id, notification_id, action_type, label, icon, variant,
                is_primary, sort_order, payload, created_by
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'system')
              ON CONFLICT(id) DO NOTHING
            `,
            [`${notification.id}:${action[0]}`, notification.id, ...action.slice(1)],
          );
        }
        await client.query(
          `UPDATE notifications SET primary_action_id = $1 WHERE id = $2`,
          [`${notification.id}:view`, notification.id],
        );

        const rule = await getRule(client);
        const state = await getDeliveryState(
          client,
          input.now,
          input.delivery.currentHour,
          input.delivery.apns,
          rule,
        );
        const plans = createTaskReminderDeliveryPlans({
          notificationId: notification.id,
          title: `Reminder: ${task.title}`,
          body: 'This task is ready for your attention.',
          navigationTarget,
          rule,
          state,
          context: input.delivery,
        });
        for (const plan of plans) {
          await client.query(
            `
              INSERT INTO notification_delivery_events (
                id, notification_id, channel, dedupe_key, status, suppression_reason,
                policy_snapshot, payload_snapshot, attempt_count, next_attempt_at,
                lease_expires_at, claim_token, subscriptions_attempted,
                subscriptions_sent, subscriptions_failed, created_at, sent_at, last_error
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, 0, $9,
                NULL, NULL, 0, 0, 0, $10, NULL, NULL
              )
              ON CONFLICT(dedupe_key) DO NOTHING
            `,
            [
              randomUUID(),
              notification.id,
              plan.channel,
              `${plan.channel}:${notification.id}:${claim.scheduledAt}`,
              plan.status,
              plan.suppressionReason,
              JSON.stringify(plan.policySnapshot),
              JSON.stringify(plan.payloadSnapshot),
              plan.status === 'pending' ? nowIso : null,
              nowIso,
            ],
          );
        }

        const finalized = await client.query(
          `
            UPDATE task_reminder_occurrences
            SET state = 'fired', claim_token = NULL, lease_expires_at = NULL,
                fired_at = $1, notification_id = $2, last_error = NULL,
                next_attempt_at = NULL, cancelled_at = NULL, updated_at = $1
            WHERE id = $3 AND state = 'processing' AND claim_token = $4
          `,
          [nowIso, notification.id, claim.id, claim.claimToken],
        );
        if (finalized.rowCount !== 1) {
          throw new Error('Task reminder occurrence lost its claim');
        }
        const recurrence = await client.query<{ recurrence: string | null }>(
          `SELECT recurrence FROM task_schedules WHERE task_id = $1`,
          [task.id],
        );
        const recurring = Boolean(recurrence.rows[0]?.recurrence);
        await client.query(
          `
            UPDATE tasks
            SET reminder_at = NULL,
                reminder_relative = CASE WHEN $1 THEN reminder_relative ELSE NULL END,
                reminder_due_time = CASE WHEN $1 THEN reminder_due_time ELSE NULL END,
                updated_at = $2
            WHERE id = $3 AND reminder_at = $4
          `,
          [recurring, nowIso, task.id, claim.scheduledAt],
        );
        const pending = await client.query(
          `
            SELECT 1 FROM notification_delivery_events
            WHERE notification_id = $1 AND status = 'pending'
            LIMIT 1
          `,
          [notification.id],
        );
        await client.query('COMMIT');
        return {
          outcome: 'fired' as const,
          pendingDelivery: (pending.rowCount ?? 0) > 0,
        };
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
