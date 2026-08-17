'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EMPTY_NAVIGATION_COUNTS,
  NAV_BADGE_KEYS,
  NAVIGATION_COUNTS_REFRESH_EVENT,
  type NavBadgeKey,
  type NavigationCounts,
} from '@/lib/navigation/badges';

const STORAGE_KEY = 'mission-control:navigation-badges:v1';
const LEGACY_VISIBLE_KEY = 'mission-control:nav-badges-visible';
const PREFERENCES_EVENT = 'mission-control:navigation-badge-preferences';
const REFRESH_EVENTS = [
  NAVIGATION_COUNTS_REFRESH_EVENT,
  'mission-control:sync-complete',
  'mission-control:task-added',
  'mission-control:my-day-item-added',
  'mc:task-completed',
] as const;

export interface NavigationBadgePreferences {
  enabled: boolean;
  items: Record<NavBadgeKey, boolean>;
}

export const DEFAULT_NAVIGATION_BADGE_PREFERENCES: NavigationBadgePreferences = {
  enabled: true,
  items: {
    myDay: true,
    notifications: true,
    triage: true,
    quickSort: true,
    reconciliation: true,
  },
};

function readPreferences(): NavigationBadgePreferences {
  if (typeof window === 'undefined') return DEFAULT_NAVIGATION_BADGE_PREFERENCES;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<NavigationBadgePreferences>;
      const storedItems: Partial<Record<NavBadgeKey, boolean>> = parsed.items ?? {};
      return {
        enabled: parsed.enabled !== false,
        items: Object.fromEntries(
          NAV_BADGE_KEYS.map((key) => [key, storedItems[key] !== false]),
        ) as Record<NavBadgeKey, boolean>,
      };
    }
  } catch {
    // Ignore malformed local preferences and restore safe defaults.
  }

  return {
    ...DEFAULT_NAVIGATION_BADGE_PREFERENCES,
    enabled: localStorage.getItem(LEGACY_VISIBLE_KEY) !== 'false',
  };
}

function getPreferencesSnapshot(): string {
  return JSON.stringify(readPreferences());
}

function subscribePreferences(callback: () => void) {
  window.addEventListener(PREFERENCES_EVENT, callback);
  window.addEventListener('storage', callback);
  return () => {
    window.removeEventListener(PREFERENCES_EVENT, callback);
    window.removeEventListener('storage', callback);
  };
}

export function setNavigationBadgePreferences(preferences: NavigationBadgePreferences) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences));
  localStorage.setItem(LEGACY_VISIBLE_KEY, String(preferences.enabled));
  window.dispatchEvent(new Event(PREFERENCES_EVENT));
}

export function useNavigationBadgePreferences() {
  const serialized = useSyncExternalStore(
    subscribePreferences,
    getPreferencesSnapshot,
    () => JSON.stringify(DEFAULT_NAVIGATION_BADGE_PREFERENCES),
  );
  const preferences = useMemo(
    () => JSON.parse(serialized) as NavigationBadgePreferences,
    [serialized],
  );

  const setEnabled = (enabled: boolean) => {
    setNavigationBadgePreferences({ ...preferences, enabled });
  };
  const setItemEnabled = (key: NavBadgeKey, enabled: boolean) => {
    setNavigationBadgePreferences({
      ...preferences,
      items: { ...preferences.items, [key]: enabled },
    });
  };

  return { preferences, setEnabled, setItemEnabled };
}

async function fetchNavigationCounts(): Promise<NavigationCounts> {
  const response = await fetch('/api/navigation/counts');
  if (!response.ok) throw new Error(`Navigation counts HTTP ${response.status}`);
  return response.json();
}

export const navigationCountKeys = {
  all: ['navigation-counts'] as const,
};

export function useNavigationCounts() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: navigationCountKeys.all,
    queryFn: fetchNavigationCounts,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });

  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: navigationCountKeys.all });
    };
    for (const eventName of REFRESH_EVENTS) {
      window.addEventListener(eventName, refresh);
    }
    return () => {
      for (const eventName of REFRESH_EVENTS) {
        window.removeEventListener(eventName, refresh);
      }
    };
  }, [queryClient]);

  return query.data ?? EMPTY_NAVIGATION_COUNTS;
}
