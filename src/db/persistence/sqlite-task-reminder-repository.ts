import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  createTaskReminderDeliveryPlans,
  TASK_REMINDER_CONNECTOR_ID,
  TASK_REMINDER_CONNECTOR_TYPE,
  isValidTaskReminderTimestamp,
  TASK_REMINDER_SOURCE_PREFIX,
  TASK_REMINDER_TEMPLATE_KEY,
  type ClaimedTaskReminder,
  type TaskReminderDeliveryState,
  type TaskReminderPushRule,
  type TaskReminderRepository,
} from './task-reminders';
import { isQuietHour } from '@/lib/notifications/quiet-hours-window';

const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;
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

function parseBooleanSetting(value: unknown): boolean {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      return false;
    }
  }
  if (typeof parsed === 'boolean') return parsed;
  return Boolean(
    parsed
    && typeof parsed === 'object'
    && !Array.isArray(parsed)
    && (parsed as Record<string, unknown>).enabled === true
  );
}

function isDue(value: string | null, now: Date): value is string {
  return isValidTaskReminderTimestamp(value) && Date.parse(value) <= now.getTime();
}

function getRule(sqlite: Database.Database): TaskReminderPushRule | null {
  const row = sqlite.prepare(`
    SELECT template_key, enabled, min_level, preview, max_per_hour
    FROM notification_push_rules
    WHERE connector_instance_id = ?
      AND template_key IN (?, '*')
    ORDER BY CASE WHEN template_key = ? THEN 0 ELSE 1 END
    LIMIT 1
  `).get(
    TASK_REMINDER_CONNECTOR_ID,
    TASK_REMINDER_TEMPLATE_KEY,
    TASK_REMINDER_TEMPLATE_KEY,
  ) as {
    template_key: string;
    enabled: number;
    min_level: string;
    preview: string;
    max_per_hour: number | null;
  } | undefined;
  return row ? {
    templateKey: row.template_key,
    enabled: row.enabled === 1,
    minLevel: row.min_level,
    preview: row.preview,
    maxPerHour: row.max_per_hour,
  } : null;
}

function getDeliveryState(
  sqlite: Database.Database,
  now: Date,
  currentHour: number,
  apns: { environment: string; topic: string } | null,
  rule: TaskReminderPushRule | null,
): TaskReminderDeliveryState {
  const setting = sqlite.prepare(
    `SELECT value FROM app_settings WHERE key = 'push_delivery_enabled'`,
  ).get() as { value: unknown } | undefined;
  const preferences = sqlite.prepare(`
    SELECT do_not_disturb, quiet_start, quiet_end
    FROM push_preferences WHERE id = 'default'
  `).get() as {
    do_not_disturb: number;
    quiet_start: number | null;
    quiet_end: number | null;
  } | undefined;
  const since = new Date(now.getTime() - 60 * 60 * 1_000).toISOString();
  const globalCount = sqlite.prepare(`
    SELECT COUNT(DISTINCT notification_id) AS count
    FROM notification_delivery_events
    WHERE created_at >= ? AND status IN (${ACTIVE_DELIVERY_STATUSES.map(() => '?').join(', ')})
  `).get(since, ...ACTIVE_DELIVERY_STATUSES) as { count: number };
  const ruleCount = sqlite.prepare(`
    SELECT COUNT(DISTINCT delivery.notification_id) AS count
    FROM notification_delivery_events delivery
    INNER JOIN notifications notification ON notification.id = delivery.notification_id
    WHERE delivery.created_at >= ?
      AND delivery.status IN (${ACTIVE_DELIVERY_STATUSES.map(() => '?').join(', ')})
      AND notification.connector_instance_id = ?
      ${rule?.templateKey === '*' ? '' : 'AND notification.template_key = ?'}
  `).get(
    since,
    ...ACTIVE_DELIVERY_STATUSES,
    TASK_REMINDER_CONNECTOR_ID,
    ...(rule?.templateKey === '*' ? [] : [TASK_REMINDER_TEMPLATE_KEY]),
  ) as { count: number };
  return {
    channelEnabled: setting ? parseBooleanSetting(setting.value) : true,
    doNotDisturb: preferences?.do_not_disturb === 1,
    quietHours: preferences
      ? isQuietHour(currentHour, preferences.quiet_start, preferences.quiet_end)
      : false,
    webPushSubscriptions: Boolean(sqlite.prepare(
      `SELECT 1 FROM push_subscriptions WHERE platform = 'web' LIMIT 1`,
    ).get()),
    apnsRegistrations: apns
      ? Boolean(sqlite.prepare(`
          SELECT 1 FROM apns_registrations
          WHERE invalidated_at IS NULL AND environment = ? AND topic = ?
          LIMIT 1
        `).get(apns.environment, apns.topic))
      : false,
    globalActiveCount: Number(globalCount.count),
    ruleActiveCount: Number(ruleCount.count),
  };
}

function cancelClaim(
  sqlite: Database.Database,
  claim: ClaimedTaskReminder,
  nowIso: string,
  message: string,
): 'cancelled' | 'lost' {
  const result = sqlite.prepare(`
    UPDATE task_reminder_occurrences
    SET state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
        cancelled_at = ?, last_error = ?, updated_at = ?
    WHERE id = ? AND state = 'processing' AND claim_token = ?
  `).run(nowIso, message, nowIso, claim.id, claim.claimToken);
  return result.changes === 1 ? 'cancelled' : 'lost';
}

export function createSqliteTaskReminderRepository(
  sqlite: Database.Database,
): TaskReminderRepository {
  sqlite.function(
    'mc_valid_offset_timestamp',
    { deterministic: true },
    (value: unknown) => isValidTaskReminderTimestamp(value) ? 1 : 0,
  );
  return {
    async cancelInvalidated(input) {
      const nowIso = input.now.toISOString();
      const transaction = sqlite.transaction(() => sqlite.prepare(`
        UPDATE task_reminder_occurrences
        SET state = 'cancelled', claim_token = NULL, lease_expires_at = NULL,
            cancelled_at = ?, last_error = ?, updated_at = ?
        WHERE id IN (
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
          LIMIT ?
        )
          AND state IN ('pending', 'processing', 'failed')
      `).run(
        nowIso,
        'Task was completed, cancelled, deleted, or rescheduled',
        nowIso,
        input.limit,
      ).changes);
      return transaction.immediate();
    },

    async recordInvalidTimestamps(input) {
      const nowIso = input.now.toISOString();
      const transaction = sqlite.transaction(() => {
        const tasks = sqlite.prepare(`
          SELECT task.id, task.reminder_at
          FROM tasks task
          WHERE task.reminder_at IS NOT NULL
            AND task.status NOT IN ('done', 'cancelled')
            AND mc_valid_offset_timestamp(task.reminder_at) = 0
            AND NOT EXISTS (
              SELECT 1 FROM task_reminder_occurrences occurrence
              WHERE occurrence.task_id = task.id
                AND occurrence.scheduled_at = task.reminder_at
            )
          ORDER BY task.id
          LIMIT ?
        `).all(input.limit) as Array<{ id: string; reminder_at: string }>;
        const insert = sqlite.prepare(`
          INSERT INTO task_reminder_occurrences (
            id, task_id, scheduled_at, state, attempt_count, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, 'failed', ?, 'Invalid reminder timestamp', ?, ?)
          ON CONFLICT(task_id, scheduled_at) DO NOTHING
        `);
        let recorded = 0;
        for (const task of tasks) {
          recorded += insert.run(
            randomUUID(),
            task.id,
            task.reminder_at,
            input.maxAttempts,
            nowIso,
            nowIso,
          ).changes;
        }
        return recorded;
      });
      return transaction.immediate();
    },

    async claimNext(input) {
      const nowIso = input.now.toISOString();
      const leaseExpiresAt = new Date(input.now.getTime() + input.leaseMs).toISOString();
      const transaction = sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE task_reminder_occurrences
          SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
              next_attempt_at = NULL, last_error = 'retry_limit_exhausted', updated_at = ?
          WHERE id IN (
            SELECT id
            FROM task_reminder_occurrences
            WHERE state = 'processing'
              AND attempt_count >= ?
              AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
            ORDER BY updated_at, id
            LIMIT 100
          )
        `).run(nowIso, input.maxAttempts, nowIso);
        const candidate = sqlite.prepare(`
          SELECT task.id AS task_id, task.reminder_at AS scheduled_at
          FROM tasks task
          LEFT JOIN task_reminder_occurrences occurrence
            ON occurrence.task_id = task.id
           AND occurrence.scheduled_at = task.reminder_at
          WHERE task.reminder_at IS NOT NULL
            AND task.status NOT IN ('done', 'cancelled')
            AND mc_valid_offset_timestamp(task.reminder_at) = 1
            AND julianday(task.reminder_at) <= julianday(?)
            AND (
              occurrence.id IS NULL
              OR occurrence.state = 'cancelled'
              OR (
                occurrence.attempt_count < ?
                AND (
                  occurrence.state = 'pending'
                  OR (
                    occurrence.state = 'failed'
                    AND (
                      occurrence.next_attempt_at IS NULL
                      OR occurrence.next_attempt_at <= ?
                    )
                  )
                  OR (
                    occurrence.state = 'processing'
                    AND (
                      occurrence.lease_expires_at IS NULL
                      OR occurrence.lease_expires_at <= ?
                    )
                  )
                )
              )
            )
          ORDER BY julianday(task.reminder_at), task.id
          LIMIT 1
        `).get(nowIso, input.maxAttempts, nowIso, nowIso) as CandidateRow | undefined;
        if (!candidate) return null;

        sqlite.prepare(`
          INSERT INTO task_reminder_occurrences (
            id, task_id, scheduled_at, state, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?)
          ON CONFLICT(task_id, scheduled_at) DO NOTHING
        `).run(randomUUID(), candidate.task_id, candidate.scheduled_at, nowIso, nowIso);

        const claimToken = randomUUID();
        const row = sqlite.prepare(`
          UPDATE task_reminder_occurrences
          SET state = 'processing', claim_token = ?, claimed_at = ?, lease_expires_at = ?,
              attempt_count = CASE WHEN state = 'cancelled' THEN 1 ELSE attempt_count + 1 END,
              last_error = NULL, next_attempt_at = NULL, cancelled_at = NULL, updated_at = ?
          WHERE task_id = ? AND scheduled_at = ?
            AND (state = 'cancelled' OR attempt_count < ?)
            AND (
              state IN ('pending', 'cancelled')
              OR (state = 'failed' AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
              OR (
                state = 'processing'
                AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
              )
            )
          RETURNING id, task_id, scheduled_at, attempt_count, claim_token
        `).get(
          claimToken,
          nowIso,
          leaseExpiresAt,
          nowIso,
          candidate.task_id,
          candidate.scheduled_at,
          input.maxAttempts,
          nowIso,
          nowIso,
        ) as OccurrenceRow | undefined;
        return row ? {
          id: row.id,
          taskId: row.task_id,
          scheduledAt: row.scheduled_at,
          attemptCount: row.attempt_count,
          claimToken: row.claim_token,
        } : null;
      });
      return transaction.immediate();
    },

    async fail(claim, input) {
      const nowIso = input.now.toISOString();
      const result = sqlite.prepare(`
        UPDATE task_reminder_occurrences
        SET state = 'failed', claim_token = NULL, lease_expires_at = NULL,
            last_error = ?, next_attempt_at = ?, updated_at = ?
        WHERE id = ? AND state = 'processing' AND claim_token = ?
      `).run(
        input.lastError.slice(0, 1_000),
        input.nextAttemptAt,
        nowIso,
        claim.id,
        claim.claimToken,
      );
      return result.changes === 1;
    },

    async fire(claim, input) {
      const nowIso = input.now.toISOString();
      const transaction = sqlite.transaction(() => {
        const occurrence = sqlite.prepare(`
          SELECT id FROM task_reminder_occurrences
          WHERE id = ? AND state = 'processing' AND claim_token = ?
        `).get(claim.id, claim.claimToken);
        if (!occurrence) return { outcome: 'lost' as const, pendingDelivery: false };

        const task = sqlite.prepare(`
          SELECT id, title, status, reminder_at
          FROM tasks WHERE id = ?
        `).get(claim.taskId) as TaskRow | undefined;
        if (
          !task
          || task.reminder_at !== claim.scheduledAt
          || TERMINAL_TASK_STATUSES.includes(
            task.status as typeof TERMINAL_TASK_STATUSES[number],
          )
          || !isDue(task.reminder_at, input.now)
        ) {
          return {
            outcome: cancelClaim(
              sqlite,
              claim,
              nowIso,
              'Task was completed, cancelled, deleted, or rescheduled before delivery',
            ),
            pendingDelivery: false,
          };
        }

        const sourceId = `${TASK_REMINDER_SOURCE_PREFIX}:${task.id}:${claim.scheduledAt}`;
        const navigationTarget = `/today?taskId=${encodeURIComponent(task.id)}`;
        const notificationId = randomUUID();
        sqlite.prepare(`
          INSERT INTO notifications (
            id, source_id, connector_type, connector_instance_id, title, body,
            level, level_rank, category, template_key, state, read_state,
            disposition, source_state, sync_state, last_source_activity_at,
            last_source_synced_at, is_actionable, received_at, sort_at, dedupe_key,
            related_task_id, related_entity_type, related_entity_id, navigation_target,
            metadata, presentation
          ) VALUES (
            ?, ?, ?, ?, ?, ?, 'heads_up', 2, 'tasks', ?, 'unread', 'unread',
            'inbox', 'active', 'synced', ?, ?, 1, ?, ?, ?, ?, 'task', ?, ?, ?, '{}'
          )
          ON CONFLICT(source_id) DO NOTHING
        `).run(
          notificationId,
          sourceId,
          TASK_REMINDER_CONNECTOR_TYPE,
          TASK_REMINDER_CONNECTOR_ID,
          `Reminder: ${task.title}`,
          'This task is ready for your attention.',
          TASK_REMINDER_TEMPLATE_KEY,
          nowIso,
          nowIso,
          nowIso,
          nowIso,
          sourceId,
          task.id,
          task.id,
          navigationTarget,
          JSON.stringify({
            scheduledAt: claim.scheduledAt,
            reminderOccurrenceId: claim.id,
          }),
        );
        const notification = sqlite.prepare(`
          SELECT id, connector_type, connector_instance_id
          FROM notifications WHERE source_id = ?
        `).get(sourceId) as {
          id: string;
          connector_type: string;
          connector_instance_id: string;
        } | undefined;
        if (!notification) throw new Error('Task reminder notification was not persisted');
        if (
          notification.connector_type !== TASK_REMINDER_CONNECTOR_TYPE
          || notification.connector_instance_id !== TASK_REMINDER_CONNECTOR_ID
        ) {
          throw new Error('Task reminder notification source identity is already owned');
        }

        const actions = [
          ['view', 'navigate', 'View task', 'arrow-right', 'primary', 1, 0,
            JSON.stringify({ target: navigationTarget })],
          ['remind-later', 'remind_later', 'Remind later', 'clock', 'secondary', 0, 1, '{}'],
          ['complete', 'complete_task', 'Complete task', 'check-circle', 'secondary', 0, 2, '{}'],
          ['dismiss', 'dismiss_reminder', 'Dismiss reminder', 'x', 'danger', 0, 3, '{}'],
        ] as const;
        const insertAction = sqlite.prepare(`
          INSERT INTO notification_actions (
            id, notification_id, action_type, label, icon, variant,
            is_primary, sort_order, payload, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'system')
          ON CONFLICT(id) DO NOTHING
        `);
        for (const action of actions) {
          insertAction.run(
            `${notification.id}:${action[0]}`,
            notification.id,
            ...action.slice(1),
          );
        }
        sqlite.prepare(`
          UPDATE notifications SET primary_action_id = ? WHERE id = ?
        `).run(`${notification.id}:view`, notification.id);

        const rule = getRule(sqlite);
        const state = getDeliveryState(
          sqlite,
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
        const insertDelivery = sqlite.prepare(`
          INSERT INTO notification_delivery_events (
            id, notification_id, channel, dedupe_key, status, suppression_reason,
            policy_snapshot, payload_snapshot, attempt_count, next_attempt_at,
            lease_expires_at, claim_token, subscriptions_attempted,
            subscriptions_sent, subscriptions_failed, created_at, sent_at, last_error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, NULL, 0, 0, 0, ?, NULL, NULL)
          ON CONFLICT(dedupe_key) DO NOTHING
        `);
        for (const plan of plans) {
          insertDelivery.run(
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
          );
        }

        const finalized = sqlite.prepare(`
          UPDATE task_reminder_occurrences
          SET state = 'fired', claim_token = NULL, lease_expires_at = NULL,
              fired_at = ?, notification_id = ?, last_error = NULL,
              next_attempt_at = NULL, cancelled_at = NULL, updated_at = ?
          WHERE id = ? AND state = 'processing' AND claim_token = ?
        `).run(nowIso, notification.id, nowIso, claim.id, claim.claimToken);
        if (finalized.changes !== 1) {
          throw new Error('Task reminder occurrence lost its claim');
        }

        const recurrence = sqlite.prepare(`
          SELECT recurrence FROM task_schedules WHERE task_id = ?
        `).get(task.id) as { recurrence: string | null } | undefined;
        sqlite.prepare(`
          UPDATE tasks
          SET reminder_at = NULL,
              reminder_relative = CASE WHEN ? THEN reminder_relative ELSE NULL END,
              reminder_due_time = CASE WHEN ? THEN reminder_due_time ELSE NULL END,
              updated_at = ?
          WHERE id = ? AND reminder_at = ?
        `).run(
          recurrence?.recurrence ? 1 : 0,
          recurrence?.recurrence ? 1 : 0,
          nowIso,
          task.id,
          claim.scheduledAt,
        );
        const pending = sqlite.prepare(`
          SELECT 1 FROM notification_delivery_events
          WHERE notification_id = ? AND status = 'pending'
          LIMIT 1
        `).get(notification.id);
        return { outcome: 'fired' as const, pendingDelivery: Boolean(pending) };
      });
      return transaction.immediate();
    },
  };
}
