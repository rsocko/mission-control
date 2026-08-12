'use client';

import { useState, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'nav-rail-pinned';

export function useNavRailPrefs() {
  const [pinned, setPinnedState] = useState(false);

  // Hydrate from localStorage after mount to avoid SSR mismatch
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === 'true') setPinnedState(true);
    } catch {
      // localStorage unavailable
    }
  }, []);

  const setPinned = useCallback((value: boolean) => {
    setPinnedState(value);
    try {
      localStorage.setItem(STORAGE_KEY, String(value));
    } catch {
      // localStorage unavailable
    }
  }, []);

  const togglePinned = useCallback(() => {
    setPinnedState(prev => {
      const next = !prev;
      try { localStorage.setItem(STORAGE_KEY, String(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  return { pinned, setPinned, togglePinned };
}
