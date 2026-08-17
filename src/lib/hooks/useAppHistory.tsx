'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  appHistoryBack,
  appHistoryForward,
  getAppHistorySnapshot,
  installAppHistory,
  subscribeToAppHistory,
  type AppHistorySnapshot,
} from '@/lib/navigation/app-history';

interface AppHistoryContextValue extends AppHistorySnapshot {
  back: () => void;
  forward: () => void;
}

const EMPTY_SNAPSHOT: AppHistorySnapshot = {
  canGoBack: false,
  canGoForward: false,
  position: 0,
  maxPosition: 0,
};

const AppHistoryContext = createContext<AppHistoryContextValue | null>(null);

export function AppHistoryProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => installAppHistory(), []);

  const snapshot = useSyncExternalStore(
    subscribeToAppHistory,
    getAppHistorySnapshot,
    () => EMPTY_SNAPSHOT,
  );
  const back = useCallback(() => appHistoryBack(), []);
  const forward = useCallback(() => appHistoryForward(), []);
  const value = useMemo(
    () => ({ ...snapshot, back, forward }),
    [back, forward, snapshot],
  );

  return (
    <AppHistoryContext.Provider value={value}>
      {children}
    </AppHistoryContext.Provider>
  );
}

export function useAppHistory(): AppHistoryContextValue {
  const value = useContext(AppHistoryContext);
  if (!value) {
    throw new Error('useAppHistory must be used within AppHistoryProvider');
  }
  return value;
}
