import { NextResponse } from 'next/server';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';
import { ApiErrors } from '@/lib/api-error';
import { getTimezone, isDemoMode } from '@/lib/mode';
import { getNotificationWebPersistence } from '@/lib/notifications/notification-web-service';
import { executeWorkflow } from '@/lib/notifications/workflow-executor';
import {
  executeNotificationProviderAction,
  normalizeInternalNavigationTarget,
  normalizeNotificationUrl,
  registerDefaultNotificationProviders,
} from '@/lib/notifications/providers';
import { executeHomeAssistantProviderAction } from '@/lib/notifications/providers/home-assistant-action';

const REMIND_LATER_DURATIONS = ['15m', '1h', 'tomorrow_morning'] as const;
const HOME_ASSISTANT_MUTATING_ACTIONS = new Set([
  'install_update',
  'skip_update',
  'dismiss_persistent_notification',
  'ignore_repair',
]);
type RemindLaterDuration = typeof REMIND_LATER_DURATIONS[number];

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

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; actionId: string }> }
) {
  try {
    const { id, actionId } = await params;
    const body = asRecord(await request.json().catch(() => ({})));
    const persistence = await getNotificationWebPersistence();

    const notification = await persistence.findNotificationForAction(id);

    if (!notification) {
      return ApiErrors.notFound('Notification');
    }

    const action = await persistence.findNotificationAction(id, actionId);

    if (!action) {
      return ApiErrors.notFound('Action');
    }

    const now = new Date().toISOString();
    const payload = parseActionPayload(action.payload);
    const requiresProviderClaim = notification.connectorType === 'home-assistant'
      && HOME_ASSISTANT_MUTATING_ACTIONS.has(action.actionType);
    if (requiresProviderClaim) {
      const claimed = await persistence.claimProviderAction({
        notificationId: id,
        actionId,
        claimedAt: now,
        recoveryCutoff: new Date(Date.now() - 5 * 60_000).toISOString(),
      });
      if (!claimed) {
        return NextResponse.json(
          { success: false, error: 'This Home Assistant action is already being processed' },
          { status: 409 },
        );
      }
    }

    registerDefaultNotificationProviders();
    let providerResult;
    try {
      const context = {
        notification,
        action,
        payload,
        input: body,
      };
      providerResult = notification.connectorType === 'home-assistant'
        ? await executeHomeAssistantProviderAction(context)
        : await executeNotificationProviderAction(context);
    } catch (error) {
      if (requiresProviderClaim) {
        await persistence.finalizeProviderAction({
          notificationId: id,
          claimedAt: now,
          now: new Date().toISOString(),
          success: false,
          error: error instanceof Error ? error.message : 'Provider action failed',
        });
      }
      throw error;
    }

    if (providerResult) {
      if (providerResult.error) {
        if (requiresProviderClaim) {
          await persistence.finalizeProviderAction({
            notificationId: id,
            claimedAt: now,
            now: new Date().toISOString(),
            success: false,
            error: providerResult.error.message,
          });
        }
        return NextResponse.json({
          success: false,
          error: providerResult.error.message,
        }, { status: providerResult.error.status });
      }
      if (providerResult.state) {
        const state = providerResult.state === 'resolved'
          ? 'archived'
          : providerResult.state === 'dismissed'
            ? 'dismissed'
            : 'read';
        await persistence.updateNotificationFromAction({
          notificationId: id,
          state,
          now,
        });
      }
      if (requiresProviderClaim) {
        await persistence.finalizeProviderAction({
          notificationId: id,
          claimedAt: now,
          now: new Date().toISOString(),
          success: true,
          error: null,
        });
      }
      return NextResponse.json({ success: true, result: providerResult.result });
    }
    if (requiresProviderClaim) {
      await persistence.finalizeProviderAction({
        notificationId: id,
        claimedAt: now,
        now: new Date().toISOString(),
        success: false,
        error: 'Home Assistant provider declined the action',
      });
    }

    // Built-in handlers are used only when a source-specific provider declines.
    // claimed by their registered notification provider above.
    switch (action.actionType) {
      case 'open_url': {
        const url = normalizeNotificationUrl(payload.url);
        if (!url) {
          return ApiErrors.badRequest('Action URL must use http or https');
        }
        // Mark as read, return URL for client to open
        await persistence.updateNotificationFromAction({
          notificationId: id,
          state: 'read',
          now,
        });
        return NextResponse.json({
          success: true,
          result: { type: 'open_url', url },
        });
      }

      case 'create_task': {
        // Mark as resolved, return task creation payload
        await persistence.updateNotificationFromAction({
          notificationId: id,
          state: 'archived',
          now,
        });
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
        await persistence.updateNotificationFromAction({
          notificationId: id,
          state: 'read',
          now,
        });
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
        const morningHour = await persistence.getReminderMorningHour();
        const reminderAt = action.actionType === 'remind_later'
          ? getRemindLaterTarget(duration as RemindLaterDuration, actionNow, timezone, morningHour)
          : null;
        const reminderResult = await persistence.applyReminderAction({
          notificationId: id,
          actionId,
          taskId: notification.relatedTaskId,
          actionType: action.actionType,
          now: actionNowIso,
          reminderAt,
        });
        if (!reminderResult.applied) {
          const messages = {
            missing: 'The reminder task no longer exists',
            handled: 'This reminder has already been handled',
            task_terminal: 'This task is already complete or cancelled',
            action_claimed: 'This reminder action has already been handled',
            reminder_changed: 'The task reminder changed before it could be rescheduled',
          } as const;
          return NextResponse.json(
            { success: false, error: messages[reminderResult.conflict] },
            { status: 409 },
          );
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
          await persistence.updateNotificationFromAction({
            notificationId: id,
            state: 'dismissed',
            now,
          });
        } else {
          const result = await persistence.dismissNotificationsAndEnqueueWritebacks([id], now);
          if (result.queuedCount > 0) persistence.wakeWritebackDispatcher();
        }
        return NextResponse.json({ success: true, result: { type: 'dismissed' } });
      }

      case 'approve':
      case 'reject': {
        await persistence.updateNotificationFromAction({
          notificationId: id,
          state: 'archived',
          now,
        });
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
          : await persistence.findNotificationForAction(parentNotificationId) || notification;
        const rootNotificationId = executionNotification.id;

        const recoveryCutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
        const claimed = await persistence.claimWorkflowAction({
          notificationId: id,
          actionId,
          claimedAt: now,
          recoveryCutoff,
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
          },
          persistence,
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
        const finalized = await persistence.finalizeWorkflowAction({
          notificationId: id,
          actionId,
          claimedAt: now,
          now,
          success: workflowResult.success,
          error: workflowResult.success ? null : resultBody,
          groupKey,
          followUp: {
            id: resultNotificationId,
            sourceId: `workflow-result:${id}:${resultNotificationId}`,
            title: resultTitle,
            body: resultBody,
            level: workflowResult.success ? 'heads_up' : 'action_needed',
            levelRank: workflowResult.success ? 2 : 1,
            groupKey,
            relatedTaskId: executionNotification.relatedTaskId,
            relatedProjectId: executionNotification.relatedProjectId,
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
            retryAction: workflowResult.success ? null : {
              id: crypto.randomUUID(),
              payload: {
                ...payload,
                params: workflowParams,
              },
            },
          },
        });
        if (!finalized) {
          return NextResponse.json(
            { success: false, error: 'This workflow action was superseded' },
            { status: 409 },
          );
        }

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
