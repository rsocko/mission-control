'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type {
  NotificationCategory,
  NotificationDisposition,
  NotificationItem,
  NotificationLevel,
  NotificationState,
  NotificationReadState,
} from '@/types';
import {
  cancelExternalNavigation,
  completeExternalNavigation,
  prepareExternalNavigation,
} from '@/lib/notifications/external-navigation';
import {
  DEFAULT_NOTIFICATION_QUERY,
  serializeNotificationQuery,
  type NotificationQuery,
} from '@/lib/notifications/query';
import {
  isInInbox,
  isNotificationUnread,
} from '@/lib/notifications/lifecycle';
import type { NotificationBulkOutcome } from '@/lib/notifications/bulk';

export interface NotificationStats {
  total: number;
  unread: number;
  attention: number;
  urgent: number;
  actionNeeded: number;
  headsUp: number;
  fyi: number;
  digest: number;
  actionable: number;
}

export type NotificationAttentionView = 'inbox' | 'action' | 'unread';

export interface NotificationFacets {
  level: Record<string, number>;
  category: Record<string, number>;
  source: Record<string, number>;
  state: Record<string, number>;
  merchant: Array<{ key: string; label: string; count: number }>;
}

export type NotificationsFilters = NotificationQuery;

export interface NotificationBulkResult extends NotificationBulkOutcome {
  success: boolean;
  action: string;
  scope: 'visible_page' | 'all_matching';
  updatedCount: number;
  outcome?: NotificationBulkOutcome;
}

export interface NotificationRestoreSnapshot {
  id: string;
  readState: NotificationReadState;
  disposition: NotificationDisposition;
  readAt: string | null;
  handledAt: string | null;
  dismissedAt: string | null;
  archivedAt: string | null;
  handledSourceActivityAt: string | null;
  handledSourceActivityKey: string | null;
}

export interface NotificationOperationalStatus {
  isSyncing: boolean;
  lastSyncAt: string | null;
  lastSyncSucceeded: boolean | null;
  backoffUntil: string | null;
  pendingWritebacks: number;
  failedWritebacks: number;
  error: string | null;
}

export interface UseNotificationsReturn {
  // Data
  notifications: NotificationItem[];
  stats: NotificationStats;
  facets: NotificationFacets;
  matchingCount: number;
  operationalStatus: NotificationOperationalStatus;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;

  // Filters
  filters: NotificationsFilters;
  setLevelFilter: (level: NotificationLevel | null) => void;
  setCategoryFilter: (category: NotificationCategory | string | null) => void;
  setMerchantFilter: (merchant: string | null) => void;
  setSourceFilter: (source: string | null) => void;
  setStateFilter: (state: NotificationState | null) => void;
  setActionableOnly: (actionable: boolean) => void;
  setDateRangeFilter: (dateRange: 'today' | 'week' | 'month' | null) => void;
  setSearchFilter: (query: string | null) => void;
  setRepositoryFilter: (repository: string | null) => void;
  setOwnerFilter: (owner: string | null) => void;
  setReasonFilter: (reason: string | null) => void;
  setSubjectTypeFilter: (subjectType: string | null) => void;
  setSourceAccountFilter: (sourceAccount: string | null) => void;
  setParticipatingFilter: (participating: boolean) => void;
  replaceFilters: (filters: NotificationsFilters) => void;
  setAttentionView: (view: NotificationAttentionView) => void;
  resetFilters: () => void;

  // Sort & group
  sortNewest: boolean;
  setSortNewest: (newest: boolean) => void;

  // Actions
  markRead: (ids: string[]) => Promise<NotificationBulkResult>;
  markUnread: (ids: string[]) => Promise<NotificationBulkResult>;
  dismiss: (ids: string[]) => Promise<NotificationBulkResult>;
  handle: (ids: string[]) => Promise<NotificationBulkResult>;
  mute: (ids: string[]) => Promise<NotificationBulkResult>;
  unmute: (ids: string[]) => Promise<NotificationBulkResult>;
  /** @deprecated Use handle. */
  archive: (ids: string[]) => Promise<NotificationBulkResult>;
  restore: (snapshots: NotificationRestoreSnapshot[]) => Promise<void>;
  actOnAllMatching: (action: 'mark_read' | 'mark_unread' | 'dismiss' | 'handle' | 'archive') => Promise<NotificationBulkResult>;
  snooze: (id: string, duration: string) => Promise<void>;
  executeAction: (notificationId: string, actionId: string, params?: Record<string, unknown>) => Promise<ActionResult>;
  markAllRead: () => Promise<NotificationBulkResult>;

  // Pagination
  loadMore: () => void;

  // UI state
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  panelVisible: boolean;
  togglePanel: () => void;
  setPanelVisible: (visible: boolean) => void;

  // Refresh
  refresh: () => void;

  // Computed
  grouped: GroupedNotifications;
  unreadNotifications: NotificationItem[];
}

export interface ActionResult {
  success: boolean;
  result?: {
    type: string;
    url?: string;
    target?: string;
    taskData?: Record<string, unknown>;
    workflowId?: string;
    workflowParams?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  };
}

export interface GroupedNotifications {
  today: NotificationItem[];
  yesterday: NotificationItem[];
  thisWeek: NotificationItem[];
  older: NotificationItem[];
}

function groupByTime(items: NotificationItem[]): GroupedNotifications {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart.getTime() - 86400000);
  const weekStart = new Date(todayStart.getTime() - 6 * 86400000);

  const groups: GroupedNotifications = { today: [], yesterday: [], thisWeek: [], older: [] };

  for (const item of items) {
    const d = new Date(item.receivedAt);
    if (d >= todayStart) groups.today.push(item);
    else if (d >= yesterdayStart) groups.yesterday.push(item);
    else if (d >= weekStart) groups.thisWeek.push(item);
    else groups.older.push(item);
  }

  return groups;
}

export function useNotifications(initialFilters: NotificationsFilters = DEFAULT_NOTIFICATION_QUERY): UseNotificationsReturn {
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [stats, setStats] = useState<NotificationStats>({
    total: 0,
    unread: 0,
    attention: 0,
    urgent: 0,
    actionNeeded: 0,
    headsUp: 0,
    fyi: 0,
    digest: 0,
    actionable: 0,
  });
  const [facets, setFacets] = useState<NotificationFacets>({
    level: {},
    category: {},
    source: {},
    state: {},
    merchant: [],
  });
  const [matchingCount, setMatchingCount] = useState(0);
  const [operationalStatus, setOperationalStatus] = useState<NotificationOperationalStatus>({
    isSyncing: false,
    lastSyncAt: null,
    lastSyncSucceeded: null,
    backoffUntil: null,
    pendingWritebacks: 0,
    failedWritebacks: 0,
    error: null,
  });
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<NotificationsFilters>(initialFilters);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [panelVisible, setPanelVisible] = useState(true);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  const cursorRef = useRef<string | null>(null);
  const loadMoreGenRef = useRef(0);

  const buildParams = useCallback(() => {
    return serializeNotificationQuery(filters);
  }, [filters]);

  const fetchNotifications = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setIsLoading(true);
    setError(null);
    cursorRef.current = null;
    loadMoreGenRef.current += 1;

    const params = buildParams();

    try {
      const res = await fetch(`/api/notifications?${params.toString()}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNotifications(data.notifications || []);
      setStats(data.stats || {
        total: 0,
        unread: 0,
        attention: 0,
        urgent: 0,
        actionNeeded: 0,
        headsUp: 0,
        fyi: 0,
        digest: 0,
        actionable: 0,
      });
      setFacets(data.facets || { level: {}, category: {}, source: {}, state: {}, merchant: [] });
      setMatchingCount(Number(data.matchingCount ?? data.notifications?.length ?? 0));
      setHasMore(data.hasMore || false);
      cursorRef.current = data.cursor || null;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') return;
      setError(e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setIsLoading(false);
    }
  }, [buildParams]);

  const loadMore = useCallback(async () => {
    if (!hasMore || isLoadingMore || !cursorRef.current) return;
    setIsLoadingMore(true);

    const gen = loadMoreGenRef.current;
    const params = buildParams();
    params.set('cursor', cursorRef.current);

    try {
      const res = await fetch(`/api/notifications?${params.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // If filters changed while loading, discard stale results
      if (gen !== loadMoreGenRef.current) return;
      const data = await res.json();
      setNotifications(prev => [...prev, ...(data.notifications || [])]);
      setHasMore(data.hasMore || false);
      cursorRef.current = data.cursor || null;
    } catch (e) {
      console.error('Load more failed:', e);
    } finally {
      setIsLoadingMore(false);
    }
  }, [hasMore, isLoadingMore, buildParams]);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void fetchNotifications();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [fetchNotifications, refreshTrigger]);

  useEffect(() => {
    const handleSyncComplete = () => setRefreshTrigger(n => n + 1);
    window.addEventListener('mission-control:sync-complete', handleSyncComplete);
    return () => window.removeEventListener('mission-control:sync-complete', handleSyncComplete);
  }, []);

  // Actions
  const bulkAction = useCallback(async (
    action: 'mark_read' | 'mark_unread' | 'dismiss' | 'handle' | 'archive' | 'mute' | 'unmute',
    request: { ids: string[] } | { scope: 'all_matching'; query: NotificationQuery },
  ): Promise<NotificationBulkResult> => {
    const res = await fetch('/api/notifications/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, action }),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => null) as { error?: string } | null;
      throw new Error(error?.error || `HTTP ${res.status}`);
    }
    const result = await res.json() as NotificationBulkResult;
    setRefreshTrigger(n => n + 1);
    return result;
  }, []);

  const markRead = useCallback((ids: string[]) => bulkAction('mark_read', { ids }), [bulkAction]);
  const markUnread = useCallback((ids: string[]) => bulkAction('mark_unread', { ids }), [bulkAction]);
  const dismiss = useCallback((ids: string[]) => bulkAction('dismiss', { ids }), [bulkAction]);
  const handle = useCallback((ids: string[]) => bulkAction('handle', { ids }), [bulkAction]);
  const archive = handle;
  const mute = useCallback((ids: string[]) => bulkAction('mute', { ids }), [bulkAction]);
  const unmute = useCallback((ids: string[]) => bulkAction('unmute', { ids }), [bulkAction]);
  const actOnAllMatching = useCallback(
    (action: 'mark_read' | 'mark_unread' | 'dismiss' | 'handle' | 'archive') =>
      bulkAction(action, { scope: 'all_matching', query: filters }),
    [bulkAction, filters],
  );
  const restore = useCallback(async (snapshots: NotificationRestoreSnapshot[]) => {
    const res = await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ restore: snapshots }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setRefreshTrigger(n => n + 1);
  }, []);

  const snooze = useCallback(async (id: string, duration: string) => {
    try {
      const res = await fetch(`/api/notifications/${id}/snooze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ duration }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRefreshTrigger(n => n + 1);
    } catch (e) {
      console.error('Snooze failed:', e);
    }
  }, []);

  const markAllRead = useCallback(() => actOnAllMatching('mark_read'), [actOnAllMatching]);

  const executeAction = useCallback(async (notificationId: string, actionId: string, params?: Record<string, unknown>): Promise<ActionResult> => {
    const action = notifications
      .find(notification => notification.id === notificationId)
      ?.actions?.find(candidate => candidate.id === actionId);
    const externalWindow = prepareExternalNavigation(action?.opensExternal === true);
    try {
      const res = await fetch(`/api/notifications/${notificationId}/actions/${actionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params || {}),
      });
      if (!res.ok) {
        cancelExternalNavigation(externalWindow);
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      setRefreshTrigger(n => n + 1);

      // Handle navigation results from actions (e.g. open_url, navigate)
      if (data.success && data.result) {
        if (data.result.url) {
          if (data.result.target === '_blank' || data.result.type === 'open_url') {
            completeExternalNavigation(externalWindow, data.result.url);
          } else {
            cancelExternalNavigation(externalWindow);
            window.location.href = data.result.url;
          }
        } else if (data.result.type === 'navigate' && data.result.target) {
          cancelExternalNavigation(externalWindow);
          window.location.href = data.result.target;
        } else {
          cancelExternalNavigation(externalWindow);
        }
      } else {
        cancelExternalNavigation(externalWindow);
      }

      return data;
    } catch {
      cancelExternalNavigation(externalWindow);
      return { success: false };
    }
  }, [notifications]);

  // Computed
  const sortedNotifications = notifications;

  const grouped = useMemo(() => groupByTime(sortedNotifications), [sortedNotifications]);
  const unreadNotifications = useMemo(
    () => notifications.filter(notification =>
      isInInbox(notification) && isNotificationUnread(notification)),
    [notifications],
  );

  const togglePanel = useCallback(() => setPanelVisible(v => !v), []);
  const refresh = useCallback(() => setRefreshTrigger(n => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      Promise.all([
        fetch('/api/sync?limit=1', { signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error(`Sync status HTTP ${response.status}`);
          return response.json();
        }),
        fetch('/api/notifications/writebacks', { signal: controller.signal }).then(async response => {
          if (!response.ok) throw new Error(`Writeback status HTTP ${response.status}`);
          return response.json();
        }),
      ]).then(([sync, writebacks]) => {
        const latest = sync.history?.[0];
        setOperationalStatus({
          isSyncing: sync.isSyncing === true,
          lastSyncAt: latest?.syncedAt ?? null,
          lastSyncSucceeded: typeof latest?.success === 'boolean' ? latest.success : null,
          backoffUntil: sync.queue?.backoffUntil ?? sync.scheduleHealth?.backoffUntil ?? null,
          pendingWritebacks: Number(writebacks.counts?.pending ?? 0) + Number(writebacks.counts?.sending ?? 0),
          failedWritebacks: Number(writebacks.counts?.failed ?? 0),
          error: null,
        });
      }).catch(error => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setOperationalStatus(status => ({
          ...status,
          error: error instanceof Error ? error.message : 'Status unavailable',
        }));
      });
    }, 1_000);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [refreshTrigger]);

  return {
    notifications: sortedNotifications,
    stats,
    facets,
    matchingCount,
    operationalStatus,
    hasMore,
    isLoading,
    isLoadingMore,
    error,
    filters,
    setLevelFilter: (level) => setFilters(f => ({ ...f, level })),
    setCategoryFilter: (category) => setFilters(f => ({ ...f, category })),
    setMerchantFilter: (merchant) => setFilters(f => ({ ...f, merchant })),
    setSourceFilter: (source) => setFilters(f => ({ ...f, source })),
    setStateFilter: (state) => setFilters(f => ({ ...f, state })),
    setActionableOnly: (actionableOnly) => setFilters(f => ({ ...f, actionableOnly })),
    setDateRangeFilter: (dateRange) => setFilters(f => ({ ...f, dateRange })),
    setSearchFilter: (q) => setFilters(f => ({ ...f, q })),
    setRepositoryFilter: (repository) => setFilters(f => ({ ...f, repository })),
    setOwnerFilter: (owner) => setFilters(f => ({ ...f, owner })),
    setReasonFilter: (reason) => setFilters(f => ({ ...f, reason })),
    setSubjectTypeFilter: (subjectType) => setFilters(f => ({ ...f, subjectType })),
    setSourceAccountFilter: (sourceAccount) => setFilters(f => ({ ...f, sourceAccount })),
    setParticipatingFilter: (participating) => setFilters(f => ({ ...f, participating })),
    replaceFilters: setFilters,
    setAttentionView: (view) => setFilters(f => ({
      ...f,
      state: view === 'unread' ? 'unread' : null,
      actionableOnly: view === 'action',
    })),
    resetFilters: () => setFilters(DEFAULT_NOTIFICATION_QUERY),
    sortNewest: filters.sort === 'newest',
    setSortNewest: (newest) => setFilters(f => ({ ...f, sort: newest ? 'newest' : 'oldest' })),
    markRead,
    markUnread,
    dismiss,
    handle,
    mute,
    unmute,
    archive,
    restore,
    actOnAllMatching,
    snooze,
    executeAction,
    markAllRead,
    loadMore,
    selectedId,
    setSelectedId,
    panelVisible,
    togglePanel,
    setPanelVisible,
    grouped,
    unreadNotifications,
    refresh,
  };
}
