import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  get: vi.fn(() => ({})),
  listen: vi.fn(() => () => undefined),
  request: vi.fn(),
}));

vi.mock('@/lib/native/bridge', () => ({
  getMCNativeBridge: bridgeMocks.get,
  addMCNativeBridgeEventListener: bridgeMocks.listen,
  requestMCNativeBridge: bridgeMocks.request,
}));

import { PushNotificationSettings } from '@/components/settings/PushNotificationSettings';

const preferences = {
  pushDeliveryEnabled: true,
  morningEnabled: true,
  morningHour: 8,
  triageNudgeEnabled: true,
  triageNudgeThreshold: 5,
  carryForwardEnabled: true,
  carryForwardHour: 18,
  quietStart: null,
  quietEnd: null,
  doNotDisturb: false,
};

describe('native push permission settings', () => {
  beforeEach(() => {
    bridgeMocks.get.mockReturnValue({});
    bridgeMocks.listen.mockReturnValue(() => undefined);
    bridgeMocks.request.mockReset();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.includes('/scheduler')
          ? { running: true, jobs: [] }
          : preferences,
      };
    }));
  });

  it('shows contextual guidance before invoking the version 1 bridge action', async () => {
    bridgeMocks.request.mockResolvedValue({
      version: 1,
      requestId: '8cf177a0-e46a-46fa-824c-4c34004e2423',
      action: 'requestPushPermission',
      ok: true,
      result: { authorization: 'authorized' },
    });
    render(<PushNotificationSettings />);

    await screen.findByText('Native push delivery');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));

    expect(screen.getByRole('group', { name: 'Enable iPhone notifications' }))
      .toBeInTheDocument();
    expect(bridgeMocks.request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    await waitFor(() => expect(bridgeMocks.request).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'requestPushPermission',
        payload: { context: 'settings' },
      }),
    ));
  });

  it('provides reconfiguration guidance when iOS reports denial', async () => {
    bridgeMocks.request.mockResolvedValue({
      version: 1,
      requestId: '8cf177a0-e46a-46fa-824c-4c34004e2423',
      action: 'requestPushPermission',
      ok: true,
      result: { authorization: 'denied' },
    });
    render(<PushNotificationSettings />);
    await screen.findByText('Native push delivery');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByText(/Notifications are disabled/)).toBeInTheDocument();
  });

  it('separates push delivery from scheduled reminder generation', async () => {
    render(<PushNotificationSettings />);

    expect(await screen.findByRole('switch', { name: 'Push Delivery' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'Scheduled Summaries' })).toBeChecked();
    expect(screen.queryByRole('switch', { name: 'Notification Scheduler' })).not.toBeInTheDocument();
  });
});
