import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  completeExternalNavigation,
  prepareExternalNavigation,
} from '@/lib/notifications/external-navigation';

describe('external notification navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to current-window navigation when a popup is blocked', () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const navigateCurrentWindow = vi.fn();

    const popup = prepareExternalNavigation(true);
    completeExternalNavigation(
      popup,
      'https://example.test/review',
      navigateCurrentWindow,
    );

    expect(window.open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(navigateCurrentWindow).toHaveBeenCalledWith('https://example.test/review');
  });
});
