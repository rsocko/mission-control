import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PushRulesResponse } from '@/lib/notifications/push-rules-contract';

const pushMocks = vi.hoisted(() => ({
  subscribe: vi.fn(),
}));

vi.mock('@/lib/hooks/usePushNotifications', () => ({
  usePushNotifications: () => ({
    permission: 'default',
    isSubscribed: false,
    isLoading: false,
    subscribe: pushMocks.subscribe,
    unsubscribe: vi.fn(),
  }),
}));

vi.mock('@/app/settings/components/ConnectorBrandIcon', () => ({
  ConnectorBrandIcon: () => <span data-testid="connector-icon" />,
}));

import { ConnectorPushRules } from '@/components/settings/ConnectorPushRules';

const response: PushRulesResponse = {
  global: {
    pushDeliveryEnabled: true,
    doNotDisturb: false,
    quietStart: null,
    quietEnd: null,
    channelConfigured: true,
    subscriptionCount: 1,
  },
  connectors: [{
    connectorInstanceId: 'github-work',
    connectorType: 'github-issues',
    connectorName: 'GitHub Work',
    enabled: true,
    deletedAt: null,
    wildcardOverride: null,
    notificationTypes: [{
      definition: {
        key: 'pr_review_requested',
        label: 'Review requested',
        description: 'A pull request needs your review.',
        defaultLevel: 'action_needed',
        pushEligible: true,
        pushRecommendation: 'off',
        sensitivity: 'sensitive',
        defaultPreview: 'title_only',
      },
      override: null,
      effective: {
        enabled: false,
        minLevel: 'action_needed',
        preview: 'title_only',
        maxPerHour: null,
        source: 'connector',
        sourceDetail: 'recommended',
      },
    }],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  pushMocks.subscribe.mockResolvedValue(true);
});

describe('connector push rules settings', () => {
  it('distinguishes inherited values and saves an explicit override', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => response,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rule: {} }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => response,
      });
    vi.stubGlobal('fetch', fetchMock);
    render(<ConnectorPushRules />);

    expect(await screen.findByRole('group', { name: 'Review requested' }))
      .toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();

    const fieldset = screen.getByRole('group', { name: 'Review requested' });
    fireEvent.click(within(fieldset).getByRole('switch', {
      name: 'Review requested push delivery',
    }));
    fireEvent.click(within(fieldset).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/push/rules',
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"enabled":true'),
      }),
    ));
  });

  it('keeps rules editable while prompting for a browser subscription', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...response,
        global: { ...response.global, subscriptionCount: 0 },
      }),
    })));
    render(<ConnectorPushRules />);

    expect(await screen.findByText(/Configure rules now/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Enable browser push' })).toBeEnabled();
    expect(screen.getByRole('switch', {
      name: 'Review requested push delivery',
    })).toBeEnabled();
  });

  it('shows channel and connector unavailable states without enabling deleted controls', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({
        global: { ...response.global, channelConfigured: false },
        connectors: [{
          ...response.connectors[0],
          deletedAt: '2026-09-12T01:00:00.000Z',
        }],
      }),
    })));
    render(<ConnectorPushRules />);

    expect(await screen.findByText(/Web Push is not configured/)).toBeInTheDocument();
    expect(screen.getByText(/Deleted connectors keep their rules/)).toBeInTheDocument();
    expect(screen.getByRole('switch', {
      name: 'Review requested push delivery',
    })).toBeDisabled();
  });

  it('renders a recoverable load error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false })));
    render(<ConnectorPushRules />);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Connector push rules could not be loaded.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
