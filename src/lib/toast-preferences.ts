import { useEffect, useState } from 'react';
import { settingsLogger } from '@/lib/client-logger';

export interface ToastPreferences {
  desktopPosition: 'bottom-left' | 'top-right';
  mode: 'all' | 'errors-only';
  mutedUntil: number;
}

export const TOAST_PREFERENCES_KEY = 'mc:toast-preferences';
export const TOAST_PREFERENCES_EVENT = 'mission-control:toast-preferences-changed';
export const DEFAULT_TOAST_PREFERENCES: ToastPreferences = {
  desktopPosition: 'bottom-left',
  mode: 'all',
  mutedUntil: 0,
};

export function getToastPreferences(): ToastPreferences {
  if (typeof window === 'undefined') return DEFAULT_TOAST_PREFERENCES;
  try {
    const raw = localStorage.getItem(TOAST_PREFERENCES_KEY);
    if (!raw) return DEFAULT_TOAST_PREFERENCES;
    const value: unknown = JSON.parse(raw);
    if (
      !value || typeof value !== 'object' ||
      !('desktopPosition' in value) ||
      (value.desktopPosition !== 'bottom-left' && value.desktopPosition !== 'top-right') ||
      !('mode' in value) || (value.mode !== 'all' && value.mode !== 'errors-only') ||
      !('mutedUntil' in value) || typeof value.mutedUntil !== 'number' ||
      !Number.isFinite(value.mutedUntil) || value.mutedUntil < 0
    ) {
      throw new Error('Invalid toast preferences');
    }
    return {
      desktopPosition: value.desktopPosition,
      mode: value.mode,
      mutedUntil: value.mutedUntil,
    };
  } catch (error) {
    settingsLogger.warn('Unable to read toast preferences; using defaults', { error });
    return DEFAULT_TOAST_PREFERENCES;
  }
}

export function setToastPreferences(updates: Partial<ToastPreferences>): void {
  const next = { ...getToastPreferences(), ...updates };
  localStorage.setItem(TOAST_PREFERENCES_KEY, JSON.stringify(next));
  window.dispatchEvent(new Event(TOAST_PREFERENCES_EVENT));
}

export function useToastPreferences() {
  const [preferences, setPreferences] = useState(DEFAULT_TOAST_PREFERENCES);
  useEffect(() => {
    const refresh = () => setPreferences(getToastPreferences());
    const onStorage = (event: StorageEvent) => {
      if (event.key === TOAST_PREFERENCES_KEY || event.key === null) refresh();
    };
    refresh();
    window.addEventListener(TOAST_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TOAST_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const [now, setNow] = useState(0);
  useEffect(() => {
    setNow(Date.now());
    const remaining = preferences.mutedUntil - Date.now();
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(remaining, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [preferences.mutedUntil]);
  return { preferences, muted: preferences.mutedUntil > now && now > 0 };
}
