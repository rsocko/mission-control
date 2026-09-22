'use client';

import { useCallback, useSyncExternalStore } from 'react';

export const SYNC_BANNER_PREFERENCE_KEY = 'show-sync-progress-banner';
export const DEFAULT_SYNC_BANNER_PREFERENCE = true;

const PREFERENCE_CHANGE_EVENT = 'mission-control:sync-banner-preference';
let inMemoryPreference: boolean | null = null;

export function getSyncBannerPreference() {
  if (typeof window === 'undefined') return DEFAULT_SYNC_BANNER_PREFERENCE;
  if (inMemoryPreference !== null) return inMemoryPreference;

  try {
    return window.localStorage.getItem(SYNC_BANNER_PREFERENCE_KEY) !== 'false';
  } catch {
    return DEFAULT_SYNC_BANNER_PREFERENCE;
  }
}

export function saveSyncBannerPreference(showBanner: boolean) {
  inMemoryPreference = showBanner;
  try {
    window.localStorage.setItem(SYNC_BANNER_PREFERENCE_KEY, String(showBanner));
  } catch {
    // The in-memory preference still updates when browser storage is unavailable.
  }
  window.dispatchEvent(new Event(PREFERENCE_CHANGE_EVENT));
}

function subscribeToSyncBannerPreference(onStoreChange: () => void) {
  const handlePreferenceChange = () => onStoreChange();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === SYNC_BANNER_PREFERENCE_KEY) {
      inMemoryPreference = null;
      onStoreChange();
    }
  };

  window.addEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange);
  window.addEventListener('storage', handleStorage);
  return () => {
    window.removeEventListener(PREFERENCE_CHANGE_EVENT, handlePreferenceChange);
    window.removeEventListener('storage', handleStorage);
  };
}

export function useSyncBannerPreference() {
  const showBanner = useSyncExternalStore(
    subscribeToSyncBannerPreference,
    getSyncBannerPreference,
    () => DEFAULT_SYNC_BANNER_PREFERENCE,
  );

  const setShowBanner = useCallback((next: boolean) => {
    saveSyncBannerPreference(next);
  }, []);

  return { showBanner, setShowBanner };
}
