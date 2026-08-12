'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  queueCapture,
  getPendingCaptures,
  syncPendingCaptures,
  requestBackgroundSync,
  getPendingActions,
  replayPendingActions,
  removePendingCapture,
  type PendingCapture,
  type PendingCaptureImage,
  type OfflineAction,
  type PendingCaptureDestination,
} from '@/lib/offline-queue';
import { useOnReconnect } from './useOnlineStatus';

export interface OfflineQueueState {
  /** Items waiting to be synced */
  pending: PendingCapture[];
  /** Generic actions waiting to be replayed */
  pendingActions: OfflineAction[];
  /** Total count of all pending items (captures + actions) */
  totalPendingCount: number;
  /** Whether there are items in the queue */
  hasPending: boolean;
  /** Whether a sync is currently in progress */
  isSyncing: boolean;
  /** Add an item to the offline queue */
  enqueue: (title: string, body?: string, destination?: PendingCaptureDestination) => Promise<void>;
  /** Add an image capture to the offline queue */
  enqueueImage: (
    title: string,
    body: string | undefined,
    image: PendingCaptureImage,
    id?: string,
  ) => Promise<void>;
  /** Manually trigger a sync attempt */
  sync: () => Promise<void>;
  /** Explicitly discard a pending capture */
  discard: (id: string) => Promise<void>;
}

export function useOfflineQueue(): OfflineQueueState {
  const [pending, setPending] = useState<PendingCapture[]>([]);
  const [pendingActions, setPendingActions] = useState<OfflineAction[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);

  const refreshPending = useCallback(async () => {
    try {
      const [captures, actions] = await Promise.all([
        getPendingCaptures(),
        getPendingActions(),
      ]);
      setPending(captures);
      setPendingActions(actions);
    } catch {
      // IndexedDB may not be available (e.g. SSR, private mode)
    }
  }, []);

  useEffect(() => {
    refreshPending();
  }, [refreshPending]);

  const discard = useCallback(async (id: string) => {
    await removePendingCapture(id);
    await refreshPending();
  }, [refreshPending]);

  // Listen for queue change events (from action queue operations)
  useEffect(() => {
    const handler = () => refreshPending();
    window.addEventListener('offline-queue:changed', handler);
    return () => window.removeEventListener('offline-queue:changed', handler);
  }, [refreshPending]);

  // Auto-sync on reconnect
  useOnReconnect(() => {
    void (async () => {
      setIsSyncing(true);
      try {
        await Promise.all([syncPendingCaptures(), replayPendingActions()]);
        await refreshPending();
      } finally {
        setIsSyncing(false);
      }
    })();
  });

  // Listen for a custom event dispatched by the SW after background sync
  useEffect(() => {
    const controller = navigator.serviceWorker;
    if (!controller) return;

    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'offline-sync-complete') {
        refreshPending();
      }
    };
    controller.addEventListener('message', handleMessage);
    return () => controller.removeEventListener('message', handleMessage);
  }, [refreshPending]);

  const enqueue = useCallback(async (
    title: string,
    body?: string,
    destination?: PendingCaptureDestination,
  ) => {
    await queueCapture(title, body, undefined, undefined, destination);
    await refreshPending();
    // Request background sync so the SW will retry even if the page closes
    await requestBackgroundSync();
  }, [refreshPending]);

  const enqueueImage = useCallback(async (
    title: string,
    body: string | undefined,
    image: PendingCaptureImage,
    id?: string,
  ) => {
    await queueCapture(title, body, image, id);
    await refreshPending();
    await requestBackgroundSync();
  }, [refreshPending]);

  const sync = useCallback(async () => {
    setIsSyncing(true);
    try {
      await Promise.all([syncPendingCaptures(), replayPendingActions()]);
      await refreshPending();
    } finally {
      setIsSyncing(false);
    }
  }, [refreshPending]);

  const totalPendingCount = pending.length + pendingActions.length;

  return {
    pending,
    pendingActions,
    totalPendingCount,
    hasPending: totalPendingCount > 0,
    isSyncing,
    enqueue,
    enqueueImage,
    sync,
    discard,
  };
}
