import 'server-only';

import type { IConnector } from '@/lib/connectors';
import type { PaperclipNotificationAction } from '@/lib/connectors/paperclip';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { ExternalAgentError } from '@/lib/external-agents/errors';
import { connectorLogger } from '@/lib/logger';
import type {
  NotificationProviderActionContext,
  NotificationProviderActionResult,
} from './types';

interface PaperclipActionConnector extends IConnector {
  readonly type: 'paperclip';
  executeApprovalDecision(
    decision: PaperclipNotificationAction,
    metadata: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isPaperclipActionConnector(
  connector: IConnector | null,
): connector is PaperclipActionConnector {
  return connector?.type === 'paperclip'
    && 'executeApprovalDecision' in connector
    && typeof connector.executeApprovalDecision === 'function';
}

function actionStatus(error: unknown): 400 | 401 | 403 | 409 | 503 {
  if (error instanceof ExternalAgentError) {
    if (error.status === 400 || error.status === 422) return 400;
    if (error.status === 401 || error.status === 403 || error.status === 409) {
      return error.status;
    }
  }
  return 503;
}

export async function executePaperclipProviderAction(
  context: NotificationProviderActionContext,
): Promise<NotificationProviderActionResult | null> {
  const decision = context.action.actionType === 'paperclip_approve'
    ? 'approve'
    : context.action.actionType === 'paperclip_reject'
      ? 'reject'
      : null;
  if (!decision) return null;

  const connector = await getOrInitializeConnector(
    context.notification.connectorInstanceId,
    { refresh: true },
  );
  if (!isPaperclipActionConnector(connector)) {
    return {
      result: { type: 'paperclip_unavailable' },
      error: { message: 'Paperclip connector is unavailable', status: 503 },
    };
  }

  try {
    await connector.executeApprovalDecision(
      decision,
      record(context.notification.metadata),
      context.input,
    );
    return {
      result: {
        type: 'paperclip_approval_decision_accepted',
        decision,
        confirmation: decision === 'approve'
          ? 'Approved in Paperclip. Mission Control is reconciling the final state.'
          : 'Rejected in Paperclip. Mission Control is reconciling the final state.',
      },
    };
  } catch (error) {
    connectorLogger.warn({
      err: error,
      decision,
      connectorId: context.notification.connectorInstanceId,
      notificationId: context.notification.id,
    }, 'Paperclip approval action failed');
    return {
      result: { type: 'paperclip_approval_decision_failed', decision },
      error: {
        message: error instanceof Error ? error.message : 'Paperclip approval action failed',
        status: actionStatus(error),
      },
    };
  }
}
