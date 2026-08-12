'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion, useMotionValue, useTransform, type PanInfo, useReducedMotion } from 'motion/react';
import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  BellRing,
  ChartPie,
  CheckCheck,
  CheckCircle,
  ClipboardCheck,
  Clock,
  Inbox,
  Info,
  RefreshCw,
  Rocket,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { PullToRefreshIndicator } from '@/components/ui/PullToRefreshIndicator';
import { MobileSheet } from '@/components/ui/MobileSheet';
import {
  cancelExternalNavigation,
  completeExternalNavigation,
  prepareExternalNavigation,
} from '@/lib/notifications/external-navigation';
import { NotificationDetail } from '@/components/notifications/NotificationCard';
import { usePullToRefresh } from '@/lib/hooks/usePullToRefresh';
import { cn } from '@/lib/utils';
import { triggerHaptic } from '@/lib/utils/haptics';
import type { NotificationItem, NotificationLevel } from '@/types';
import { isNotificationUnread } from '@/lib/notifications/lifecycle';
import {
  NotificationFilterControls,
} from '@/components/notifications/NotificationFilterControls';
import type { NotificationFacets } from '@/lib/hooks/useNotifications';
import {
  hasActiveNotificationFilters,
  notificationQueriesEqual,
  parseNotificationQuery,
  serializeNotificationQuery,
  type NotificationQuery,
} from '@/lib/notifications/query';

const SWIPE_HANDLE_THRESHOLD = 88;

type BulkAction = 'read' | 'handle' | 'dismiss' | 'mute' | 'unmute';
type UnreadLevelStatKey = 'urgent' | 'actionNeeded' | 'headsUp' | 'fyi';

interface MobileNotificationStats {
  unread: number;
  actionable: number;
  urgent: number;
  actionNeeded: number;
  headsUp: number;
  fyi: number;
}

const LEVEL_FILTERS: Array<{
  value: NotificationLevel | null;
  label: string;
  countKey: 'unread' | UnreadLevelStatKey;
  icon: LucideIcon;
  badgeClassName: string;
}> = [
  { value: null, label: 'All', countKey: 'unread', icon: Inbox, badgeClassName: 'bg-slate-500' },
  { value: 'urgent', label: 'Urgent', countKey: 'urgent', icon: AlertTriangle, badgeClassName: 'bg-red-500' },
  { value: 'action_needed', label: 'Action', countKey: 'actionNeeded', icon: ClipboardCheck, badgeClassName: 'bg-amber-500' },
  { value: 'heads_up', label: 'Heads Up', countKey: 'headsUp', icon: BellRing, badgeClassName: 'bg-blue-500' },
  { value: 'fyi', label: 'FYI', countKey: 'fyi', icon: Info, badgeClassName: 'bg-slate-500' },
];

const UNREAD_LEVEL_STAT_KEYS: Partial<Record<NotificationLevel, UnreadLevelStatKey>> = {
  urgent: 'urgent',
  action_needed: 'actionNeeded',
  heads_up: 'headsUp',
  fyi: 'fyi',
};

interface MobileNotificationsScreenProps {
  /** Callback to navigate back */
  onBack: () => void;
}

interface NotificationsResponse {
  notifications?: NotificationItem[];
  facets?: NotificationFacets;
  matchingCount?: number;
  stats?: {
    unread?: number;
    actionable?: number;
    urgent?: number;
    actionNeeded?: number;
    headsUp?: number;
    fyi?: number;
  };
}

interface IconPresentation {
  icon: LucideIcon;
  circleClassName: string;
  iconClassName: string;
}

function getRelativeTimestamp(value: string): string {
  const timestamp = new Date(value);

  if (Number.isNaN(timestamp.getTime())) {
    return '';
  }

  const now = new Date();
  const diffMs = now.getTime() - timestamp.getTime();
  const diffMinutes = Math.floor(diffMs / 60000);

  if (diffMinutes < 1) return 'Just now';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours} ${diffHours === 1 ? 'hour' : 'hours'} ago`;
  }

  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);

  if (timestamp >= yesterdayStart && timestamp < todayStart) {
    return `Yesterday, ${timestamp.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    })}`;
  }

  const sameYear = timestamp.getFullYear() === now.getFullYear();
  return timestamp.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: 'numeric',
    minute: '2-digit',
  });
}

function adjustUnreadStats(
  current: MobileNotificationStats,
  items: NotificationItem[],
  direction: -1 | 1,
): MobileNotificationStats {
  const next = {
    ...current,
    unread: Math.max(0, current.unread + (items.length * direction)),
  };

  for (const item of items) {
    const statKey = UNREAD_LEVEL_STAT_KEYS[item.level];
    if (statKey) {
      next[statKey] = Math.max(0, next[statKey] + direction);
    }
  }

  return next;
}

function getSourceLabel(notification: NotificationItem): string {
  const source = notification.connectorType?.trim();
  if (!source) return 'Mission Control';

  return source
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function getNotificationIcon(notification: NotificationItem): IconPresentation {
  const category = notification.category.toLowerCase();
  const source = (notification.connectorType ?? '').toLowerCase();
  const body = (notification.body ?? '').toLowerCase();
  const title = notification.title.toLowerCase();
  const combined = `${category} ${source} ${title} ${body}`;

  if (combined.includes('sync') || combined.includes('refresh')) {
    return {
      icon: RefreshCw,
      circleClassName: 'bg-emerald-500/15',
      iconClassName: 'text-emerald-300',
    };
  }

  if (combined.includes('houston') || combined.includes('ai')) {
    return {
      icon: Rocket,
      circleClassName: 'bg-violet-500/15',
      iconClassName: 'text-violet-300',
    };
  }

  if (combined.includes('overdue') || combined.includes('time') || combined.includes('deadline')) {
    return {
      icon: Clock,
      circleClassName: 'bg-red-500/15',
      iconClassName: 'text-red-300',
    };
  }

  if (combined.includes('completed') || combined.includes('done') || combined.includes('success')) {
    return {
      icon: CheckCircle,
      circleClassName: 'bg-emerald-500/15',
      iconClassName: 'text-emerald-300',
    };
  }

  if (combined.includes('report') || combined.includes('digest') || combined.includes('summary')) {
    return {
      icon: ChartPie,
      circleClassName: 'bg-sky-500/15',
      iconClassName: 'text-sky-300',
    };
  }

  if (notification.level === 'urgent' || notification.level === 'action_needed') {
    return {
      icon: AlertTriangle,
      circleClassName: 'bg-red-500/15',
      iconClassName: 'text-red-300',
    };
  }

  return {
    icon: Bell,
    circleClassName: 'bg-slate-500/15',
    iconClassName: 'text-slate-300',
  };
}

async function bulkUpdate(ids: string[], action: BulkAction): Promise<void> {
  if (!ids.length) return;

  if (action === 'read') {
    for (const payloadAction of ['read', 'mark_read'] as const) {
      const response = await fetch('/api/notifications/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, action: payloadAction }),
      });

      if (response.ok) {
        return;
      }
    }

    throw new Error('Unable to mark notifications as read');
  }

  const response = await fetch('/api/notifications/bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action }),
  });

  if (!response.ok) {
    throw new Error(`Unable to ${action} notifications`);
  }
}

async function dismissNotification(id: string): Promise<void> {
  await bulkUpdate([id], 'dismiss');
}

async function markNotificationUnread(id: string): Promise<void> {
  const response = await fetch('/api/notifications', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [id], state: 'unread' }),
  });

  if (!response.ok) {
    throw new Error('Unable to mark notification as unread');
  }
}

function FilterTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-h-[44px] rounded-full px-3 py-1.5 text-xs font-medium transition-[background-color,border-color,color,box-shadow] duration-150',
        'backdrop-blur-xl',
        active
          ? 'bg-[rgba(10,132,255,0.20)] text-white ring-1 ring-inset ring-sky-400/30'
          : 'bg-[var(--surface-1)] border border-[var(--border-subtle)] text-slate-300 hover:text-[var(--text-primary)]'
      )}
    >
      {label}
    </button>
  );
}

function LevelFilterButton({
  active,
  badgeClassName,
  count,
  icon: Icon,
  label,
  onClick,
}: {
  active: boolean;
  badgeClassName: string;
  count: number;
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`${label}: ${count} unread`}
      aria-pressed={active}
      className={cn(
        'relative -mb-px flex min-h-[58px] flex-1 flex-col items-center justify-center gap-1 border-b-2 px-1 py-2 text-[10px] transition-colors',
        active
          ? 'border-[var(--accent)] text-[var(--accent)]'
          : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      )}
    >
      <span className="relative">
        <Icon className="h-[18px] w-[18px]" />
        {count > 0 && (
          <span
            className={cn(
              'absolute -right-4 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white',
              badgeClassName,
            )}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </span>
      <span>{label}</span>
    </button>
  );
}

function NotificationSkeleton() {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }).map((_, sectionIndex) => (
        <div key={sectionIndex} className="space-y-2">
          <div className="h-4 w-28 rounded-full bg-[var(--surface-2)] animate-pulse" />
          {Array.from({ length: 2 }).map((__, cardIndex) => (
            <div
              key={`${sectionIndex}-${cardIndex}`}
              className="rounded-[18px] border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 backdrop-blur-xl"
            >
              <div className="flex items-start gap-3">
                <div className="h-8 w-8 rounded-full bg-[var(--surface-2)] animate-pulse" />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="h-3.5 w-4/5 rounded-full bg-[var(--surface-2)] animate-pulse" />
                  <div className="h-3 w-full rounded-full bg-[var(--surface-2)]/80 animate-pulse" />
                  <div className="h-2.5 w-2/5 rounded-full bg-[var(--surface-2)]/70 animate-pulse" />
                </div>
                <div className="mt-1 h-2.5 w-2.5 rounded-full bg-sky-400/40 animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center px-8 text-center">
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-1)] backdrop-blur-xl">
        <Bell className="h-7 w-7 text-[var(--text-tertiary)]" />
      </div>
      <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
      <p className="mt-1 max-w-[20rem] text-sm text-[var(--text-secondary)]">{description}</p>
    </div>
  );
}

function NotificationRow({
  notification,
  onHandle,
  onOpen,
  prefersReducedMotion,
}: {
  notification: NotificationItem;
  onHandle: (id: string) => Promise<void>;
  onOpen: (notification: NotificationItem) => Promise<void>;
  prefersReducedMotion: boolean;
}) {
  const x = useMotionValue(0);
  const actionOpacity = useTransform(x, [-SWIPE_HANDLE_THRESHOLD, -16, 0], [1, 0.6, 0]);
  const [isRemoving, setIsRemoving] = useState(false);
  const wasDraggedRef = useRef(false);
  const hapticTriggered = useRef(false);

  const unread = isNotificationUnread(notification);
  const iconPresentation = getNotificationIcon(notification);
  const Icon = iconPresentation.icon;

  const handleNotification = useCallback(async () => {
    if (isRemoving) return;
    setIsRemoving(true);

    try {
      await onHandle(notification.id);
    } catch {
      setIsRemoving(false);
    }
  }, [isRemoving, notification.id, onHandle]);

  const handleDragStart = useCallback(() => {
    wasDraggedRef.current = false;
    hapticTriggered.current = false;
  }, []);

  const handleDrag = useCallback((_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (Math.abs(info.offset.x) > 8) {
      wasDraggedRef.current = true;
    }
    if (info.offset.x <= -SWIPE_HANDLE_THRESHOLD && !hapticTriggered.current) {
      triggerHaptic('medium');
      hapticTriggered.current = true;
    } else if (info.offset.x > -SWIPE_HANDLE_THRESHOLD) {
      hapticTriggered.current = false;
    }
  }, []);

  const handleDragEnd = useCallback(
    async (_: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
      if (info.offset.x <= -SWIPE_HANDLE_THRESHOLD) {
        triggerHaptic('heavy');
        await handleNotification();
        return;
      }

      x.set(0);
    },
    [handleNotification, x]
  );

  const handleActivate = useCallback(async () => {
    if (wasDraggedRef.current || isRemoving) {
      wasDraggedRef.current = false;
      return;
    }

    await onOpen(notification);
  }, [isRemoving, notification, onOpen]);

  const handleKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        await handleActivate();
      }
    },
    [handleActivate]
  );

  return (
    <motion.div
      layout
      initial={prefersReducedMotion ? undefined : { opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      exit={prefersReducedMotion ? undefined : { opacity: 0, x: -140, scale: 0.96, transition: { duration: 0.18 } }}
      transition={prefersReducedMotion ? { duration: 0 } : { duration: 0.2 }}
      className="relative overflow-hidden rounded-[18px]"
    >
      <motion.div
        aria-hidden="true"
        className="absolute inset-0 flex items-center justify-end rounded-[18px] bg-red-500/12 pr-5"
        style={{ opacity: actionOpacity }}
      >
        <div className="flex items-center gap-2 text-red-300">
          <Trash2 className="h-4 w-4" />
          <span className="text-xs font-medium">Handle</span>
        </div>
      </motion.div>

      <motion.div
        role="button"
        tabIndex={0}
        aria-label={`Notification: ${notification.title}. ${unread ? 'Unread.' : 'Read.'}`}
        className={cn(
          'relative flex min-h-[76px] cursor-pointer items-start gap-3 rounded-[18px] border p-4 backdrop-blur-xl outline-none transition-[background-color,border-color,box-shadow] duration-150',
          'focus-visible:ring-2 focus-visible:ring-[var(--accent)]/45 focus-visible:ring-offset-0',
          unread
            ? 'border-transparent ring-1 ring-inset ring-sky-400/15 bg-sky-500/5'
            : 'border-[var(--border-subtle)] bg-[var(--surface-1)]'
        )}
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -128, right: 0 }}
        dragElastic={{ left: 0.04, right: 0 }}
        dragMomentum={false}
        onDragStart={handleDragStart}
        onDrag={handleDrag}
        onDragEnd={handleDragEnd}
        onClick={() => {
          void handleActivate();
        }}
        onKeyDown={handleKeyDown}
      >
        <div
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            iconPresentation.circleClassName
          )}
        >
          <Icon className={cn('h-4 w-4', iconPresentation.iconClassName)} />
        </div>

        <div className="min-w-0 flex-1">
          <p
            className={cn(
              'truncate text-sm font-medium leading-5',
              unread ? 'text-slate-100' : 'text-slate-300'
            )}
          >
            {notification.title}
          </p>
          <p
            className={cn(
              'mt-0.5 line-clamp-2 text-xs leading-4',
              unread ? 'text-slate-400' : 'text-[var(--text-muted)]'
            )}
          >
            {notification.body?.trim() || getSourceLabel(notification)}
          </p>
          <div className="mt-1.5 flex items-center gap-2 text-xs leading-4">
            <span className="truncate text-[var(--text-muted)]">{getSourceLabel(notification)}</span>
            <span className="text-[var(--text-muted)]">•</span>
            <span className="shrink-0 text-[var(--text-muted)]">{getRelativeTimestamp(notification.receivedAt)}</span>
          </div>
        </div>

        <div className="mt-1.5 flex shrink-0 items-start justify-center">
          {unread ? (
            <span
              className="h-2 w-2 rounded-full bg-sky-400 shadow-[0_0_8px_rgba(56,189,248,0.45)]"
              aria-label="Unread"
            />
          ) : null}
        </div>
      </motion.div>
    </motion.div>
  );
}

export function MobileNotificationsScreen({ onBack }: MobileNotificationsScreenProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const backButtonRef = useRef<HTMLButtonElement>(null);
  const expectedUrlRef = useRef<string | null>(null);
  const applyingUrlRef = useRef(false);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<NotificationQuery>(() => parseNotificationQuery(searchParams));
  const [facets, setFacets] = useState<NotificationFacets>({
    level: {},
    category: {},
    source: {},
    state: {},
    merchant: [],
  });
  const [matchingCount, setMatchingCount] = useState(0);
  const [stats, setStats] = useState<MobileNotificationStats>({
    unread: 0,
    actionable: 0,
    urgent: 0,
    actionNeeded: 0,
    headsUp: 0,
    fyi: 0,
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshingList, setIsRefreshingList] = useState(false);
  const [isMarkingAllRead, setIsMarkingAllRead] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prefersReducedMotion = useReducedMotion() ?? false;
  const closeDetail = useCallback(() => {
    if (selectedId && filters.state === 'unread') {
      setNotifications(current => current.filter(notification => (
        notification.id !== selectedId || isNotificationUnread(notification)
      )));
    }
    setSelectedId(null);
  }, [filters.state, selectedId]);

  useEffect(() => {
    const current = searchParams.toString();
    if (expectedUrlRef.current === current) {
      expectedUrlRef.current = null;
      return;
    }
    const next = parseNotificationQuery(searchParams);
    setFilters(currentFilters => {
      if (notificationQueriesEqual(currentFilters, next)) return currentFilters;
      applyingUrlRef.current = true;
      return next;
    });
  }, [searchParams]);

  useEffect(() => {
    if (applyingUrlRef.current) {
      applyingUrlRef.current = false;
      return;
    }
    const params = serializeNotificationQuery(filters);
    const activeView = searchParams.get('view');
    if (activeView) params.set('view', activeView);
    const nextQuery = params.toString();
    if (nextQuery === searchParams.toString()) return;
    expectedUrlRef.current = nextQuery;
    router.replace(nextQuery ? `/notifications?${nextQuery}` : '/notifications', { scroll: false });
  }, [filters, router, searchParams]);

  const fetchNotifications = useCallback(async (signal?: AbortSignal) => {
    const params = serializeNotificationQuery(filters);
    const query = params.toString();
    const response = await fetch(`/api/notifications${query ? `?${query}` : ''}`, { signal });

    if (!response.ok) {
      throw new Error('Unable to load notifications');
    }

    const data: NotificationsResponse = await response.json();
    const items = data.notifications ?? [];
    setNotifications(items);
    setFacets(data.facets ?? { level: {}, category: {}, source: {}, state: {}, merchant: [] });
    setMatchingCount(Number(data.matchingCount ?? items.length));
    setStats({
      unread: data.stats?.unread ?? items.filter(isNotificationUnread).length,
      actionable: data.stats?.actionable ?? items.filter(item => item.isActionable).length,
      urgent: data.stats?.urgent ?? items.filter(item => item.level === 'urgent' && isNotificationUnread(item)).length,
      actionNeeded: data.stats?.actionNeeded ?? items.filter(item => item.level === 'action_needed' && isNotificationUnread(item)).length,
      headsUp: data.stats?.headsUp ?? items.filter(item => item.level === 'heads_up' && isNotificationUnread(item)).length,
      fyi: data.stats?.fyi ?? items.filter(item => item.level === 'fyi' && isNotificationUnread(item)).length,
    });
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();

    async function load() {
      setIsLoading(true);
      setError(null);

      try {
        await fetchNotifications(controller.signal);
      } catch (fetchError) {
        if ((fetchError as Error).name !== 'AbortError') {
          setError('Could not load notifications.');
        }
      } finally {
        setIsLoading(false);
      }
    }

    void load();

    return () => controller.abort();
  }, [fetchNotifications]);

  const refresh = useCallback(async () => {
    setIsRefreshingList(true);
    setError(null);

    try {
      await fetchNotifications();
    } catch {
      setError('Could not refresh notifications.');
    } finally {
      setIsRefreshingList(false);
    }
  }, [fetchNotifications]);

  const { containerRef, pullDistance, isRefreshing, containerProps, contentStyle } = usePullToRefresh({
    onRefresh: refresh,
    enabled: !isLoading,
  });

  const filteredNotifications = notifications;

  const handleMarkVisibleRead = useCallback(async () => {
    const unreadIds = filteredNotifications
      .filter(isNotificationUnread)
      .map((notification) => notification.id);

    if (!unreadIds.length) return;

    setIsMarkingAllRead(true);

    try {
      await bulkUpdate(unreadIds, 'read');
      setNotifications((current) => (
        filters.state === 'unread'
          ? current.filter(notification => !unreadIds.includes(notification.id))
          : current.map((notification) =>
              unreadIds.includes(notification.id)
                ? { ...notification, state: 'read', readState: 'read' }
                : notification
            )
      ));
      const readItems = filteredNotifications.filter(notification => unreadIds.includes(notification.id));
      setStats(current => adjustUnreadStats(current, readItems, -1));
    } catch {
      setError('Could not mark notifications as read.');
    } finally {
      setIsMarkingAllRead(false);
    }
  }, [filteredNotifications, filters.state]);

  const handleDismiss = useCallback(async (id: string) => {
    const dismissed = notifications.find(notification => notification.id === id);
    setNotifications((current) => current.filter((notification) => notification.id !== id));
    setStats(current => {
      const afterUnread = dismissed && isNotificationUnread(dismissed)
        ? adjustUnreadStats(current, [dismissed], -1)
        : current;
      return {
        ...afterUnread,
        actionable: dismissed?.isActionable
          ? Math.max(0, afterUnread.actionable - 1)
          : afterUnread.actionable,
      };
    });

    try {
      await dismissNotification(id);
    } catch (dismissError) {
      await fetchNotifications();
      throw dismissError;
    }
  }, [fetchNotifications, notifications]);

  const handleNotification = useCallback(async (id: string) => {
    const handled = notifications.find(notification => notification.id === id);
    setNotifications(current => current.filter(notification => notification.id !== id));
    setStats(current => {
      const afterUnread = handled && isNotificationUnread(handled)
        ? adjustUnreadStats(current, [handled], -1)
        : current;
      return {
        ...afterUnread,
        actionable: handled?.isActionable
          ? Math.max(0, afterUnread.actionable - 1)
          : afterUnread.actionable,
      };
    });
    try {
      await bulkUpdate([id], 'handle');
    } catch (handleError) {
      await fetchNotifications();
      throw handleError;
    }
  }, [fetchNotifications, notifications]);

  const muteNotification = useCallback(async (notification: NotificationItem) => {
    setNotifications(current => current.filter(item => item.id !== notification.id));
    try {
      await bulkUpdate(
        [notification.id],
        notification.mutedAt ? 'unmute' : 'mute',
      );
    } catch (muteError) {
      await fetchNotifications();
      throw muteError;
    }
  }, [fetchNotifications]);

  const handleOpenNotification = useCallback(
    async (notification: NotificationItem) => {
      setSelectedId(notification.id);

      if (isNotificationUnread(notification)) {
        setNotifications((current) =>
          current.map((item) => (
            item.id === notification.id
              ? { ...item, state: 'read', readState: 'read' }
              : item
          ))
        );
        setStats(current => adjustUnreadStats(current, [notification], -1));

        try {
          await bulkUpdate([notification.id], 'read');
        } catch {
          await fetchNotifications();
        }
      }

    },
    [fetchNotifications]
  );

  const executeAction = useCallback(async (notificationId: string, actionId: string) => {
    const action = notifications
      .find(notification => notification.id === notificationId)
      ?.actions?.find(candidate => candidate.id === actionId);
    const externalWindow = prepareExternalNavigation(action?.opensExternal === true);
    try {
      const response = await fetch(`/api/notifications/${notificationId}/actions/${actionId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!response.ok) {
        cancelExternalNavigation(externalWindow);
        return { success: false };
      }

      const result = await response.json();
      if (result.success && result.result) {
        if (result.result.url) {
          if (result.result.target === '_blank' || result.result.type === 'open_url') {
            completeExternalNavigation(externalWindow, result.result.url);
          } else {
            cancelExternalNavigation(externalWindow);
            router.push(result.result.url);
          }
        } else if (result.result.type === 'navigate' && result.result.target) {
          cancelExternalNavigation(externalWindow);
          router.push(result.result.target);
        } else {
          cancelExternalNavigation(externalWindow);
        }
      } else {
        cancelExternalNavigation(externalWindow);
      }
      await fetchNotifications();
      return result;
    } catch {
      cancelExternalNavigation(externalWindow);
      return { success: false };
    }
  }, [fetchNotifications, notifications, router]);

  const snoozeNotification = useCallback(async (id: string, duration: string) => {
    const response = await fetch(`/api/notifications/${id}/snooze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
    if (!response.ok) {
      throw new Error('Unable to snooze notification');
    }
    setSelectedId(null);
    await fetchNotifications();
  }, [fetchNotifications]);

  const selectedNotification = notifications.find(notification => notification.id === selectedId) || null;

  const hasActiveFilters = hasActiveNotificationFilters(filters);
  const emptyCopy = hasActiveFilters
    ? {
        title: 'No matching notifications',
        description: 'Try changing or clearing a filter.',
      }
    : {
        title: 'No notifications',
        description: 'When Mission Control has new activity, it will show up here.',
      };

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-[var(--surface-0)] text-[var(--text-primary)]"
      aria-label="Notifications screen"
    >
      <div className="px-5 pb-3 pt-4">
        <div className="flex items-start justify-between gap-3">
          <button
            ref={backButtonRef}
            type="button"
            onClick={onBack}
            className="mt-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-1)] text-[var(--text-primary)] backdrop-blur-xl transition-colors hover:bg-[var(--surface-2)]"
            aria-label="Go back"
          >
            <ArrowLeft className="h-4.5 w-4.5" />
          </button>

          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-xs font-medium uppercase tracking-[0.24em] text-sky-400/90">
              Activity
            </p>
            <h1 className="mt-1 text-[1.75rem] font-semibold leading-none text-[var(--text-primary)]">
              Notifications
            </h1>
          </div>

          <button
            type="button"
            onClick={() => {
              void handleMarkVisibleRead();
            }}
            disabled={isMarkingAllRead || !filteredNotifications.some(isNotificationUnread)}
            className={cn(
              'mt-1 flex min-h-[44px] min-w-[44px] items-center justify-center rounded-full border border-[var(--border-subtle)] bg-[var(--surface-1)] backdrop-blur-xl transition-colors',
              'text-[var(--text-primary)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50'
            )}
            aria-label="Mark all visible notifications as read"
          >
            <CheckCheck className={cn('h-4.5 w-4.5', isMarkingAllRead && 'animate-pulse')} />
          </button>
        </div>

        <div className="mt-4 flex items-stretch border-b border-[var(--border)]">
          {LEVEL_FILTERS.map(({ value, label, countKey, icon, badgeClassName }) => (
            <LevelFilterButton
              key={label}
              active={filters.level === value}
              badgeClassName={badgeClassName}
              count={stats[countKey]}
              icon={icon}
              label={label}
              onClick={() => {
                setSelectedId(null);
                setFilters(current => ({ ...current, level: value }));
              }}
            />
          ))}
        </div>

        <div
          role="group"
          aria-label="Notification attributes"
          className="mt-2 flex items-center gap-2 overflow-x-auto pb-0.5"
        >
          <FilterTabButton
            active={filters.state === 'unread'}
            label="Unread only"
            onClick={() => {
              setSelectedId(null);
              setFilters(current => ({
                ...current,
                state: current.state === 'unread' ? null : 'unread',
              }));
            }}
          />
          <FilterTabButton
            active={filters.actionableOnly}
            label="Actionable only"
            onClick={() => {
              setSelectedId(null);
              setFilters(current => ({ ...current, actionableOnly: !current.actionableOnly }));
            }}
          />
        </div>
        <NotificationFilterControls
          query={filters}
          facets={facets}
          onChange={next => {
            setSelectedId(null);
            setFilters(next);
          }}
          touchTargets
        />
        <p className="sr-only" aria-live="polite">
          {matchingCount} matching notifications
        </p>

        <MobileSheet
          isOpen={selectedNotification !== null}
          onClose={closeDetail}
          title="Notification details"
          ariaLabel={selectedNotification ? `Notification: ${selectedNotification.title}` : 'Notification detail'}
          height="full"
          returnFocusRef={backButtonRef}
        >
          {selectedNotification && (
            <NotificationDetail
              notification={selectedNotification}
              onExecuteAction={(actionId) => executeAction(selectedNotification.id, actionId)}
              onMarkRead={async () => {
                const nextState = isNotificationUnread(selectedNotification) ? 'read' : 'unread';
                if (nextState === 'read') {
                  await bulkUpdate([selectedNotification.id], 'read');
                } else {
                  await markNotificationUnread(selectedNotification.id);
                }
                setNotifications(current => current.map(notification => (
                  notification.id === selectedNotification.id
                    ? { ...notification, state: nextState, readState: nextState }
                    : notification
                )));
                setStats(current => adjustUnreadStats(
                  current,
                  [selectedNotification],
                  nextState === 'unread' ? 1 : -1,
                ));
              }}
              onDismiss={async () => {
                setSelectedId(null);
                await handleDismiss(selectedNotification.id);
              }}
              onArchive={async () => {
                setSelectedId(null);
                await handleNotification(selectedNotification.id);
              }}
              onSnooze={(duration) => snoozeNotification(selectedNotification.id, duration)}
              onMute={async () => {
                setSelectedId(null);
                await muteNotification(selectedNotification);
              }}
              className="min-h-[70vh]"
            />
          )}
        </MobileSheet>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-y-auto overscroll-y-contain"
        {...containerProps}
      >
        <PullToRefreshIndicator pullDistance={pullDistance} isRefreshing={isRefreshing || isRefreshingList} />

        <div style={contentStyle} className="px-5 pb-28 pt-4">
          {error ? (
            <div className="rounded-[18px] border border-red-400/20 bg-red-500/8 p-4 text-sm text-red-200">
              <p>{error}</p>
              <button
                type="button"
                onClick={() => {
                  void refresh();
                }}
                className="mt-3 min-h-[44px] rounded-full border border-red-300/20 px-4 text-sm font-medium text-red-100 transition-colors hover:bg-red-500/10"
              >
                Try again
              </button>
            </div>
          ) : isLoading ? (
            <NotificationSkeleton />
          ) : filteredNotifications.length === 0 ? (
            <EmptyState title={emptyCopy.title} description={emptyCopy.description} />
          ) : (
            <div className="space-y-2">
              <AnimatePresence initial={false}>
                {filteredNotifications.map((notification) => (
                  <NotificationRow
                    key={notification.id}
                    notification={notification}
                    onHandle={handleNotification}
                    onOpen={handleOpenNotification}
                    prefersReducedMotion={prefersReducedMotion}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default MobileNotificationsScreen;
