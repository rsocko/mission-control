'use client';

import { Suspense } from 'react';
import { useNotifications } from '@/lib/hooks/useNotifications';
import { NotificationCard, NotificationDetail } from '@/components/notifications/NotificationCard';
import { NotificationsSidebar } from '@/components/notifications/NotificationsSidebar';
import { NotificationViewsBar } from '@/components/notifications/NotificationViewsBar';
import { AnimatePresence, motion } from 'motion/react';
import {
  Bell, Search, Archive, CheckCheck, Trash2,
  AlertTriangle, ArrowUpDown, ClipboardCheck, Mail,
  RefreshCw, Loader2, Zap,
} from 'lucide-react';
import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { MobileNotificationsScreen } from '@/components/mobile';
import { NotificationFilterControls } from '@/components/notifications/NotificationFilterControls';
import {
  notificationQueriesEqual,
  hasActiveNotificationFilters,
  parseNotificationQuery,
  serializeNotificationQuery,
} from '@/lib/notifications/query';
import type { NotificationView } from '@/lib/notifications/views';
import { isNotificationUnread } from '@/lib/notifications/lifecycle';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import type {
  NotificationRestoreSnapshot,
} from '@/lib/hooks/useNotifications';

function restoreSnapshot(
  notification: (ReturnType<typeof useNotifications>['notifications'])[number],
): NotificationRestoreSnapshot {
  return {
    id: notification.id,
    readState: notification.readState,
    disposition: notification.disposition,
    readAt: notification.readAt ?? null,
    handledAt: notification.handledAt ?? null,
    dismissedAt: notification.dismissedAt ?? null,
    archivedAt: notification.archivedAt ?? null,
    handledSourceActivityAt: notification.handledSourceActivityAt ?? null,
    handledSourceActivityKey: notification.handledSourceActivityKey ?? null,
  };
}

export default function NotificationsPage() {
  return (
    <Suspense fallback={<NotificationsPageSkeleton />}>
      <NotificationsPageInner />
    </Suspense>
  );
}

function NotificationsPageInner() {
  const isMobile = useIsMobile();
  const router = useRouter();

  if (isMobile) {
    return <MobileNotificationsScreen onBack={() => router.back()} />;
  }

  return <DesktopNotificationsPage />;
}

function DesktopNotificationsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [initialQuery] = useState(() => parseNotificationQuery(searchParams));
  const hook = useNotifications(initialQuery);
  const {
    executeAction,
    loadMore,
    replaceFilters,
    setSelectedId,
  } = hook;
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [selectionScope, setSelectionScope] = useState<'visible_page' | 'all_matching' | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [selectedSnapshot, setSelectedSnapshot] = useState<(typeof hook.notifications)[number] | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [undoState, setUndoState] = useState<{
    snapshots: NotificationRestoreSnapshot[];
    focusId: string | null;
    label: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const expectedUrlRef = useRef<string | null>(null);
  const applyingUrlRef = useRef(false);
  const selectedIdRef = useRef(hook.selectedId);
  useEffect(() => {
    selectedIdRef.current = hook.selectedId;
  }, [hook.selectedId]);

  // ─── URL-based filter persistence ─────────────────────────────────────────
  useEffect(() => {
    const current = searchParams.toString();
    if (expectedUrlRef.current === current) {
      expectedUrlRef.current = null;
      return;
    }
    const next = parseNotificationQuery(searchParams);
    if (!notificationQueriesEqual(next, hook.filters)) {
      applyingUrlRef.current = true;
      hook.replaceFilters(next);
    }
    // URL changes are the dependency; hook state is intentionally compared, not subscribed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams.toString()]);

  useEffect(() => {
    if (applyingUrlRef.current) {
      applyingUrlRef.current = false;
      return;
    }
    const params = serializeNotificationQuery(hook.filters);
    const activeView = searchParams.get('view');
    if (activeView) params.set('view', activeView);
    const nextQuery = params.toString();
    if (nextQuery === searchParams.toString()) return;
    expectedUrlRef.current = nextQuery;
    const newUrl = nextQuery ? `/notifications?${nextQuery}` : '/notifications';
    router.replace(newUrl, { scroll: false });
  }, [hook.filters, router, searchParams]);

  // ─── Infinite scroll ──────────────────────────────────────────────────────
  useEffect(() => {
    const listEl = listRef.current;
    if (!listEl) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = listEl;
      if (scrollHeight - scrollTop - clientHeight < 200) {
        loadMore();
      }
    };

    listEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => listEl.removeEventListener('scroll', handleScroll);
  }, [loadMore]);

  // ─── Select All ───────────────────────────────────────────────────────────
  const filteredIds = hook.notifications.map(n => n.id);

  const allSelected = selectionScope === 'visible_page'
    && filteredIds.length > 0
    && filteredIds.every(id => bulkSelected.has(id));

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setBulkSelected(new Set());
      setSelectionScope(null);
    } else {
      setBulkSelected(new Set(filteredIds));
      setSelectionScope('visible_page');
    }
  }, [allSelected, filteredIds]);

  const selectAndFocus = useCallback((id: string | null) => {
    setSelectedId(id);
    if (!id) return;
    const focus = () => rowRefs.current.get(id)?.focus();
    requestAnimationFrame(focus);
    window.setTimeout(focus, 100);
    window.setTimeout(focus, 300);
  }, [setSelectedId]);

  const announceBulkResult = useCallback((result: {
    acceptedCount: number;
    noOpCount: number;
    failedCount: number;
    queuedCount: number;
  }) => {
    setAnnouncement(
      `${result.acceptedCount} accepted, ${result.noOpCount} unchanged, `
      + `${result.failedCount} failed, ${result.queuedCount} writebacks queued.`,
    );
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (shouldBlockGlobalShortcut(e)) return;
      if (
        e.target instanceof HTMLElement
        && (e.target.isContentEditable || e.target.closest('input, textarea, select, button'))
      ) return;

      const items = hook.notifications;
      const currentIdx = items.findIndex(n => n.id === hook.selectedId);

      switch (e.key) {
        case 'j': {
          e.preventDefault();
          const nextIdx = currentIdx < 0 ? 0 : Math.min(currentIdx + 1, items.length - 1);
          selectAndFocus(items[nextIdx]?.id || null);
          break;
        }
        case 'k': {
          e.preventDefault();
          const prevIdx = Math.max(currentIdx - 1, 0);
          selectAndFocus(items[prevIdx]?.id || null);
          break;
        }
        case 'r': {
          e.preventDefault();
          if (hook.selectedId) {
            const n = items.find(i => i.id === hook.selectedId);
            if (n && isNotificationUnread(n)) {
              void hook.markRead([hook.selectedId]).then(announceBulkResult);
              setUndoState({ snapshots: [restoreSnapshot(n)], focusId: n.id, label: 'mark read' });
            } else if (n) {
              void hook.markUnread([hook.selectedId]).then(announceBulkResult);
              setUndoState({ snapshots: [restoreSnapshot(n)], focusId: n.id, label: 'mark unread' });
            }
          }
          break;
        }
        case 'd': {
          e.preventDefault();
          if (hook.selectedId) {
            const removed = items[currentIdx];
            const next = items[currentIdx + 1] ?? items[currentIdx - 1];
            void hook.dismiss([hook.selectedId]).then(result => {
              announceBulkResult(result);
              if (removed) {
                setUndoState({
                  snapshots: [restoreSnapshot(removed)],
                  focusId: removed.id,
                  label: 'dismiss',
                });
              }
              selectAndFocus(next?.id ?? null);
            }).catch(error => {
              setAnnouncement(error instanceof Error ? error.message : 'Dismiss failed.');
            });
          }
          break;
        }
        case 's': {
          e.preventDefault();
          if (hook.selectedId) {
            void hook.snooze(hook.selectedId, '1h').then(() => {
              setAnnouncement('Notification snoozed for one hour.');
            });
          }
          break;
        }
        case 'm': {
          e.preventDefault();
          if (hook.selectedId) {
            const notification = items.find(item => item.id === hook.selectedId);
            const muteAction = notification?.actions?.find(action => action.actionType === 'mute');
            if (notification && muteAction) {
              void hook.executeAction(notification.id, muteAction.id).then(result => {
                setAnnouncement(result.success ? 'Notification muted.' : 'Mute failed.');
              });
            } else {
              setAnnouncement('Mute is not available for this notification.');
            }
          }
          break;
        }
        case 'u': {
          if (!undoState) break;
          e.preventDefault();
          void hook.restore(undoState.snapshots).then(() => {
            setAnnouncement(`Undid ${undoState.label}.`);
            selectAndFocus(undoState.focusId);
            setUndoState(null);
          });
          break;
        }
        case 'x': {
          e.preventDefault();
          if (hook.selectedId) {
            setSelectionScope('visible_page');
            setBulkSelected(prev => {
              const next = new Set(prev);
              if (next.has(hook.selectedId!)) next.delete(hook.selectedId!);
              else next.add(hook.selectedId!);
              return next;
            });
          }
          break;
        }
        case 'a': {
          if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            toggleSelectAll();
          }
          break;
        }
        case '/': {
          e.preventDefault();
          document.getElementById('notification-search')?.focus();
          break;
        }
        case 'Escape': {
          setSelectionScope(null);
          setBulkSelected(new Set());
          break;
        }
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [announceBulkResult, hook, selectAndFocus, toggleSelectAll, undoState]);

  // Search filter
  const filteredNotifications = hook.notifications;

  const selectedNotification = hook.selectedId
    ? hook.notifications.find(n => n.id === hook.selectedId)
      || (selectedSnapshot?.id === hook.selectedId ? selectedSnapshot : undefined)
    : undefined;
  const handleExecuteAction = useCallback(async (notificationId: string, actionId: string) => {
    const result = await executeAction(notificationId, actionId);
    if (result.success && selectedIdRef.current === notificationId) {
      setSelectedId(null);
      setSelectedSnapshot(null);
    }
    return result;
  }, [executeAction, setSelectedId]);

  // Bulk actions
  const handleBulkAction = useCallback(async (action: 'mark_read' | 'dismiss' | 'handle') => {
    try {
      const ids = Array.from(bulkSelected);
      if (selectionScope === 'visible_page' && !ids.length) return;
      const result = selectionScope === 'all_matching'
        ? await hook.actOnAllMatching(action)
        : action === 'mark_read'
          ? await hook.markRead(ids)
          : action === 'dismiss'
            ? await hook.dismiss(ids)
            : await hook.handle(ids);
      announceBulkResult(result);
      if (selectionScope === 'visible_page' && ids.length) {
        const selected = hook.notifications.filter(notification => bulkSelected.has(notification.id));
        if (selected[0]) {
          setUndoState({
            snapshots: selected.map(restoreSnapshot),
            focusId: selected[0].id,
            label: action.replace('_', ' '),
          });
        }
      }
      setBulkSelected(new Set());
      setSelectionScope(null);
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : 'Bulk action failed.');
    }
  }, [announceBulkResult, bulkSelected, hook, selectionScope]);

  const handleApplyView = useCallback((view: NotificationView) => {
    replaceFilters(view.query);
    const params = serializeNotificationQuery(view.query);
    params.set('view', view.id);
    const next = params.toString();
    expectedUrlRef.current = next;
    router.replace(`/notifications?${next}`, { scroll: false });
    setBulkSelected(new Set());
    setSelectionScope(null);
    setAnnouncement(`Applied view ${view.name}.`);
  }, [replaceFilters, router]);

  const status = hook.operationalStatus;
  const visibleStatus = status.failedWritebacks > 0
    ? `${status.failedWritebacks} writeback${status.failedWritebacks === 1 ? '' : 's'} failed`
    : status.backoffUntil
      ? `Sync paused until ${new Date(status.backoffUntil).toLocaleTimeString()}`
      : status.isSyncing
        ? 'Syncing notifications'
        : status.pendingWritebacks > 0
          ? `${status.pendingWritebacks} writeback${status.pendingWritebacks === 1 ? '' : 's'} pending`
          : status.lastSyncAt
            ? `Last synced ${new Date(status.lastSyncAt).toLocaleString()}`
            : 'Waiting for first sync';
  const quickFilters = [
    {
      key: 'urgent',
      label: 'Urgent',
      detail: 'Unread',
      count: hook.stats.urgent,
      icon: AlertTriangle,
      active: hook.filters.level === 'urgent' && hook.filters.state === 'unread',
      onClick: () => {
        const active = hook.filters.level === 'urgent' && hook.filters.state === 'unread';
        hook.replaceFilters({
          ...hook.filters,
          level: active ? null : 'urgent',
          state: active ? null : 'unread',
        });
      },
      accent: 'text-red-300',
    },
    {
      key: 'action-needed',
      label: 'Action needed',
      detail: 'Unread',
      count: hook.stats.actionNeeded,
      icon: ClipboardCheck,
      active: hook.filters.level === 'action_needed' && hook.filters.state === 'unread',
      onClick: () => {
        const active = hook.filters.level === 'action_needed'
          && hook.filters.state === 'unread';
        hook.replaceFilters({
          ...hook.filters,
          level: active ? null : 'action_needed',
          state: active ? null : 'unread',
        });
      },
      accent: 'text-amber-300',
    },
    {
      key: 'actionable',
      label: 'Actionable',
      detail: 'Can be handled',
      count: hook.stats.actionable,
      icon: Zap,
      active: hook.filters.actionableOnly,
      onClick: () => hook.setActionableOnly(!hook.filters.actionableOnly),
      accent: 'text-violet-300',
    },
    {
      key: 'unread',
      label: 'Unread',
      detail: 'Across all sources',
      count: hook.stats.unread,
      icon: Mail,
      active: hook.filters.state === 'unread',
      onClick: () => hook.setStateFilter(hook.filters.state === 'unread' ? null : 'unread'),
      accent: 'text-blue-300',
    },
  ].filter(filter => filter.count > 0);

  return (
    <div className="flex h-full bg-[var(--bg-primary)]">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
      {/* Left-nav sidebar filters */}
      <NotificationsSidebar
        hook={hook}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed((v) => !v)}
        savedViews={(
          <NotificationViewsBar
            query={hook.filters}
            activeViewId={searchParams.get('view')}
            onApply={handleApplyView}
            onAnnouncement={setAnnouncement}
            variant="sidebar"
          />
        )}
      />

      {/* Main area: header + list/detail split */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Page header */}
        <header className="px-6 py-4 border-b border-[var(--border)] bg-[var(--surface-1)]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <Bell size={20} className="text-[var(--accent)]" />
              <h1 className="text-lg font-semibold text-[var(--text-primary)]">Notifications</h1>
              {hook.stats.unread > 0 && (
                <span className="text-xs bg-red-900/40 text-red-300 px-2 py-0.5 rounded-full border border-red-800/30">
                  {hook.stats.unread} unread
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => {
                  void hook.markAllRead()
                    .then(announceBulkResult)
                    .catch(error => setAnnouncement(error instanceof Error ? error.message : 'Mark all read failed.'));
                }}
                className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-md bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                <CheckCheck size={12} />
                Mark All Read
              </button>
              <button
                onClick={hook.refresh}
                aria-label="Refresh notifications"
                className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              >
                <RefreshCw size={14} />
              </button>
            </div>
          </div>

          <div
            role={status.failedWritebacks > 0 || status.error ? 'alert' : undefined}
            aria-live="polite"
            className={`mt-1 text-xs ${
              status.failedWritebacks > 0 || status.error ? 'text-red-300' : 'text-[var(--text-muted)]'
            }`}
          >
            {status.error ? 'Synchronization status unavailable' : visibleStatus}
            {undoState && (
              <button
                type="button"
                onClick={() => {
                  void hook.restore(undoState.snapshots).then(() => {
                    setAnnouncement(`Undid ${undoState.label}.`);
                    selectAndFocus(undoState.focusId);
                    setUndoState(null);
                  });
                }}
                className="ml-2 text-[var(--accent)] underline"
              >
                Undo {undoState.label}
              </button>
            )}
          </div>

          {quickFilters.length > 0 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Notification quick filters">
              {quickFilters.map(filter => {
                const Icon = filter.icon;
                return (
                  <button
                    key={filter.key}
                    type="button"
                    aria-pressed={filter.active}
                    onClick={filter.onClick}
                    className={`flex min-w-36 items-center gap-3 rounded-lg border px-3 py-2 text-left transition-colors ${
                      filter.active
                        ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                        : 'border-[var(--border)] bg-[var(--surface-2)] hover:bg-[var(--surface-3)]'
                    }`}
                  >
                    <Icon size={16} className={filter.accent} aria-hidden="true" />
                    <span className="text-base font-semibold tabular-nums text-[var(--text-primary)]">
                      {filter.count}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium text-[var(--text-primary)]">
                        {filter.label}
                      </span>
                      <span className="block truncate text-xs text-[var(--text-muted)]">
                        {filter.detail}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* Toolbar: URL-backed search and sort */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {/* Search */}
            <div className="relative min-w-64 flex-1 max-w-lg">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                id="notification-search"
                type="text"
                placeholder="Search notifications... (/ to focus)"
                value={hook.filters.q ?? ''}
                onChange={(e) => hook.setSearchFilter(e.target.value || null)}
                className="w-full pl-8 pr-3 py-1.5 text-xs bg-[var(--surface-0)] border border-[var(--border)] rounded-md text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
              />
            </div>

            <NotificationFilterControls
              query={hook.filters}
              facets={hook.facets}
              onChange={hook.replaceFilters}
              desktopInline
              includeCommonFilters={false}
            />

            {/* Sort toggle */}
            <Select
              value={hook.sortNewest ? 'newest' : 'oldest'}
              onValueChange={(v) => hook.setSortNewest(v === 'newest')}
            >
              <SelectTrigger className="h-8 min-h-0 text-xs px-2.5 py-1.5 w-auto gap-1.5">
                <ArrowUpDown size={11} className="shrink-0 opacity-60" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Bulk action bar */}
          {selectionScope && (bulkSelected.size > 0 || selectionScope === 'all_matching') && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="flex items-center gap-2 mt-2 pt-2 border-t border-[var(--border)]"
            >
              <span className="text-xs text-[var(--text-secondary)]">
                {selectionScope === 'all_matching'
                  ? `All ${hook.matchingCount} matching notifications selected`
                  : `${bulkSelected.size} visible notification${bulkSelected.size === 1 ? '' : 's'} selected`}
              </span>
              {selectionScope === 'visible_page' && hook.matchingCount > bulkSelected.size && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectionScope('all_matching');
                    setAnnouncement(`All ${hook.matchingCount} matching notifications selected.`);
                  }}
                  className="text-xs text-[var(--accent)] underline"
                >
                  Select all {hook.matchingCount} matching
                </button>
              )}
              <button
                onClick={() => handleBulkAction('mark_read')}
                className="text-xs px-2 py-1 rounded bg-blue-900/30 text-blue-300 hover:bg-blue-900/50 transition-colors"
              >
                <CheckCheck size={11} className="inline mr-1" />
                Read
              </button>
              <button
                onClick={() => handleBulkAction('dismiss')}
                className="text-xs px-2 py-1 rounded bg-red-900/30 text-red-300 hover:bg-red-900/50 transition-colors"
              >
                <Trash2 size={11} className="inline mr-1" />
                Dismiss
              </button>
              <button
                onClick={() => handleBulkAction('handle')}
                className="text-xs px-2 py-1 rounded bg-slate-800/50 text-slate-300 hover:bg-slate-800/70 transition-colors"
              >
                <Archive size={11} className="inline mr-1" />
                Handle
              </button>
              <button
                onClick={() => { setSelectionScope(null); setBulkSelected(new Set()); }}
                className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] ml-auto"
              >
                Cancel
              </button>
            </motion.div>
          )}
        </header>

        {/* Main content: split list + detail */}
        <div className="flex flex-1 overflow-hidden">
          {/* Notification list */}
          <div ref={listRef} className="w-[420px] flex-shrink-0 border-r border-[var(--border)] overflow-y-auto">
            <div className="sticky top-0 z-10 flex h-10 items-center border-b border-[var(--border)] bg-[var(--surface-1)] px-3">
              <label className="inline-flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
                <input
                  type="checkbox"
                  aria-label="Select visible results"
                  checked={allSelected}
                  onChange={toggleSelectAll}
                  className="h-3.5 w-3.5 accent-[var(--accent)]"
                />
                Select visible
              </label>
              <span className="ml-auto text-xs tabular-nums text-[var(--text-muted)]">
                {hook.matchingCount.toLocaleString()} matching
              </span>
            </div>
            {hook.isLoading && filteredNotifications.length === 0 ? (
              <div className="flex h-full items-center justify-center" role="status">
                <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
                <span className="ml-2 text-sm text-[var(--text-muted)]">Loading notifications…</span>
              </div>
            ) : hook.error ? (
              <div className="flex h-full flex-col items-center justify-center p-8 text-center" role="alert">
                <p className="text-sm font-medium text-[var(--text-primary)]">Couldn&apos;t load notifications</p>
                <p className="mt-1 text-xs text-[var(--text-muted)]">{hook.error}</p>
                <button
                  type="button"
                  onClick={hook.refresh}
                  className="mt-4 rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
                >
                  Try again
                </button>
              </div>
            ) : filteredNotifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <div className="text-4xl mb-3">{hasActiveNotificationFilters(hook.filters) ? '🔎' : '🎉'}</div>
                <p className="text-sm text-[var(--text-secondary)]">
                  {hasActiveNotificationFilters(hook.filters) ? 'No matching notifications' : 'All caught up!'}
                </p>
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  {hasActiveNotificationFilters(hook.filters)
                    ? 'Try changing or clearing this view’s filters.'
                    : 'New notifications will appear here after the next sync.'}
                </p>
              </div>
            ) : (
              <div className="p-3 space-y-1" role="listbox" aria-label="Notifications">
                <AnimatePresence mode="popLayout">
                  {filteredNotifications.map((notification) => (
                    <div
                      key={notification.id}
                      ref={element => {
                        if (element) rowRefs.current.set(notification.id, element);
                        else rowRefs.current.delete(notification.id);
                      }}
                      role="option"
                      aria-selected={hook.selectedId === notification.id}
                      tabIndex={hook.selectedId === notification.id || !hook.selectedId ? 0 : -1}
                      onFocus={() => hook.setSelectedId(notification.id)}
                      className="rounded-md focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    >
                      <NotificationCard
                        notification={notification}
                        compact
                        isSelected={hook.selectedId === notification.id}
                        onSelect={() => {
                          setSelectedSnapshot(isNotificationUnread(notification)
                            ? { ...notification, state: 'read', readState: 'read', readAt: new Date().toISOString() }
                            : notification);
                          selectAndFocus(notification.id);
                          if (isNotificationUnread(notification)) {
                            void hook.markRead([notification.id]).then(announceBulkResult);
                            setUndoState({
                              snapshots: [restoreSnapshot(notification)],
                              focusId: notification.id,
                              label: 'mark read',
                            });
                          }
                        }}
                        onMarkRead={() => {
                          const unread = isNotificationUnread(notification);
                          const action = unread
                            ? hook.markRead([notification.id])
                            : hook.markUnread([notification.id]);
                          void action.then(announceBulkResult);
                          setUndoState({
                            snapshots: [restoreSnapshot(notification)],
                            focusId: notification.id,
                            label: unread ? 'mark read' : 'mark unread',
                          });
                        }}
                        onHandle={async () => {
                          const index = filteredNotifications.findIndex(item => item.id === notification.id);
                          const next = filteredNotifications[index + 1] ?? filteredNotifications[index - 1];
                          const result = await hook.handle([notification.id]);
                          announceBulkResult(result);
                          setUndoState({
                            snapshots: [restoreSnapshot(notification)],
                            focusId: notification.id,
                            label: 'handle',
                          });
                          selectAndFocus(next?.id ?? null);
                        }}
                        onSnooze={(duration) => hook.snooze(notification.id, duration)}
                        onMute={async () => {
                          const result = await (notification.mutedAt
                            ? hook.unmute([notification.id])
                            : hook.mute([notification.id]));
                          announceBulkResult(result);
                        }}
                        onExecuteAction={(actionId) => handleExecuteAction(notification.id, actionId)}
                      />
                    </div>
                  ))}
                </AnimatePresence>

                {/* Infinite scroll loading indicator */}
                {hook.isLoadingMore && (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 size={16} className="animate-spin text-[var(--text-muted)]" />
                    <span className="ml-2 text-xs text-[var(--text-muted)]">Loading more…</span>
                  </div>
                )}

                {/* End of list indicator */}
                {!hook.hasMore && filteredNotifications.length > 0 && !hook.isLoadingMore && (
                  <p className="text-center text-xs text-[var(--text-muted)] py-3">
                    No more notifications
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Detail panel */}
          <div className="flex-1 overflow-y-auto">
            {selectedNotification ? (
              <NotificationDetail
                key={selectedNotification.id}
                notification={selectedNotification}
                onExecuteAction={(actionId) => handleExecuteAction(selectedNotification.id, actionId)}
                onMarkRead={() => {
                 const nextState = isNotificationUnread(selectedNotification) ? 'read' : 'unread';
                 setSelectedSnapshot({ ...selectedNotification, state: nextState, readState: nextState });
                 const action = nextState === 'read'
                   ? hook.markRead([selectedNotification.id])
                   : hook.markUnread([selectedNotification.id]);
                 void action.then(announceBulkResult);
                 setUndoState({
                   snapshots: [restoreSnapshot(selectedNotification)],
                   focusId: selectedNotification.id,
                   label: nextState === 'read' ? 'mark read' : 'mark unread',
                 });
                }}
                onDismiss={async () => {
                 const index = filteredNotifications.findIndex(item => item.id === selectedNotification.id);
                 const next = filteredNotifications[index + 1] ?? filteredNotifications[index - 1];
                 setSelectedSnapshot(null);
                 const result = await hook.dismiss([selectedNotification.id]);
                 announceBulkResult(result);
                 setUndoState({
                   snapshots: [restoreSnapshot(selectedNotification)],
                   focusId: selectedNotification.id,
                   label: 'dismiss',
                 });
                 selectAndFocus(next?.id ?? null);
                }}
                onArchive={async () => {
                 const index = filteredNotifications.findIndex(item => item.id === selectedNotification.id);
                 const next = filteredNotifications[index + 1] ?? filteredNotifications[index - 1];
                 setSelectedSnapshot(null);
                 const result = await hook.handle([selectedNotification.id]);
                 announceBulkResult(result);
                 setUndoState({
                   snapshots: [restoreSnapshot(selectedNotification)],
                   focusId: selectedNotification.id,
                   label: 'handle',
                 });
                 selectAndFocus(next?.id ?? null);
                }}
                onSnooze={(duration) => hook.snooze(selectedNotification.id, duration)}
                onMute={async () => {
                  const result = await (selectedNotification.mutedAt
                    ? hook.unmute([selectedNotification.id])
                    : hook.mute([selectedNotification.id]));
                  announceBulkResult(result);
                }}
                className="h-full"
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <Bell size={32} className="text-[var(--text-muted)] mb-3 opacity-40" />
                <p className="text-sm text-[var(--text-muted)]">Select a notification to view details</p>
                <p className="text-xs text-[var(--text-muted)] mt-2 max-w-xs">
                  Use <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">j</kbd> / <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">k</kbd> to navigate, <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">r</kbd> to toggle read, <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">s</kbd> to snooze, <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">m</kbd> to mute, <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">d</kbd> to dismiss, and <kbd className="px-1 py-0.5 bg-[var(--surface-2)] rounded text-xs">u</kbd> to undo
                </p>
                {undoState && (
                  <button
                    type="button"
                    onClick={() => {
                      void hook.restore(undoState.snapshots).then(() => {
                        setAnnouncement(`Undid ${undoState.label}.`);
                        selectAndFocus(undoState.focusId);
                        setUndoState(null);
                      });
                    }}
                    className="mt-3 text-xs text-[var(--accent)] underline"
                  >
                    Undo {undoState.label}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SKELETON ───────────────────────────────────────────────────────────────

function NotificationsPageSkeleton() {
  return (
    <div className="flex h-full bg-[var(--bg-primary)]">
      {/* Sidebar skeleton */}
      <div className="hidden sm:flex flex-col w-56 bg-[var(--surface-1)] border-r border-[var(--border)] p-4 flex-shrink-0">
        <div className="h-4 w-16 bg-[var(--surface-2)] rounded animate-pulse mb-3" />
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-7 bg-[var(--surface-2)] rounded animate-pulse mb-1" />
        ))}
        <div className="h-4 w-20 bg-[var(--surface-2)] rounded animate-pulse mb-3 mt-4" />
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-7 bg-[var(--surface-2)] rounded animate-pulse mb-1" />
        ))}
      </div>
      {/* Main area skeleton */}
      <div className="flex flex-col flex-1 min-w-0">
        <header className="px-6 py-4 border-b border-[var(--border)] bg-[var(--surface-1)]">
          <div className="h-6 w-40 bg-[var(--surface-2)] rounded animate-pulse" />
        </header>
        <div className="flex flex-1">
          <div className="w-[420px] border-r border-[var(--border)] p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-20 bg-[var(--surface-2)] rounded-lg animate-pulse" />
            ))}
          </div>
          <div className="flex-1 p-6">
            <div className="h-8 w-64 bg-[var(--surface-2)] rounded animate-pulse mb-4" />
            <div className="h-4 w-full bg-[var(--surface-2)] rounded animate-pulse mb-2" />
            <div className="h-4 w-3/4 bg-[var(--surface-2)] rounded animate-pulse" />
          </div>
        </div>
      </div>
    </div>
  );
}
