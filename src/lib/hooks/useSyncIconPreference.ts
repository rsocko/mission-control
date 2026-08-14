'use client';

import { useCallback, useSyncExternalStore } from 'react';

export type SyncIconVariant = 'alternating' | 'particles';
export type SyncIconPreference = SyncIconVariant | 'both';

export const SYNC_ICON_PREFERENCE_KEY = 'sync-icon-preference';
export const DEFAULT_SYNC_ICON_PREFERENCE: SyncIconPreference = 'both';

const PREFERENCE_CHANGE_EVENT = 'mission-control:sync-icon-preference';

function isSyncIconPreference(value: string | null): value is SyncIconPreference {
  return value === 'alternating' || value === 'particles' || value === 'both';
}

export function getSyncIconPreference(): SyncIconPreference {
  if (typeof window === 'undefined') return DEFAULT_SYNC_ICON_PREFERENCE;

  try {
    const stored = window.localStorage.getItem(SYNC_ICON_PREFERENCE_KEY);
    return isSyncIconPreference(stored) ? stored : DEFAULT_SYNC_ICON_PREFERENCE;
  } catch {
    return DEFAULT_SYNC_ICON_PREFERENCE;
  }
}

export function resolveSyncIconVariant(
  preference: SyncIconPreference,
  randomValue = Math.random(),
): SyncIconVariant {
  if (preference !== 'both') return preference;
  return randomValue < 0.5 ? 'alternating' : 'particles';
}

export function saveSyncIconPreference(preference: SyncIconPreference) {
  window.localStorage.setItem(SYNC_ICON_PREFERENCE_KEY, preference);
  window.dispatchEvent(new Event(PREFERENCE_CHANGE_EVENT));
}

function subscribeToSyncIconPreference(onStoreChange: () => void) {
  const handlePreferenceChange = () => onStoreChange();
  const handleStorage = (event: StorageEvent) => {
    if (event.key === SYNC_ICON_PREFERENCE_KEY) {
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

export function useSyncIconPreference() {
  const preference = useSyncExternalStore(
    subscribeToSyncIconPreference,
    getSyncIconPreference,
    () => DEFAULT_SYNC_ICON_PREFERENCE,
  );

  const setPreference = useCallback((next: SyncIconPreference) => {
    saveSyncIconPreference(next);
  }, []);

  return { preference, setPreference };
}
