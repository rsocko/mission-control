'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';

// --- Badge mode setting (persisted in localStorage) ---

export type BadgeMode = 'unread_notifications' | 'myday_incomplete' | 'overdue' | 'off';

const BADGE_MODE_KEY = 'mission-control:badge-mode';
const DEFAULT_BADGE_MODE: BadgeMode = 'unread_notifications';

const listeners = new Set<() => void>();

function getBadgeModeSnapshot(): BadgeMode {
  if (typeof window === 'undefined') return DEFAULT_BADGE_MODE;
  const stored = localStorage.getItem(BADGE_MODE_KEY);
  if (stored === 'unread_alerts') {
    return 'unread_notifications';
  }
  if (stored === 'unread_notifications' || stored === 'myday_incomplete' || stored === 'overdue' || stored === 'off') {
    return stored;
  }
  return DEFAULT_BADGE_MODE;
}

function subscribe(callback: () => void) {
  listeners.add(callback);
  return () => { listeners.delete(callback); };
}

export function setBadgeMode(mode: BadgeMode) {
  localStorage.setItem(BADGE_MODE_KEY, mode);
  listeners.forEach((cb) => cb());
}

export function useBadgeMode(): [BadgeMode, (mode: BadgeMode) => void] {
  const mode = useSyncExternalStore(subscribe, getBadgeModeSnapshot, () => DEFAULT_BADGE_MODE);
  return [mode, setBadgeMode];
}

// --- Badge count setter ---

/**
 * Sets the app badge count on the OS taskbar icon (Windows, macOS, etc.)
 * using the Badging API. Falls back silently when the API is unavailable
 * (e.g. app not installed as PWA, or browser doesn't support it).
 */
export function useAppBadge(count: number) {
  const lastCount = useRef<number | null>(null);

  useEffect(() => {
    // Only update when count actually changes
    if (lastCount.current === count) return;
    lastCount.current = count;

    if (!('setAppBadge' in navigator)) return;

    try {
      if (count > 0) {
        navigator.setAppBadge(count);
      } else {
        navigator.clearAppBadge();
      }
    } catch {
      // Silently ignore — badge API may not be available in current context
    }
  }, [count]);
}
