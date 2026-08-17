'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  BellRing,
  CheckCircle2,
  ClipboardCheck,
  Inbox,
  Info,
  Loader2,
  PanelRightClose,
  type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { NotificationCard, NotificationDetail } from './NotificationCard';
import type { UseNotificationsReturn } from '@/lib/hooks/useNotifications';
import type { NotificationItem, NotificationLevel } from '@/types';
import { isNotificationUnread } from '@/lib/notifications/lifecycle';
import { NavigationBadge } from '@/components/layout/NavigationBadge';
import { panelSlideFromRight } from '@/lib/motion';

interface NotificationsPanelProps {
  hook: UseNotificationsReturn;
}

const LEVEL_FILTERS: Array<{
  value: NotificationLevel | null;
  label: string;
  icon: LucideIcon;
  count: (stats: UseNotificationsReturn['stats']) => number;
  badgeClassName: string;
}> = [
  { value: null, label: 'All', icon: Inbox, count: stats => stats.unread, badgeClassName: 'bg-slate-500' },
  { value: 'urgent', label: 'Urgent', icon: AlertTriangle, count: stats => stats.urgent, badgeClassName: 'bg-red-500' },
  { value: 'action_needed', label: 'Action', icon: ClipboardCheck, count: stats => stats.actionNeeded, badgeClassName: 'bg-amber-500' },
  { value: 'heads_up', label: 'Heads Up', icon: BellRing, count: stats => stats.headsUp, badgeClassName: 'bg-blue-500' },
  { value: 'fyi', label: 'FYI', icon: Info, count: stats => stats.fyi, badgeClassName: 'bg-slate-500' },
];

function getLevelBadgeOffset(count: number) {
  if (count > 99) return '-right-5.5';
  if (count > 9) return '-right-4.5';
  return '-right-3.5';
}

export function NotificationsPanel({ hook }: NotificationsPanelProps) {
  const [selectedSnapshot, setSelectedSnapshot] = useState<(typeof hook.notifications)[number] | null>(null);
  const panelRef = useRef<HTMLElement>(null);
  const selectedTriggerRef = useRef<HTMLElement | null>(null);
  const selectedIdRef = useRef(hook.selectedId);
  const { grouped, stats, notifications } = hook;
  const { executeAction, setSelectedId } = hook;
  const selectedNotification = hook.selectedId
    ? notifications.find(item => item.id === hook.selectedId) || selectedSnapshot
    : null;
  const visibleCount = notifications.length;
  const notificationCenterParams = new URLSearchParams();
  if (hook.filters.level) notificationCenterParams.set('level', hook.filters.level);
  if (hook.filters.state === 'unread') notificationCenterParams.set('state', 'unread');
  if (hook.filters.actionableOnly) notificationCenterParams.set('actionableOnly', 'true');
  const notificationCenterHref = notificationCenterParams.size > 0
    ? `/notifications?${notificationCenterParams.toString()}`
    : '/notifications';
  const handleSelectSnapshot = useCallback((
    notification: NotificationItem,
    trigger: HTMLElement | null,
  ) => {
    setSelectedSnapshot(notification);
    selectedTriggerRef.current = trigger;
  }, []);

  const closePreview = useCallback((restoreFocus: boolean) => {
    setSelectedId(null);
    if (!restoreFocus) return;
    requestAnimationFrame(() => {
      const focusTarget = selectedTriggerRef.current?.isConnected
        ? selectedTriggerRef.current
        : panelRef.current?.querySelector<HTMLElement>('button');
      focusTarget?.focus();
    });
  }, [setSelectedId]);
  const handleExecuteAction = useCallback(async (notificationId: string, actionId: string) => {
    const result = await executeAction(notificationId, actionId);
    if (result.success && selectedIdRef.current === notificationId) {
      setSelectedId(null);
      setSelectedSnapshot(null);
    }
    return result;
  }, [executeAction, setSelectedId]);

  useEffect(() => {
    selectedIdRef.current = hook.selectedId;
  }, [hook.selectedId]);

  useEffect(() => {
    if (!selectedNotification) return;
    const focusPreview = requestAnimationFrame(() => {
      panelRef.current
        ?.querySelector<HTMLElement>('[aria-label="Notification preview"]')
        ?.focus();
    });
    return () => cancelAnimationFrame(focusPreview);
  }, [selectedNotification]);

  useEffect(() => {
    if (!selectedNotification) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) {
        closePreview(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closePreview(true);
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [closePreview, selectedNotification]);

  return (
    <aside
      ref={panelRef}
      key="notifications-panel"
      aria-label="Notifications"
      className="relative flex h-full w-[360px] flex-shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface-1)]"
    >
      <AnimatePresence>
        {selectedNotification && (
          <motion.section
            key={selectedNotification.id}
            variants={panelSlideFromRight}
            initial="hidden"
            animate="show"
            exit="exit"
            aria-label="Notification preview"
            tabIndex={-1}
            className="absolute right-full top-3 z-40 mr-3 h-[min(620px,calc(100vh-6rem))] w-[420px] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl shadow-black/50"
          >
            <NotificationDetail
              notification={selectedNotification}
              onClose={() => closePreview(true)}
              onExecuteAction={(actionId) => handleExecuteAction(selectedNotification.id, actionId)}
              onMarkRead={async () => {
                if (isNotificationUnread(selectedNotification)) {
                  await hook.markRead([selectedNotification.id]);
                  return;
                }
                await hook.markUnread([selectedNotification.id]);
              }}
              onDismiss={async () => {
                hook.setSelectedId(null);
                setSelectedSnapshot(null);
                await hook.dismiss([selectedNotification.id]);
              }}
              onSnooze={(duration) => hook.snooze(selectedNotification.id, duration)}
              onMute={async () => {
                hook.setSelectedId(null);
                setSelectedSnapshot(null);
                await (selectedNotification.mutedAt
                  ? hook.unmute([selectedNotification.id])
                  : hook.mute([selectedNotification.id]));
              }}
              className="h-full"
            />
          </motion.section>
        )}
      </AnimatePresence>

      <div className="p-4 pb-0">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Bell size={15} />
            Notifications
            {stats.attention > 0 && (
              <span className="rounded-full border border-blue-400/40 bg-blue-500 px-1.5 py-0.5 text-xs font-semibold leading-none text-white">
                {stats.attention}
              </span>
            )}
            </h3>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {stats.attention} need attention · {stats.actionable} with actions
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              onClick={hook.markAllRead}
              className="text-xs text-[var(--accent)] hover:text-blue-300 transition-colors"
            >
              Mark all read
            </button>
            <button
              onClick={hook.togglePanel}
              className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
              aria-label="Hide notifications"
            >
              <PanelRightClose size={13} />
            </button>
          </div>
        </div>

        <div className="mb-2 flex items-stretch border-b border-[var(--border)]">
          {LEVEL_FILTERS.map(({ value, label, icon: Icon, count, badgeClassName }) => {
            const unreadCount = count(stats);
            const active = hook.filters.level === value;
            return (
              <button
                key={label}
                type="button"
                onClick={() => {
                  hook.setSelectedId(null);
                  setSelectedSnapshot(null);
                  hook.setLevelFilter(value);
                }}
                aria-label={`${label}: ${unreadCount} unread`}
                aria-pressed={active}
                className={`relative -mb-px flex flex-1 flex-col items-center gap-1 border-b-2 py-2 text-[10px] transition-colors ${
                  active
                    ? 'border-[var(--accent)] text-[var(--accent)]'
                    : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                }`}
              >
                <span className="relative">
                  <Icon size={17} />
                  {unreadCount > 0 && (
                    <span className={`absolute ${getLevelBadgeOffset(unreadCount)} -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-bold leading-none text-white ${badgeClassName}`}>
                      {unreadCount > 99 ? '99+' : unreadCount}
                    </span>
                  )}
                </span>
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        <div
          role="group"
          aria-label="Notification attributes"
          className="mb-3 flex items-center gap-2"
        >
          <button
            type="button"
            onClick={() => {
              hook.setSelectedId(null);
              setSelectedSnapshot(null);
              hook.setStateFilter(hook.filters.state === 'unread' ? null : 'unread');
            }}
            aria-pressed={hook.filters.state === 'unread'}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              hook.filters.state === 'unread'
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Unread only
          </button>
          <button
            type="button"
            onClick={() => {
              hook.setSelectedId(null);
              setSelectedSnapshot(null);
              hook.setActionableOnly(!hook.filters.actionableOnly);
            }}
            aria-pressed={hook.filters.actionableOnly}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
              hook.filters.actionableOnly
                ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent)]'
                : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
            }`}
          >
            Actionable only
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-4">
        {hook.isLoading && visibleCount === 0 ? (
          <div className="flex h-full items-center justify-center" role="status">
            <Loader2 size={18} className="animate-spin text-[var(--text-muted)]" />
            <span className="ml-2 text-sm text-[var(--text-muted)]">Loading notifications…</span>
          </div>
        ) : hook.error ? (
          <div className="flex h-full flex-col items-center justify-center px-4 text-center" role="alert">
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
        ) : visibleCount === 0 ? (
          <div className="py-6 text-center">
            <CheckCircle2 size={24} className="mx-auto mb-2 text-emerald-400" aria-hidden="true" />
            <p className="text-sm text-[var(--text-secondary)]">All caught up</p>
            <p className="text-xs text-[var(--text-muted)] mt-1">
              No notifications match this view
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <NotificationGroup label="Today" items={grouped.today} hook={hook} onSelectSnapshot={handleSelectSnapshot} onExecuteAction={handleExecuteAction} />
            <NotificationGroup label="Yesterday" items={grouped.yesterday} hook={hook} onSelectSnapshot={handleSelectSnapshot} onExecuteAction={handleExecuteAction} />
            <NotificationGroup label="This Week" items={grouped.thisWeek} hook={hook} onSelectSnapshot={handleSelectSnapshot} onExecuteAction={handleExecuteAction} />
            <NotificationGroup label="Older" items={grouped.older} hook={hook} onSelectSnapshot={handleSelectSnapshot} onExecuteAction={handleExecuteAction} />
          </div>
        )}
      </div>

      <div className="p-3 border-t border-[var(--border)]">
        <Link
          href={notificationCenterHref}
          className="flex items-center justify-center gap-1 text-xs text-[var(--accent)] hover:text-blue-300 transition-colors"
        >
          Open notification center →
        </Link>
      </div>
    </aside>
  );
}

// ─── NOTIFICATION GROUP ─────────────────────────────────────────────────────

function NotificationGroup({
  label,
  items,
  hook,
  onSelectSnapshot,
  onExecuteAction,
}: {
  label: string;
  items: typeof hook.notifications;
  hook: UseNotificationsReturn;
  onSelectSnapshot: (
    notification: (typeof hook.notifications)[number],
    trigger: HTMLElement | null,
  ) => void;
  onExecuteAction: (notificationId: string, actionId: string) => Promise<{ success: boolean }>;
}) {
  if (items.length === 0) return null;

  return (
    <div>
      <h4 className="text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider mb-2">
        {label}
      </h4>
      <div className="space-y-2">
        <AnimatePresence mode="popLayout">
          {items.map((notification) => (
            <NotificationCard
              key={notification.id}
              notification={notification}
              isSelected={hook.selectedId === notification.id}
              panel
              onSelect={() => {
                onSelectSnapshot(isNotificationUnread(notification)
                  ? { ...notification, state: 'read', readState: 'read', readAt: new Date().toISOString() }
                  : notification,
                document.activeElement instanceof HTMLElement ? document.activeElement : null);
                hook.setSelectedId(notification.id);
                if (isNotificationUnread(notification)) {
                  void hook.markRead([notification.id]);
                }
              }}
              onMarkRead={() => {
                if (isNotificationUnread(notification)) hook.markRead([notification.id]);
                else hook.markUnread([notification.id]);
              }}
              onHandle={async () => {
                await hook.handle([notification.id]);
              }}
              onSnooze={(duration) => hook.snooze(notification.id, duration)}
              onMute={() => notification.mutedAt
                ? hook.unmute([notification.id])
                : hook.mute([notification.id])}
              onExecuteAction={(actionId) => onExecuteAction(notification.id, actionId)}
            />
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── COLLAPSED RAIL ─────────────────────────────────────────────────────────

export function CollapsedNotificationsRail({
  attentionCount,
  urgentCount,
  actionCount,
  onExpand,
}: {
  attentionCount: number;
  urgentCount: number;
  actionCount: number;
  onExpand: () => void;
}) {
  const displayCount = attentionCount;
  const badgeTone = urgentCount > 0 ? 'red' : actionCount > 0 ? 'amber' : 'blue';

  return (
    <aside
      key="notifications-rail"
      aria-label="Notifications (collapsed)"
      className="w-12 bg-[var(--surface-1)] border-l border-[var(--border)] py-3 flex flex-col items-center flex-shrink-0"
    >
      <button
        onClick={onExpand}
        className="relative p-2 rounded-[var(--radius-md)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors duration-100"
        aria-label="Show notifications"
        title="Show notifications"
      >
        <Bell size={16} />
        <NavigationBadge count={displayCount} tone={badgeTone} overlay />
      </button>
    </aside>
  );
}
