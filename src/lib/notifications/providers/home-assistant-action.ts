import 'server-only';

import type { IConnector } from '@/lib/connectors';
import type { HomeAssistantNotificationAction } from '@/lib/connectors/home-assistant';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import { connectorLogger } from '@/lib/logger';
import type { NotificationProviderActionContext, NotificationProviderActionResult } from './types';

interface HomeAssistantActionConnector extends IConnector {
  readonly type: 'home-assistant';
  executeNotificationAction(
    action: HomeAssistantNotificationAction,
    metadata: Record<string, unknown>,
    input: Record<string, unknown>,
  ): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isHomeAssistantActionConnector(
  connector: IConnector | null,
): connector is HomeAssistantActionConnector {
  return connector?.type === 'home-assistant'
    && 'executeNotificationAction' in connector
    && typeof connector.executeNotificationAction === 'function';
}

function homeAssistantActionStatus(error: unknown): 409 | 503 {
  if (
    error instanceof Error
    && error.name === 'HomeAssistantActionError'
    && 'status' in error
    && (error.status === 409 || error.status === 503)
  ) {
    return error.status;
  }
  return 503;
}

export async function executeHomeAssistantProviderAction(
  context: NotificationProviderActionContext,
): Promise<NotificationProviderActionResult | null> {
  const action = context.action.actionType as HomeAssistantNotificationAction;
  if (![
    'install_update',
    'skip_update',
    'dismiss_persistent_notification',
    'ignore_repair',
  ].includes(action)) {
    return null;
  }
  const connector = await getOrInitializeConnector(
    context.notification.connectorInstanceId,
    { refresh: true },
  );
  if (!isHomeAssistantActionConnector(connector)) {
    return {
      result: { type: 'home_assistant_unavailable' },
      error: { message: 'Home Assistant connector is unavailable', status: 503 },
    };
  }

  try {
    await connector.executeNotificationAction(
      action,
      record(context.notification.metadata),
      context.input,
    );
    return {
      result: {
        type: 'home_assistant_action_accepted',
        action,
        confirmation: 'Home Assistant accepted the request. Mission Control will confirm it on the next poll.',
      },
    };
  } catch (error) {
    connectorLogger.warn({
      err: error,
      action,
      connectorId: context.notification.connectorInstanceId,
      notificationId: context.notification.id,
    }, 'Home Assistant notification action failed');
    const status = homeAssistantActionStatus(error);
    return {
      result: { type: 'home_assistant_action_failed', action },
      error: {
        message: error instanceof Error ? error.message : 'Home Assistant action failed',
        status,
      },
    };
  }
}
