import 'server-only';

import {
  HomeAssistantActionError,
  HomeAssistantConnector,
  type HomeAssistantNotificationAction,
} from '@/lib/connectors/home-assistant';
import { getOrInitializeConnector } from '@/lib/connectors/runtime';
import type { NotificationProviderActionContext, NotificationProviderActionResult } from './types';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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
  if (!(connector instanceof HomeAssistantConnector)) {
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
    const status = error instanceof HomeAssistantActionError ? error.status : 503;
    return {
      result: { type: 'home_assistant_action_failed', action },
      error: {
        message: error instanceof Error ? error.message : 'Home Assistant action failed',
        status,
      },
    };
  }
}
