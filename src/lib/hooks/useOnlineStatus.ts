'use client';

import { useCallback, useEffect, useSyncExternalStore } from 'react';

/**
 * Subscribes to the browser's online/offline events and returns
 * a reactive boolean indicating current connectivity.
 *
 * Uses useSyncExternalStore for tear-free reads — safe for
 * concurrent React rendering.
 */

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener('online', onStoreChange);
  window.addEventListener('offline', onStoreChange);
  return () => {
    window.removeEventListener('online', onStoreChange);
    window.removeEventListener('offline', onStoreChange);
  };
}

function getSnapshot(): boolean {
  return navigator.onLine;
}

function getServerSnapshot(): boolean {
  // SSR: assume online
  return true;
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * Fires a callback when the browser transitions from offline → online.
 * Useful for triggering queue flushes on reconnect.
 */
export function useOnReconnect(callback: () => void): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableCallback = useCallback(callback, [callback]);

  useEffect(() => {
    const handler = () => stableCallback();
    window.addEventListener('online', handler);
    return () => window.removeEventListener('online', handler);
  }, [stableCallback]);
}
