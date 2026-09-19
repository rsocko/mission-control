'use client';

import { createContext, useContext, useEffect } from 'react';
import { registerOfflineTaskActionHandlers } from '@/lib/offline-task-actions';
import { useOfflineQueue } from '@/lib/hooks/useOfflineQueue';
import {
  useMissionControlConnectivity,
  type MissionControlConnectivity,
} from '@/lib/hooks/useMissionControlConnectivity';

const OfflineConnectivityContext = createContext<MissionControlConnectivity>('checking');

export function useOfflineConnectivity(): MissionControlConnectivity {
  return useContext(OfflineConnectivityContext);
}

export function OfflineSyncProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => registerOfflineTaskActionHandlers(), []);
  const connectivity = useMissionControlConnectivity();
  const { sync } = useOfflineQueue();

  useEffect(() => {
    if (connectivity === 'online') void sync();
  }, [connectivity, sync]);

  return (
    <OfflineConnectivityContext.Provider value={connectivity}>
      {children}
    </OfflineConnectivityContext.Provider>
  );
}
