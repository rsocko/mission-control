'use client';

import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';
import { useSyncStream } from '@/lib/hooks/useSyncStream';
import type { SyncStatus } from '@/components/triage/types';

function formatSyncAge(isoDate: string | null): string {
  if (!isoDate) return 'never';
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function statusColor(isoDate: string | null): string {
  if (!isoDate) return 'text-slate-500';
  const hours = (Date.now() - new Date(isoDate).getTime()) / 3600000;
  if (hours < 1) return 'text-emerald-400';
  if (hours < 12) return 'text-emerald-400';
  if (hours < 24) return 'text-amber-400';
  return 'text-red-400';
}

/** Collapsed dot color — mirrors statusColor but returns bg- classes */
function staleDotColor(isoDate: string | null): string {
  if (!isoDate) return 'bg-slate-500';
  const hours = (Date.now() - new Date(isoDate).getTime()) / 3600000;
  if (hours < 12) return 'bg-emerald-400';
  if (hours < 24) return 'bg-amber-400';
  return 'bg-red-400';
}

/** Determine worst-case freshness across all configured sources */
function overallStaleness(entries: Array<{ lastSynced: string | null }>): string | null {
  if (entries.length === 0) return null;
  let oldest: string | null = null;
  for (const e of entries) {
    if (!e.lastSynced) return null; // never synced = worst
    if (!oldest || e.lastSynced < oldest) oldest = e.lastSynced;
  }
  return oldest;
}

const SOURCE_DISPLAY: Record<string, { label: string; platform: string }> = {
  'github-stars': { label: 'GitHub', platform: 'github' },
  'reddit-saved': { label: 'Reddit', platform: 'reddit' },
  'youtube': { label: 'YouTube', platform: 'youtube' },
  'twitter-archive': { label: 'X / Twitter', platform: 'twitter' },
};

export default function TriageSyncStatus() {
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const { progress, triggerSync } = useSyncStream();

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/triage/sync-status');
      if (!res.ok) return;
      const data = await res.json();
      setSyncStatus(data);
    } catch {
      // silent
    }
  }, []);

  // Initial fetch
  useEffect(() => { fetchStatus(); }, [fetchStatus]);

  // Re-fetch when sync completes (refetchKey changes)
  useEffect(() => {
    if (progress.refetchKey > 0) {
      fetchStatus();
    }
  }, [progress.refetchKey, fetchStatus]);

  if (!syncStatus) return null;

  const entries = Object.entries(syncStatus.sources)
    .filter(([, state]) => state.configured)
    .map(([key, state]) => {
      const display = SOURCE_DISPLAY[key];
      const lastSynced = state.syncState?.lastSyncedAt ?? null;
      return { key, label: display?.label ?? key, platform: display?.platform ?? 'web', lastSynced };
    });

  if (entries.length === 0) return null;

  const oldestDate = overallStaleness(entries);
  const dotColor = progress.isSyncing ? 'bg-[var(--accent-400)]' : staleDotColor(oldestDate);

  return (
    <div className="border-t border-[var(--border)] pt-3 mt-3">
      {/* Clickable collapsed/expanded header */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center justify-between w-full px-2 mb-2 group"
      >
        <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-[var(--text-muted)]">
          <span
            className={cn(
              'inline-block w-2 h-2 rounded-full shrink-0 transition-colors',
              dotColor,
              progress.isSyncing && 'animate-pulse',
            )}
          />
          {progress.isSyncing ? 'Syncing…' : 'Source Sync'}
        </span>
        <span className="text-[var(--text-muted)] text-xs transition-transform group-hover:text-[var(--accent-400)]">
          {expanded ? '▾' : '▸'}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <>
          <div className="space-y-1 px-2">
            {entries.map((entry) => (
              <div key={entry.key} className="flex items-center gap-2 text-xs">
                <TriageSourceIcon source={entry.platform} size={13} className="shrink-0" decorative />
                <span className="flex-1 text-[var(--text-secondary)]">{entry.label}</span>
                <span className={cn('text-xs tabular-nums', statusColor(entry.lastSynced))}>
                  • {formatSyncAge(entry.lastSynced)}
                </span>
              </div>
            ))}
          </div>
          <div className="flex items-center gap-2 px-2 mt-2">
            <button
              type="button"
              onClick={triggerSync}
              disabled={progress.isSyncing}
              className="flex items-center gap-1 text-xs text-[var(--text-muted)] hover:text-[var(--accent-400)] transition-colors disabled:opacity-50"
              title="Sync all sources now"
            >
              <RefreshCw size={11} className={progress.isSyncing ? 'animate-spin' : ''} />
              <span>{progress.isSyncing ? 'Syncing…' : 'Sync now'}</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
