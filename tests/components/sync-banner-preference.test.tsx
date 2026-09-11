import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SYNC_BANNER_PREFERENCE,
  SYNC_BANNER_PREFERENCE_KEY,
  useSyncBannerPreference,
} from '@/lib/hooks/useSyncBannerPreference';

afterEach(() => {
  act(() => {
    window.dispatchEvent(new StorageEvent('storage', {
      key: SYNC_BANNER_PREFERENCE_KEY,
    }));
  });
  localStorage.clear();
});

describe('useSyncBannerPreference', () => {
  it('shows the banner by default and persists updates', () => {
    const { result } = renderHook(() => useSyncBannerPreference());

    expect(result.current.showBanner).toBe(DEFAULT_SYNC_BANNER_PREFERENCE);

    act(() => result.current.setShowBanner(false));

    expect(result.current.showBanner).toBe(false);
    expect(localStorage.getItem(SYNC_BANNER_PREFERENCE_KEY)).toBe('false');
  });

  it('restores a hidden banner preference', () => {
    localStorage.setItem(SYNC_BANNER_PREFERENCE_KEY, 'false');

    const { result } = renderHook(() => useSyncBannerPreference());

    expect(result.current.showBanner).toBe(false);
  });
});
