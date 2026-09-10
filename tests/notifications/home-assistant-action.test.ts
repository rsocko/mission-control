import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  executeNotificationAction: vi.fn(),
  getOrInitializeConnector: vi.fn(),
}));

vi.mock('@/lib/connectors/runtime', () => ({
  getOrInitializeConnector: mocks.getOrInitializeConnector,
}));

import { executeHomeAssistantProviderAction } from '@/lib/notifications/providers/home-assistant-action';

const context = {
  notification: {
    id: 'notification-1',
    sourceId: 'persistent:water_filter',
    connectorType: 'home-assistant',
    connectorInstanceId: 'ha-home',
    title: 'Replace water filter',
    body: null,
    category: 'home',
    navigationTarget: null,
    metadata: { notificationId: 'water_filter' },
    presentation: {},
  },
  action: {
    id: 'action-1',
    notificationId: 'notification-1',
    actionType: 'dismiss_persistent_notification',
    payload: {},
  },
  payload: {},
  input: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getOrInitializeConnector.mockResolvedValue({
    type: 'home-assistant',
    executeNotificationAction: mocks.executeNotificationAction,
  });
  mocks.executeNotificationAction.mockResolvedValue(undefined);
});

describe('Home Assistant notification actions', () => {
  it.each([
    'install_update',
    'skip_update',
    'dismiss_persistent_notification',
    'ignore_repair',
  ])('routes %s through a connector from a prior module evaluation', async (actionType) => {
    const actionContext = {
      ...context,
      action: { ...context.action, actionType },
    };

    await expect(executeHomeAssistantProviderAction(actionContext)).resolves.toEqual({
      result: {
        type: 'home_assistant_action_accepted',
        action: actionType,
        confirmation: 'Home Assistant accepted the request. Mission Control will confirm it on the next poll.',
      },
    });
    expect(mocks.executeNotificationAction).toHaveBeenCalledWith(
      actionType,
      { notificationId: 'water_filter' },
      {},
    );
  });

  it('preserves a conflict status from an action error created by a prior module evaluation', async () => {
    const error = new Error('This notification is no longer active in Home Assistant');
    error.name = 'HomeAssistantActionError';
    Object.assign(error, { status: 409 });
    mocks.executeNotificationAction.mockRejectedValue(error);

    await expect(executeHomeAssistantProviderAction(context)).resolves.toEqual({
      result: {
        type: 'home_assistant_action_failed',
        action: 'dismiss_persistent_notification',
      },
      error: {
        message: 'This notification is no longer active in Home Assistant',
        status: 409,
      },
    });
  });

  it('rejects a connector without the Home Assistant action contract', async () => {
    mocks.getOrInitializeConnector.mockResolvedValue({ type: 'home-assistant' });

    await expect(executeHomeAssistantProviderAction(context)).resolves.toEqual({
      result: { type: 'home_assistant_unavailable' },
      error: { message: 'Home Assistant connector is unavailable', status: 503 },
    });
  });
});
