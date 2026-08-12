'use client';

import React, { useEffect, useState, useCallback } from 'react';
import {
  HardDrive, Trash2, RefreshCw, Loader2, AlertTriangle,
  Image as ImageIcon, Database, CheckCircle2,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { toast } from 'sonner';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

interface StorageStats {
  items: {
    byStatus: Record<string, number>;
    bySource: Record<string, number>;
    withCachedThumbnail: number;
    withExternalThumbnail: number;
  };
  cache: {
    fileCount: number;
    totalBytes: number;
    totalMB: number;
  };
}

const SOURCE_LABELS: Record<string, string> = {
  reddit: 'Reddit',
  youtube: 'YouTube',
  instagram: 'Instagram',
  facebook: 'Facebook',
  github: 'GitHub',
  twitter: 'Twitter/X',
  tiktok: 'TikTok',
  pinterest: 'Pinterest',
  ios_share: 'iOS Share',
  android_share: 'Android Share',
  browser_extension: 'Browser Extension',
  scout: 'Scout',
  web: 'Web',
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] || source.charAt(0).toUpperCase() + source.slice(1).replace(/_/g, ' ');
}

export function StorageSection() {
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    action: string;
    label: string;
    description: string;
    extraBody?: Record<string, unknown>;
    doubleConfirm?: boolean;
  } | null>(null);
  const [doubleConfirmText, setDoubleConfirmText] = useState('');
  const [retentionDays, setRetentionDays] = useState(90);
  const [deleteSource, setDeleteSource] = useState('');
  const [includeActioned, setIncludeActioned] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/triage/storage');
      if (res.ok) {
        setStats(await res.json());
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchStats(); }, [fetchStats]);

  const runAction = async (action: string, extraBody?: Record<string, unknown>) => {
    setActionPending(action);
    try {
      const res = await fetch('/api/triage/storage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ...extraBody }),
      });
      const data = await res.json();
      if (res.ok) {
        const sourceLabel = formatSourceLabel(data.source || '');
        const preserveNote = action === 'delete_by_source' && !data.includeActioned
          ? ' (actioned/collected preserved)'
          : '';
        const messages: Record<string, string> = {
          purge_dismissed: `Purged ${data.purged ?? 0} dismissed items`,
          cleanup_orphans: `Removed ${data.removed ?? 0} orphaned files`,
          clear_expired: `Cleared ${data.cleared ?? 0} expired URLs`,
          delete_by_source: `Deleted ${data.deleted ?? 0} ${sourceLabel} items${preserveNote}`,
        };
        toast.success(messages[action] || 'Action completed');
        fetchStats();
      } else {
        toast.error(data.error || 'Action failed');
      }
    } catch {
      toast.error('Network error');
    }
    setActionPending(null);
    setConfirmAction(null);
    setDoubleConfirmText('');
  };

  const totalItems = stats ? Object.values(stats.items.byStatus).reduce((a, b) => a + b, 0) : 0;
  const availableSources = stats
    ? Object.entries(stats.items.bySource).filter(([source, count]) => source.trim() && count > 0)
    : [];

  const handleDeleteBySource = () => {
    if (!deleteSource) {
      toast.error('Select a source to clear');
      return;
    }
    const label = formatSourceLabel(deleteSource);
    const count = stats?.items.bySource[deleteSource] ?? 0;
    const scope = includeActioned ? 'ALL' : 'pending and dismissed';
    setConfirmAction({
      action: 'delete_by_source',
      label: `Delete ${label} Items`,
      description: includeActioned
        ? `Permanently delete ALL ${count.toLocaleString()} ${label} items (including actioned/collected) and their cached thumbnails. This is a full reset. This cannot be undone. Type "${label}" to confirm.`
        : `Delete ${scope} ${label} items and their cached thumbnails. Actioned and collected items will be preserved. Type "${label}" to confirm.`,
      extraBody: { source: deleteSource, includeActioned },
      doubleConfirm: true,
    });
  };

  const isDoubleConfirmValid = confirmAction?.doubleConfirm
    ? doubleConfirmText.toLowerCase() === formatSourceLabel(deleteSource).toLowerCase()
    : true;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Storage & Cache</h3>
        <p className="mt-1 text-sm text-[var(--text-secondary)]">
          Manage thumbnail cache, data retention, and cleanup for the triage queue.
        </p>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Loading storage stats…
        </div>
      ) : stats ? (
        <>
          {/* Stats cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <Database size={14} />
                Total Items
              </div>
              <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">{totalItems.toLocaleString()}</div>
              <div className="mt-2 space-y-1 text-xs text-[var(--text-tertiary)]">
                <div>Pending: {stats.items.byStatus.pending ?? 0}</div>
                <div>Actioned: {stats.items.byStatus.actioned ?? 0}</div>
                <div>Dismissed: {stats.items.byStatus.dismissed ?? 0}</div>
                <div>Collected: {stats.items.byStatus.collected ?? 0}</div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <ImageIcon size={14} />
                Thumbnail Cache
              </div>
              <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">
                {formatBytes(stats.cache.totalBytes)}
              </div>
              <div className="mt-2 space-y-1 text-xs text-[var(--text-tertiary)]">
                <div>Cached files: {stats.cache.fileCount}</div>
                <div>DB refs to cache: {stats.items.withCachedThumbnail}</div>
                <div className="text-amber-400">
                  Expired/external URLs: {stats.items.withExternalThumbnail}
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
                <HardDrive size={14} />
                Data Health
              </div>
              <div className="mt-1 text-2xl font-bold text-[var(--text-primary)]">
                {stats.items.withExternalThumbnail === 0 ? (
                  <span className="flex items-center gap-1 text-green-400">
                    <CheckCircle2 size={20} /> Healthy
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-amber-400">
                    <AlertTriangle size={20} /> {stats.items.withExternalThumbnail} expired
                  </span>
                )}
              </div>
              <div className="mt-2 text-xs text-[var(--text-tertiary)]">
                Items with external thumbnail URLs will show embed fallback until re-imported.
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="space-y-3">
            <h4 className="text-sm font-semibold text-[var(--text-secondary)]">Maintenance Actions</h4>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setConfirmAction({
                  action: 'purge_dismissed',
                  label: 'Purge Dismissed Items',
                  description: `Permanently delete all dismissed items older than ${retentionDays} days and their cached thumbnails. Actioned and collected items are preserved.`,
                  extraBody: { retentionDays },
                })}
                disabled={!!actionPending}
                className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
              >
                {actionPending === 'purge_dismissed' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                Purge dismissed ({retentionDays}d+)
              </button>

              <button
                type="button"
                onClick={() => runAction('cleanup_orphans')}
                disabled={!!actionPending}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-3)] disabled:opacity-50"
              >
                {actionPending === 'cleanup_orphans' ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                Clean orphaned files
              </button>

              <button
                type="button"
                onClick={() => setConfirmAction({
                  action: 'clear_expired',
                  label: 'Clear Expired URLs',
                  description: 'Remove all external (non-cached) thumbnail URLs from the database. Items will fall back to the embed-based preview until re-imported with fresh URLs.',
                })}
                disabled={!!actionPending}
                className="inline-flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm font-medium text-amber-300 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
              >
                {actionPending === 'clear_expired' ? <Loader2 size={14} className="animate-spin" /> : <AlertTriangle size={14} />}
                Clear expired URLs ({stats.items.withExternalThumbnail})
              </button>
            </div>

            {/* Retention setting */}
            <div className="mt-4 flex items-center gap-3">
              <label className="text-sm text-[var(--text-secondary)]">Retention period for dismissed items:</label>
              <Select value={String(retentionDays)} onValueChange={(value) => setRetentionDays(Number(value))}>
                <SelectTrigger variant="inline" aria-label="Dismissed item retention period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="30">30 days</SelectItem>
                  <SelectItem value="60">60 days</SelectItem>
                  <SelectItem value="90">90 days (default)</SelectItem>
                  <SelectItem value="180">180 days</SelectItem>
                  <SelectItem value="365">1 year</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Clear by source — Issue #455 */}
          <div className="space-y-3 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
            <h4 className="text-sm font-semibold text-red-300">Clear Items by Source</h4>
            <p className="text-xs text-[var(--text-tertiary)]">
              Delete items from a specific source platform and their cached thumbnails.
              By default, actioned and collected items are preserved. Useful for a clean re-import.
            </p>

            {availableSources.length === 0 ? (
              <p className="text-xs text-[var(--text-muted)]">No items in the triage queue.</p>
            ) : (
              <div className="space-y-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="flex-1 min-w-[200px]">
                    <label className="mb-1 block text-xs text-[var(--text-secondary)]">Source platform</label>
                    <Select value={deleteSource} onValueChange={setDeleteSource}>
                      <SelectTrigger aria-label="Source platform" className="h-9 min-h-0 w-full">
                        <SelectValue placeholder="Select a source..." />
                      </SelectTrigger>
                      <SelectContent>
                      {availableSources.map(([source, count]) => (
                          <SelectItem key={source} value={source}>
                          {formatSourceLabel(source)} ({count.toLocaleString()} items)
                          </SelectItem>
                      ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <button
                    type="button"
                    onClick={handleDeleteBySource}
                    disabled={!!actionPending || !deleteSource}
                    className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                  >
                    {actionPending === 'delete_by_source' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
                    Delete items
                  </button>
                </div>

                <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeActioned}
                    onChange={(e) => setIncludeActioned(e.target.checked)}
                    className="rounded border-[var(--border)] bg-[var(--surface-2)] text-red-500 focus:ring-red-500/30"
                  />
                  Include actioned &amp; collected items (full reset)
                </label>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="py-8 text-center text-sm text-[var(--text-muted)]">
          Failed to load storage stats. Check API configuration.
        </div>
      )}

      {/* Confirm dialog with optional double-confirmation */}
      {confirmAction && (
        <ConfirmDialog
          open={true}
          title={confirmAction.label}
          message={confirmAction.description}
          confirmLabel={confirmAction.doubleConfirm ? 'Delete permanently' : 'Confirm'}
          confirmVariant="danger"
          onConfirm={() => {
            if (confirmAction.doubleConfirm && !isDoubleConfirmValid) return;
            runAction(confirmAction.action, confirmAction.extraBody);
          }}
          onCancel={() => { setConfirmAction(null); setDoubleConfirmText(''); }}
        >
          {confirmAction.doubleConfirm && (
            <div className="mt-3">
              <label className="mb-1 block text-xs text-[var(--text-secondary)]">
                Type &quot;{formatSourceLabel(deleteSource)}&quot; to confirm:
              </label>
              <input
                type="text"
                value={doubleConfirmText}
                onChange={(e) => setDoubleConfirmText(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1.5 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
                placeholder={formatSourceLabel(deleteSource)}
                autoFocus
              />
              {doubleConfirmText.length > 0 && !isDoubleConfirmValid && (
                <p className="mt-1 text-xs text-red-400">
                  Text does not match. Type &quot;{formatSourceLabel(deleteSource)}&quot; exactly.
                </p>
              )}
            </div>
          )}
        </ConfirmDialog>
      )}
    </div>
  );
}
