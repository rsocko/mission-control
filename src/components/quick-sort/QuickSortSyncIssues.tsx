'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';

interface SyncHistoryDetail {
  action?: string;
  taskId?: string;
  taskTitle?: string;
  reason?: string;
}

interface SyncHistoryEntry {
  id?: string;
  syncedAt?: string;
  details?: SyncHistoryDetail[];
}

export interface QuickSortSyncIssue {
  id: string;
  taskId: string | null;
  taskTitle: string;
  reason: string;
  occurredAt: string;
}

const RECENT_ISSUE_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_MS = 60 * 1000;
const POST_ACTION_REFRESH_MS = 3 * 1000;

export function extractQuickSortSyncIssues(
  history: SyncHistoryEntry[],
  now = Date.now(),
): QuickSortSyncIssue[] {
  const cutoff = now - RECENT_ISSUE_MS;
  const issues = history.flatMap((entry) => {
    const occurredAt = entry.syncedAt;
    if (!occurredAt || Date.parse(occurredAt) < cutoff) return [];
    return (entry.details ?? []).flatMap((detail, detailIndex) => {
      if (detail.action !== 'push_failed' || !detail.taskTitle) return [];
      return [{
        id: `${entry.id ?? occurredAt}:${detailIndex}`,
        taskId: detail.taskId ?? null,
        taskTitle: detail.taskTitle,
        reason: detail.reason?.replace(/^Write-through failed:\s*/i, '')
          ?? 'The source rejected this update.',
        occurredAt,
      }];
    });
  });

  const latestByTask = new Map<string, QuickSortSyncIssue>();
  for (const issue of issues.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))) {
    const key = issue.taskId ?? issue.taskTitle;
    if (!latestByTask.has(key)) latestByTask.set(key, issue);
  }
  return [...latestByTask.values()].slice(0, 3);
}

function formatIssueTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(value));
}

export default function QuickSortSyncIssues({ refreshKey = 0 }: { refreshKey?: number }) {
  const [issues, setIssues] = useState<QuickSortSyncIssue[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/sync?result=errors&limit=20');
      if (!response.ok) return;
      const payload = await response.json() as { history?: SyncHistoryEntry[] };
      setIssues(extractQuickSortSyncIssues(payload.history ?? []));
    } catch {
      // Keep the last known issue state when the status endpoint is unavailable.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => void refresh(), 0);
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refresh]);

  useEffect(() => {
    if (refreshKey === 0) return;
    const postActionRefresh = window.setTimeout(
      () => void refresh(),
      POST_ACTION_REFRESH_MS,
    );
    return () => window.clearTimeout(postActionRefresh);
  }, [refresh, refreshKey]);

  if (issues.length === 0) return null;

  return (
    <aside
      className="mx-4 mb-3 flex-shrink-0 rounded-xl border border-amber-800/40 bg-amber-950/35 px-3 py-2.5 text-amber-100 lg:mx-6"
      aria-label="Recent source sync issues"
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} className="mt-0.5 flex-shrink-0 text-amber-300" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs font-semibold">
              {issues.length === 1 ? '1 recent update did not reach its source' : `${issues.length} recent updates did not reach their sources`}
            </p>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              className="flex min-h-7 min-w-7 items-center justify-center rounded-md text-amber-300 transition-colors hover:bg-amber-900/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 disabled:opacity-50"
              aria-label="Refresh sync issues"
            >
              <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
            </button>
          </div>
          <p className="mt-0.5 text-[11px] leading-4 text-amber-200/75">
            Mission Control kept the local change and will retry when possible.
          </p>
          <ul className="mt-2 space-y-1.5">
            {issues.map((issue) => (
              <li key={issue.id} className="flex min-w-0 items-start justify-between gap-3 text-xs">
                <div className="min-w-0">
                  <p className="truncate font-medium text-amber-50" title={issue.taskTitle}>
                    {issue.taskTitle}
                  </p>
                  <p className="line-clamp-2 break-words text-[11px] leading-4 text-amber-200/70">
                    {issue.reason} · {formatIssueTime(issue.occurredAt)}
                  </p>
                </div>
                {issue.taskId && (
                  <a
                    href={`/tasks/${issue.taskId}`}
                    className="mt-0.5 inline-flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-900/40 hover:text-amber-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                  >
                    Open <ExternalLink size={11} />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </aside>
  );
}
