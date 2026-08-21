import { NextResponse } from 'next/server';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import db, { runTransaction } from '@/db';
import {
  notifications,
  notificationActions,
  pushPreferences,
  tasks,
} from '@/db/schema';
import { eq, and, isNull, lt, notInArray, or } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { getTimezone, isDemoMode } from '@/lib/mode';
import {
  dismissNotificationsAndEnqueueWritebacks,
  wakeNotificationWritebackDispatcher,
} from '@/lib/notifications/notification-writeback';
import { executeWorkflow } from '@/lib/notifications/workflow-executor';
import { legacyStateMutationPatch } from '@/lib/notifications/lifecycle';
import {
  executeNotificationProviderAction,
  normalizeInternalNavigationTarget,
  normalizeNotificationUrl,
  registerDefaultNotificationProviders,
} from '@/lib/notifications/providers';

const TERMINAL_TASK_STATUSES = ['done', 'cancelled'] as const;
const REMIND_LATER_DURATIONS = ['15m', '1h', 'tomorrow_morning'] as const;
type RemindLaterDuration = typeof REMIND_LATER_DURATIONS[number];

class ReminderActionConflictError extends Error {}

function isRemindLaterDuration(value: unknown): value is RemindLaterDuration {
  return REMIND_LATER_DURATIONS.includes(value as RemindLaterDuration);
}

export function getRemindLaterTarget(
  duration: RemindLaterDuration,
  now: Date,
  timezone: string,
  morningHour: number,
): string {
  if (duration === '15m') return new Date(now.getTime() + 15 * 60_000).toISOString();
  if (duration === '1h') return new Date(now.getTime() + 60 * 60_000).toISOString();

  const localDate = formatInTimeZone(now, timezone, 'yyyy-MM-dd');
  const [year, month, day] = localDate.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
  return fromZonedTime(
    `${tomorrow}T${String(morningHour).padStart(2, '0')}:00:00`,
    timezone,
  ).toISOString();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseActionPayload(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return asRecord(value);
  return asRecord(JSON.parse(value));
}

async function findNotification(id: string) {
  const [notification] = await db.select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return notification;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> }
) {
  try {
    const { id, actionId } = await params;
    const body = asRecord(await request.json().catch(() => ({})));

    // Find the notification
    const notification = await findNotification(id);

    if (!notification) {
      return ApiErrors.notFound('Notification');
    }

    // Find the action
    const [action] = await db.select()
      .from(notificationActions)
      .where(and(
        eq(notificationActions.id, actionId),
        eq(notificationActions.notificationId, id)
      ))
      .limit(1);

    if (!action) {
      return ApiErrors.notFound('Action');
    }

    const now = new Date().toISOString();
    const payload = parseActionPayload(action.payload);

    registerDefaultNotificationProviders();
    const providerResult = await executeNotificationProviderAction({
      notification,
      action,
      payload,
      input: body,
    });

    if (providerResult) {
      if (providerResult.error) {
        return NextResponse.json({
          success: false,
          error: providerResult.error.message,
        }, { status: providerResult.error.status });
      }
      if (providerResult.state) {
        const lifecycleUpdate = providerResult.state === 'resolved'
          ? {
              ...legacyStateMutationPatch(notification, 'archived', now),
              archivedAt: now,
            }
          : providerResult.state === 'dismissed'
            ? legacyStateMutationPatch(notification, 'dismissed', now)
            : legacyStateMutationPatch(notification, 'read', now);
        await db.update(notifications)
          .set(lifecycleUpdate)
          .where(eq(notifications.id, id));
      }
      return NextResponse.json({ success: true, result: providerResult.result });
    }

    // Built-in handlers are explicit fallbacks. Source-specific actions must be
    // claimed by their registered notification provider above.
    switch (action.actionType) {
      case 'open_url': {
        const url = normalizeNotificationUrl(payload.url);
        if (!url) {
          return ApiErrors.badRequest('Action URL must use http or https');
        }
        // Mark as read, return URL for client to open
        await db.update(notifications)
          .set(legacyStateMutationPatch(notification, 'read', now))
          .where(eq(notifications.id, id));
        return NextResponse.json({
          success: true,
          result: { type: 'open_url', url },
        });
      }

      case 'create_task': {
        // Mark as resolved, return task creation payload
        await db.update(notifications)
          .set({
            ...legacyStateMutationPatch(notification, 'archived', now),
            archivedAt: now,
          })
          .where(eq(notifications.id, id));
        return NextResponse.json({
          success: true,
          result: {
            type: 'create_task',
            taskData: {
              title: payload.taskTitle || notification.title,
              body: payload.taskBody || notification.body,
              priority: payload.priority || 'medium',
              sourceNotificationId: id,
              ...(body.overrides || {}),
            },
          },
        });
      }

      case 'navigate': {
        const target = normalizeInternalNavigationTarget(
          payload.target || notification.navigationTarget,
        );
        if (!target) {
          return ApiErrors.badRequest('Navigation target must be an internal path');
        }
        await db.update(notifications)
          .set(legacyStateMutationPatch(notification, 'read', now))
          .where(eq(notifications.id, id));
        return NextResponse.json({
          success: true,
          result: { type: 'navigate', target },
        });
      }

      case 'remind_later':
      case 'complete_task':
      case 'dismiss_reminder': {
        if (notification.templateKey !== 'task_reminder' || !notification.relatedTaskId) {
          return ApiErrors.badRequest('Reminder actions require a task reminder notification');
        }
        const duration = body.duration;
        if (action.actionType === 'remind_later' && !isRemindLaterDuration(duration)) {
          return ApiErrors.badRequest('Invalid duration. Use: 15m, 1h, tomorrow_morning');
        }

        let completionResult: Record<string, unknown> = {};
        if (action.actionType === 'complete_task') {
          const { PATCH: patchTask } = await import('@/app/api/tasks/[id]/route');
          const completionResponse = await patchTask(new Request(
            `http://localhost/api/tasks/${encodeURIComponent(notification.relatedTaskId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'done' }),
            },
          ), {
            params: Promise.resolve({ id: notification.relatedTaskId }),
          });
          completionResult = asRecord(await completionResponse.json());
          if (!completionResponse.ok) {
            return NextResponse.json(completionResult, { status: completionResponse.status });
          }
        }

        const actionNow = new Date();
        const actionNowIso = actionNow.toISOString();
        const timezone = getTimezone();
        const morningHour = db.select({ morningHour: pushPreferences.morningHour })
          .from(pushPreferences)
          .where(eq(pushPreferences.id, 'default'))
          .get()?.morningHour ?? 8;
        const reminderAt = action.actionType === 'remind_later'
          ? getRemindLaterTarget(duration as RemindLaterDuration, actionNow, timezone, morningHour)
          : null;
        try {
          runTransaction((tx) => {
            const liveNotification = tx.select().from(notifications)
              .where(eq(notifications.id, id))
              .get();
            const task = tx.select().from(tasks)
              .where(eq(tasks.id, notification.relatedTaskId!))
              .get();
            if (!liveNotification || !task) {
              throw new ReminderActionConflictError('The reminder task no longer exists');
            }
            if (
              liveNotification.disposition !== 'inbox'
              || liveNotification.sourceState !== 'active'
            ) {
              throw new ReminderActionConflictError('This reminder has already been handled');
            }
            if (
              TERMINAL_TASK_STATUSES.includes(
                task.status as typeof TERMINAL_TASK_STATUSES[number],
              )
              && !(action.actionType === 'complete_task' && task.status === 'done')
            ) {
              throw new ReminderActionConflictError('This task is already complete or cancelled');
            }

            const claimed = tx.update(notificationActions).set({
              executionState: 'running',
              claimedAt: actionNowIso,
              lastError: null,
            }).where(and(
              eq(notificationActions.id, actionId),
              eq(notificationActions.notificationId, id),
              eq(notificationActions.executionState, 'pending'),
            )).run();
            if (claimed.changes !== 1) {
              throw new ReminderActionConflictError('This reminder action has already been handled');
            }

            if (action.actionType === 'remind_later') {
              const scheduled = tx.update(tasks).set({
                reminderAt,
                updatedAt: actionNowIso,
              }).where(and(
                eq(tasks.id, task.id),
                isNull(tasks.reminderAt),
                notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
              )).run();
              if (scheduled.changes !== 1) {
                throw new ReminderActionConflictError(
                  'The task reminder changed before it could be rescheduled',
                );
              }
            } else if (action.actionType === 'dismiss_reminder') {
              tx.update(tasks).set({
                reminderAt: null,
                reminderRelative: null,
                reminderDueTime: null,
                updatedAt: actionNowIso,
              }).where(eq(tasks.id, task.id)).run();
            }

            const metadata = parseActionPayload(liveNotification.metadata);
            const notificationPatch = action.actionType === 'dismiss_reminder'
              ? legacyStateMutationPatch(liveNotification, 'dismissed', actionNowIso)
              : {
                  ...legacyStateMutationPatch(liveNotification, 'archived', actionNowIso),
                  archivedAt: actionNowIso,
                };
            tx.update(notifications).set({
              ...notificationPatch,
              isActionable: false,
              primaryActionId: null,
              metadata: {
                ...metadata,
                reminderAction: action.actionType,
                reminderActionAt: actionNowIso,
                ...(reminderAt ? { rescheduledFor: reminderAt } : {}),
              },
            }).where(eq(notifications.id, id)).run();
            tx.update(notificationActions).set({
              executionState: 'completed',
              completedAt: actionNowIso,
              lastError: null,
            }).where(eq(notificationActions.notificationId, id)).run();
          });
        } catch (error) {
          if (error instanceof ReminderActionConflictError) {
            return NextResponse.json({ success: false, error: error.message }, { status: 409 });
          }
          throw error;
        }

        return NextResponse.json({
          success: true,
          result: {
            type: action.actionType,
            ...(reminderAt ? { reminderAt } : {}),
            ...(action.actionType === 'complete_task' ? completionResult : {}),
          },
        });
      }

      case 'dismiss': {
        if (isDemoMode()) {
          await db.update(notifications)
            .set({
              state: 'dismissed',
              readState: 'read',
              disposition: 'dismissed',
              readAt: now,
              dismissedAt: now,
            })
            .where(eq(notifications.id, id));
        } else {
          const result = dismissNotificationsAndEnqueueWritebacks([id], now);
          if (result.queuedCount > 0) wakeNotificationWritebackDispatcher();
        }
        return NextResponse.json({ success: true, result: { type: 'dismissed' } });
      }

      case 'approve':
      case 'reject': {
        await db.update(notifications)
          .set({
            ...legacyStateMutationPatch(notification, 'archived', now),
            archivedAt: now,
          })
          .where(eq(notifications.id, id));
        return NextResponse.json({
          success: true,
          result: { type: action.actionType, payload },
        });
      }

      case 'run_workflow': {
        const workflowId = typeof payload.workflowId === 'string'
          ? payload.workflowId
          : typeof payload.url === 'string'
            ? payload.url
            : null;
        if (!workflowId) {
          return NextResponse.json({
            success: false,
            error: 'No workflowId specified in action payload',
          }, { status: 400 });
        }

        const workflowParams = {
          ...asRecord(payload.params),
          ...asRecord(body.params),
        };
        const notificationMetadata = parseActionPayload(notification.metadata);
        const parentNotificationId = typeof notificationMetadata.parentNotificationId === 'string'
          ? notificationMetadata.parentNotificationId
          : notification.id;
        const executionNotification = parentNotificationId === notification.id
          ? notification
          : await findNotification(parentNotificationId) || notification;
        const rootNotificationId = executionNotification.id;

        const recoveryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const claimed = db.transaction((tx) => {
          const result = tx.update(notificationActions)
            .set({
              executionState: 'running',
              claimedAt: now,
              completedAt: null,
              lastError: null,
            })
            .where(and(
              eq(notificationActions.id, actionId),
              eq(notificationActions.notificationId, id),
              or(
                eq(notificationActions.executionState, 'pending'),
                and(
                  eq(notificationActions.executionState, 'running'),
                  lt(notificationActions.claimedAt, recoveryCutoff),
                ),
              ),
            ))
            .run();
          if (result.changes === 0) return false;

          tx.update(notifications)
            .set({ isActionable: false, primaryActionId: null })
            .where(eq(notifications.id, id))
            .run();
          return true;
        });
        if (!claimed) {
          return NextResponse.json(
            { success: false, error: 'This workflow action has already been started' },
            { status: 409 },
          );
        }

        const workflowResult = await executeWorkflow(
          workflowId,
          workflowParams,
          {
            notificationId: rootNotificationId,
            title: executionNotification.title,
            body: executionNotification.body,
            connectorType: executionNotification.connectorType || 'unknown',
            category: executionNotification.category || 'general',
            metadata: parseActionPayload(executionNotification.metadata),
            idempotencyKey: `notification-action:${actionId}`,
          }
        );

        const resultNotificationId = crypto.randomUUID();
        const groupKey = notification.groupKey
          || executionNotification.groupKey
          || `workflow:${rootNotificationId}`;
        const resultTitle = workflowResult.success
          ? `Workflow completed: ${executionNotification.title}`
          : `Workflow failed: ${executionNotification.title}`;
        const resultBody = workflowResult.success
          ? 'The workflow completed successfully.'
          : workflowResult.error || 'The workflow did not complete successfully.';
        const completionPatch = workflowResult.success
          ? {
              ...legacyStateMutationPatch(notification, 'archived', now),
              archivedAt: now,
            }
          : legacyStateMutationPatch(notification, 'read', now);

        db.transaction((tx) => {
          tx.update(notificationActions)
            .set({
              executionState: workflowResult.success ? 'completed' : 'failed',
              completedAt: now,
              lastError: workflowResult.success ? null : resultBody,
            })
            .where(eq(notificationActions.id, actionId))
            .run();

          tx.update(notifications)
            .set({
              ...completionPatch,
              isActionable: false,
              primaryActionId: null,
              groupKey,
            })
            .where(eq(notifications.id, id))
            .run();

          tx.insert(notifications).values({
            id: resultNotificationId,
            sourceId: `workflow-result:${id}:${resultNotificationId}`,
            connectorType: 'mission-control',
            connectorInstanceId: 'mission-control:workflow',
            title: resultTitle,
            body: resultBody,
            level: workflowResult.success ? 'heads_up' : 'action_needed',
            levelRank: workflowResult.success ? 2 : 1,
            category: 'automation',
            templateKey: 'workflow_result',
            state: 'unread',
            readState: 'unread',
            disposition: 'inbox',
            sourceState: 'active',
            syncState: 'synced',
            isActionable: !workflowResult.success,
            receivedAt: now,
            sortAt: now,
            groupKey,
            relatedTaskId: executionNotification.relatedTaskId,
            relatedProjectId: executionNotification.relatedProjectId,
            relatedEntityType: 'notification',
            relatedEntityId: rootNotificationId,
            metadata: {
              parentNotificationId: rootNotificationId,
              workflowId: workflowResult.workflowId || workflowId,
              outcome: workflowResult.success ? 'completed' : 'failed',
            },
            presentation: {
              sourceName: 'Workflow',
              subtitle: workflowResult.success ? 'Completed successfully' : 'Needs attention',
            },
          }).run();

          if (!workflowResult.success) {
            tx.insert(notificationActions).values({
              id: crypto.randomUUID(),
              notificationId: resultNotificationId,
              actionType: 'run_workflow',
              label: 'Retry workflow',
              icon: 'zap',
              variant: 'primary',
              isPrimary: true,
              sortOrder: 0,
              payload: {
                ...payload,
                params: workflowParams,
              },
              opensExternal: false,
              requiresConfirmation: false,
              createdBy: 'system',
            }).run();
          }
        });

        return NextResponse.json({
          success: workflowResult.success,
          result: {
            type: 'run_workflow',
            workflowId: workflowResult.workflowId,
            response: workflowResult.response,
            error: workflowResult.error,
            followUpNotificationId: resultNotificationId,
          },
        });
      }

      default: {
        return ApiErrors.badRequest(
          `Action type "${action.actionType}" is not handled by the ${notification.connectorType} provider`,
        );
      }
    }
  } catch (error) {
    return ApiErrors.internal('Failed to execute action', error);
  }
}
