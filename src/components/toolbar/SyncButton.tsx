'use client';

import { RefreshCw } from 'lucide-react';
import { useSyncStream } from '@/lib/hooks/useSyncStream';

export function SyncButton() {
  const { progress, triggerSync } = useSyncStream();
  const syncing = progress.isSyncing;

  return (
    <button
      onClick={triggerSync}
      disabled={syncing}
      aria-label={syncing ? 'Syncing sources…' : 'Sync all sources now'}
      className="flex items-center gap-1.5 p-2 text-xs font-medium text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors duration-[var(--transition-fast)] disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
    >
      <RefreshCw size={16} className={syncing ? 'animate-spin' : ''} aria-hidden="true" />
      <span className="hidden xl:inline">Sync</span>
    </button>
  );
}
