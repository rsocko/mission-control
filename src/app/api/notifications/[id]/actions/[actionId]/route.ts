import { NextResponse } from 'next/server';
import db from '@/db';
import { notifications, notificationActions } from '@/db/schema';
import { eq, and, lt, or } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { isDemoMode } from '@/lib/mode';
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
