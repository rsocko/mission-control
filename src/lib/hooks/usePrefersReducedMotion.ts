'use client';

import { useSyncExternalStore } from 'react';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(callback: () => void) {
  const mediaQuery = window.matchMedia(REDUCED_MOTION_QUERY);
  const handleVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      callback();
    }
  };

  mediaQuery.addEventListener('change', callback);
  window.addEventListener('focus', callback);
  window.addEventListener('pageshow', callback);
  document.addEventListener('visibilitychange', handleVisibilityChange);

  return () => {
    mediaQuery.removeEventListener('change', callback);
    window.removeEventListener('focus', callback);
    window.removeEventListener('pageshow', callback);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
  };
}

function getSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
