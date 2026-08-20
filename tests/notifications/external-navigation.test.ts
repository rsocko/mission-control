import { afterEach, describe, expect, it, vi } from 'vitest';

const bridgeMocks = vi.hoisted(() => ({
  get: vi.fn(),
  request: vi.fn(),
}));

vi.mock('@/lib/native/bridge', () => ({
  getMCNativeBridge: bridgeMocks.get,
  requestMCNativeBridge: bridgeMocks.request,
}));

import {
  completeExternalNavigation,
  prepareExternalNavigation,
} from '@/lib/notifications/external-navigation';

describe('external notification navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    bridgeMocks.get.mockReset();
    bridgeMocks.request.mockReset();
  });

  it('falls back to current-window navigation when a popup is blocked', async () => {
    bridgeMocks.get.mockReturnValue(null);
    vi.spyOn(window, 'open').mockReturnValue(null);
    const navigateCurrentWindow = vi.fn();

    const popup = prepareExternalNavigation(true);
    await completeExternalNavigation(
      popup,
      'https://example.test/review',
      navigateCurrentWindow,
    );

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(navigateCurrentWindow).toHaveBeenCalledWith('https://example.test/review');
  });

  it('uses the native host to open external links outside Mission Control', async () => {
    bridgeMocks.get.mockReturnValue({
      capabilities: ['externalLinks'],
      supportedActions: ['openURL'],
    });
    bridgeMocks.request.mockResolvedValue({
      ok: true,
      result: { opened: true },
    });
    const open = vi.spyOn(window, 'open');

    const popup = prepareExternalNavigation(true);
    await completeExternalNavigation(popup, 'https://github.com/acme/repo/pull/42');

    expect(open).not.toHaveBeenCalled();
    expect(bridgeMocks.request).toHaveBeenCalledWith({
      action: 'openURL',
      configuredOrigin: window.location.origin,
      payload: { url: 'https://github.com/acme/repo/pull/42' },
      windowObject: window,
    });
  });

  it('does not navigate inside Mission Control when the native host cannot open the link', async () => {
    bridgeMocks.get.mockReturnValue({
      capabilities: ['externalLinks'],
      supportedActions: ['openURL'],
    });
    bridgeMocks.request.mockResolvedValue({
      ok: true,
      result: { opened: false },
    });
    const navigateCurrentWindow = vi.fn();

    await expect(completeExternalNavigation(
      null,
      'https://github.com/acme/repo/pull/42',
      navigateCurrentWindow,
    )).rejects.toThrow('Native host did not open the URL');

    expect(navigateCurrentWindow).not.toHaveBeenCalled();
  });
});
