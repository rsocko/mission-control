'use client';

import { CloudOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useOfflineQueue } from '@/lib/hooks/useOfflineQueue';

/**
 * Shows a compact indicator when there are offline captures waiting to sync.
 * Displays count + sync button. Auto-hides when queue is empty.
 */
export function PendingSyncIndicator() {
  const { pending, hasPending, isSyncing, sync, discard } = useOfflineQueue();
  const failedCapture = pending.find((capture) => capture.lastError);

  if (!hasPending) return null;

  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[var(--warning-subtle,rgba(234,179,8,0.1))] border border-[var(--warning,#eab308)]/30 text-xs text-[var(--warning,#eab308)]">
      <CloudOff size={14} />
      <span>
        {failedCapture
          ? `Sync failed: ${failedCapture.lastError}`
          : `${pending.length} pending ${pending.length === 1 ? 'capture' : 'captures'}`}
      </span>
      <button
        onClick={sync}
        disabled={isSyncing || !navigator.onLine}
        className="ml-1 p-1 rounded hover:bg-[var(--warning)]/10 disabled:opacity-50 transition-colors"
        aria-label="Sync pending captures"
        title={navigator.onLine ? 'Sync now' : 'Waiting for connection'}
      >
        {isSyncing ? (
          <Loader2 size={12} className="animate-spin" />
        ) : (
          <RefreshCw size={12} />
        )}
      </button>
      {failedCapture && (
        <button
          onClick={() => void discard(failedCapture.id)}
          disabled={isSyncing}
          className="p-1 rounded hover:bg-[var(--warning)]/10 disabled:opacity-50 transition-colors"
          aria-label="Discard failed capture"
          title="Discard failed capture"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}
