'use client';

import { useEffect, useMemo, useState } from 'react';
import Image from 'next/image';
import {
  AlertCircle, AlertTriangle, Info, MessageCircle, Newspaper,
  ExternalLink, Plus, ArrowRight, CheckCircle, XCircle,
  Eye, EyeOff, Clock, X, Sparkles,
  Server, CheckSquare, DollarSign, Home, AtSign, Package, Truck,
  GitPullRequest, Shield, BarChart3, Zap, Archive, LoaderCircle, BellOff,
  RefreshCw,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Tooltip } from '@/components/ui/Tooltip';
import { formatTimeAgo } from '@/lib/utils/dashboard-helpers';
import type { InboundNotification, NotificationItem, NotificationAction } from '@/types';
import type {
  NotificationRichContent,
  NotificationPresentationTone,
} from '@/lib/notifications/providers';
import { resolveNotificationProvider } from '@/lib/notifications/providers';
import { isNotificationUnread } from '@/lib/notifications/lifecycle';
import {
  NOTIFICATION_LEVELS,
  NOTIFICATION_SOURCE_ICONS,
  NOTIFICATION_SOURCE_LABELS,
} from '@/types/dashboard';
import { formatNotificationCategoryLabel } from '@/lib/notifications/categories';

// ─── ICON MAPS ──────────────────────────────────────────────────────────────

const LEVEL_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  urgent: AlertCircle,
  action_needed: AlertTriangle,
  heads_up: Info,
  fyi: MessageCircle,
  digest: Newspaper,
};

const CATEGORY_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  system: Server,
  tasks: CheckSquare,
  development: GitPullRequest,
  finance: DollarSign,
  home: Home,
  social: AtSign,
  ai_insights: Sparkles,
  packages: Package,
  pr_review: GitPullRequest,
  security: Shield,
  analytics: BarChart3,
  shipping: Truck,
  automation: Zap,
};

const ACTION_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  open_url: ExternalLink,
  create_task: Plus,
  navigate: ArrowRight,
  approve: CheckCircle,
  reject: XCircle,
  run_workflow: Zap,
  dismiss: X,
  snooze: Clock,
  complete_task: CheckCircle,
  dismiss_reminder: X,
  remind_later: Clock,
};

// ─── TYPES ──────────────────────────────────────────────────────────────────

interface NotificationCardProps {
  notification: NotificationItem;
  isSelected?: boolean;
  compact?: boolean;
  panel?: boolean;
  onSelect?: () => void;
  onMarkRead?: () => void;
  onHandle?: () => void;
  onSnooze?: (duration: string) => void;
  onMute?: () => void;
  onExecuteAction?: (
    actionId: string,
    params?: Record<string, unknown>,
  ) => void | Promise<{ success: boolean }>;
}

interface PresentationMetadataChip {
  label?: string;
  value: string;
}

interface NotificationPresentation {
  subtitle?: string;
  sourceName?: string;
  repository?: string;
  subjectType?: string;
  entityNumber?: number;
  reasonLabel?: string;
  metadataChips?: Array<string | PresentationMetadataChip>;
  richContent?: NotificationRichContent;
}

function WritebackStatus({ notification }: { notification: NotificationItem }) {
  const [status, setStatus] = useState(notification.syncState);
  const [retryable, setRetryable] = useState(false);
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (status === 'synced') return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch(
          `/api/notifications/writebacks?notificationId=${encodeURIComponent(notification.id)}`,
        );
        if (!response.ok) return;
        const result = await response.json();
        if (!cancelled) {
          setStatus(result.syncState);
          setRetryable(result.retryable === true);
        }
      } catch {
        // Keep the last durable state visible while the status endpoint is unavailable.
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [notification.id, status]);

  if (status === 'synced') return null;

  const retry = async () => {
    setRetrying(true);
    try {
      const response = await fetch('/api/notifications/writebacks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ notificationIds: [notification.id] }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) {
        toast.error('This provider update is not retryable');
        return;
      }
      setStatus('pending');
      toast.success('Provider update queued');
    } catch {
      toast.error('Could not retry provider update');
    } finally {
      setRetrying(false);
    }
  };

  return status === 'failed' && retryable ? (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        void retry();
      }}
      disabled={retrying}
      className="pointer-events-auto inline-flex items-center gap-1 rounded bg-red-900/30 px-1.5 py-0.5 text-xs text-red-300"
      aria-label="Retry failed provider update"
    >
      <RefreshCw size={10} className={retrying ? 'animate-spin' : ''} />
      Sync failed
    </button>
  ) : status === 'failed' ? (
    <span
      role="status"
      className="inline-flex items-center gap-1 rounded bg-red-900/30 px-1.5 py-0.5 text-xs text-red-300"
    >
      <XCircle size={10} />
      Provider update failed
    </span>
  ) : (
    <span
      role="status"
      className="inline-flex items-center gap-1 rounded bg-amber-900/30 px-1.5 py-0.5 text-xs text-amber-300"
    >
      <LoaderCircle size={10} className="animate-spin" />
      Provider update pending
    </span>
  );
}

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

function humanizeIdentifier(value: string): string {
  return value
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase())
    .replace(/\b(Ai|Api|Ci|Id|Pr|Url)\b/g, acronym => acronym.toUpperCase());
}

function formatCurrency(value: number): string {
  return CURRENCY_FORMATTER.format(value);
}

function getMetadataChips(
  presentation: NotificationPresentation,
  metadata: Record<string, unknown>,
): PresentationMetadataChip[] {
  const chips: PresentationMetadataChip[] = [];
  const configuredChips = presentation.metadataChips;

  if (Array.isArray(configuredChips)) {
    for (const chip of configuredChips) {
      if (chips.length === 4) break;

      if (typeof chip === 'string' && chip.trim()) {
        chips.push({ value: chip.trim() });
      } else if (
        chip &&
        typeof chip === 'object' &&
        typeof chip.value === 'string' &&
        chip.value.trim()
      ) {
        chips.push({
          label: typeof chip.label === 'string' ? chip.label : undefined,
          value: chip.value.trim(),
        });
      }
    }
  }

  if (
    chips.length === 0
    && presentation.subjectType
    && typeof presentation.entityNumber === 'number'
    && Number.isFinite(presentation.entityNumber)
  ) {
    chips.push({ value: `${humanizeIdentifier(presentation.subjectType)} #${presentation.entityNumber}` });
  }

  if (chips.length === 0 && presentation.reasonLabel) {
    chips.push({ value: presentation.reasonLabel });
  }

  const spent = typeof metadata.spent === 'number' && Number.isFinite(metadata.spent)
    ? metadata.spent
    : null;
  const budget = typeof metadata.budget === 'number' && Number.isFinite(metadata.budget)
    ? metadata.budget
    : typeof metadata.limit === 'number' && Number.isFinite(metadata.limit)
      ? metadata.limit
      : null;
  const ratio = typeof metadata.ratio === 'number' && Number.isFinite(metadata.ratio)
    ? metadata.ratio
    : spent !== null && budget !== null && budget > 0
      ? spent / budget
      : null;

  if (spent !== null && budget !== null && spent > budget) {
    chips.push({ value: `${formatCurrency(spent - budget)} over` });
  }
  if (ratio !== null) {
    chips.push({ value: `${Math.round(ratio * 100)}% used` });
  }
  if (
    typeof metadata.reviewerCount === 'number'
    && Number.isFinite(metadata.reviewerCount)
    && metadata.reviewerCount >= 0
  ) {
    chips.push({ value: `${metadata.reviewerCount} ${metadata.reviewerCount === 1 ? 'reviewer' : 'reviewers'}` });
  }
  if (
    typeof metadata.unreadCount === 'number'
    && Number.isFinite(metadata.unreadCount)
    && metadata.unreadCount >= 0
  ) {
    chips.push({ value: `${metadata.unreadCount} unread` });
  }
  if (Array.isArray(metadata.charges) && metadata.charges.length > 1) {
    chips.push({ value: `${metadata.charges.length} duplicate subscriptions` });
  }
  if (typeof metadata.dueDate === 'string' && metadata.dueDate.trim()) {
    chips.push({ label: 'Due', value: metadata.dueDate.trim() });
  }
  if (typeof metadata.connectorState === 'string' && metadata.connectorState.trim()) {
    chips.push({ label: 'Status', value: humanizeIdentifier(metadata.connectorState.trim()) });
  }

  return chips.slice(0, 4);
}

function useNotificationDisplay(notification: NotificationItem) {
  const providerFallback = useMemo(() => {
    const resolved = resolveNotificationProvider({
      id: notification.id,
      sourceId: notification.sourceId,
      connectorType: notification.connectorType,
      connectorInstanceId: notification.connectorInstanceId,
      title: notification.title,
      body: notification.body || undefined,
      level: notification.level,
      category: notification.category,
      isRead: !isNotificationUnread(notification),
      isActionable: notification.isActionable,
      receivedAt: notification.receivedAt,
      hubProjectIds: [],
      tags: [],
      metadata: notification.metadata,
    } satisfies InboundNotification);
    return resolved?.presentation.presentation || {};
  }, [notification]);
  const presentation = {
    ...providerFallback,
    ...(notification.presentation ?? {}),
  } as NotificationPresentation;
  const metadata = notification.metadata ?? {};
  const presentationSourceName = presentation.sourceName?.trim();
  const metadataSourceName = typeof metadata.sourceName === 'string'
    ? metadata.sourceName.trim()
    : null;
  const sourceName = presentationSourceName
    || metadataSourceName
    || NOTIFICATION_SOURCE_LABELS[notification.connectorType]
    || humanizeIdentifier(notification.connectorType)
    || 'Mission Control';
  const aiSummary = typeof metadata.aiSummary === 'string' ? metadata.aiSummary : null;

  return {
    presentation,
    sourceName,
    displayBody: aiSummary || notification.body,
    metadataChips: getMetadataChips(presentation, metadata),
    richContent: presentation.richContent,
  };
}

// ─── COMPONENT ──────────────────────────────────────────────────────────────

export function NotificationCard({
  notification,
  isSelected = false,
  compact = false,
  panel = false,
  onSelect,
  onMarkRead,
  onHandle,
  onSnooze,
  onMute,
  onExecuteAction,
}: NotificationCardProps) {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const levelConfig = NOTIFICATION_LEVELS[notification.level] || NOTIFICATION_LEVELS.fyi;
  const LevelIcon = LEVEL_ICONS[notification.level] || Info;
  const CategoryIcon = CATEGORY_ICONS[notification.category] || CATEGORY_ICONS.system;
  const isUnread = isNotificationUnread(notification);
  const sourceIcon = NOTIFICATION_SOURCE_ICONS[notification.connectorType];
  const {
    presentation,
    sourceName,
    displayBody,
    metadataChips,
    richContent,
  } = useNotificationDisplay(notification);
  const presentationSubtitle = presentation.subtitle || null;

  const primaryAction = useMemo(() =>
    notification.actions?.find(a => a.isPrimary),
    [notification.actions]
  );

  const secondaryActions = useMemo(() =>
    notification.actions?.filter(a => !a.isPrimary).slice(0, 3) || [],
    [notification.actions]
  );

  const aiSuggested = notification.aiSuggestedActionId;

  const handleInlineAction = async (
    action: NotificationAction,
    params?: Record<string, unknown>,
  ) => {
    if (!onExecuteAction) return;
    if (
      action.requiresConfirmation
      && !window.confirm(`Are you sure you want to ${action.label.toLowerCase()}?`)
    ) {
      return;
    }

    setPendingActionId(action.id);
    try {
      const result = await onExecuteAction(action.id, params);
      if (result?.success === false) {
        toast.error(`${action.label} failed`);
      }
    } catch {
      toast.error(`${action.label} failed`);
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className={`
        group relative rounded-lg p-3 cursor-pointer transition-all duration-150
        bg-[var(--surface-1)] border-l-[3px] ${levelConfig.borderColor} border-y border-r border-y-[var(--border)]/40 border-r-[var(--border)]/40
        ${isSelected ? 'ring-1 ring-[var(--accent)]/50 bg-[var(--surface-2)]/40 shadow-lg shadow-black/30' : 'hover:bg-[var(--surface-2)]/50 hover:shadow-md hover:shadow-black/20'}
        ${isUnread ? 'shadow-[inset_0_0_0_1px_rgba(59,130,246,0.15)]' : 'opacity-60'}
      `}
    >
      {onSelect && (
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Open ${notification.title}`}
          aria-pressed={isSelected}
          className="absolute inset-0 z-0 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        />
      )}
      {/* Header row: source icon + title + level icon (top-right) */}
      <div className="pointer-events-none relative z-10 flex items-start gap-2.5">
        {/* Source icon */}
        <div className="flex-shrink-0 mt-0.5">
          {sourceIcon ? (
            <Image
              src={sourceIcon}
              alt=""
              title={sourceName}
              width={24}
              height={24}
              className="w-6 h-6 rounded"
            />
          ) : (
            <div
              title={sourceName}
              aria-label={sourceName}
              className={`w-6 h-6 rounded flex items-center justify-center bg-[var(--surface-2)] ${levelConfig.color}`}
            >
              <CategoryIcon size={14} />
            </div>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          {/* Title row */}
          <div className="flex items-center gap-1.5">
            {isUnread && (
              <div className="w-2 h-2 bg-blue-400 rounded-full flex-shrink-0 shadow-[0_0_4px_rgba(96,165,250,0.6)]" />
            )}
            <p className={`text-sm font-medium ${compact ? 'truncate' : 'line-clamp-2'} ${isUnread ? 'text-[var(--text-primary)] font-semibold' : 'text-[var(--text-secondary)]'}`}>
              {notification.title}
            </p>
          </div>

          {/* Rich subtitle from presentation metadata */}
          {presentationSubtitle && (
            <p className="text-xs text-[var(--accent)] mt-0.5 truncate font-medium">
              {presentationSubtitle}
            </p>
          )}

          {/* Rows stay compact; full content belongs in the detail surface. */}
          {displayBody && !compact && !richContent && (
            <p className="text-xs text-[var(--text-tertiary)] mt-1 leading-relaxed line-clamp-2">
              {displayBody}
            </p>
          )}

          {metadataChips.length > 0 && !compact && !richContent && (
            <div className="flex items-center gap-1.5 mt-2 flex-wrap" aria-label="Notification metadata">
              {metadataChips.map((chip, index) => (
                <span
                  key={`${chip.label || ''}-${chip.value}-${index}`}
                  className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-1.5 py-0.5 text-xs text-[var(--text-secondary)]"
                >
                  {chip.label && <span className="text-[var(--text-muted)]">{chip.label}:</span>}
                  {chip.value}
                </span>
              ))}
            </div>
          )}

          {richContent && !compact && !panel && <RichNotificationContent content={richContent} />}

          {/* Meta row: source + category + level + time */}
          <div className="flex items-center gap-2 mt-1.5 flex-wrap">
            <span
              className="max-w-48 truncate text-xs font-medium text-[var(--text-secondary)]"
              title={sourceName}
            >
              {sourceName}
            </span>
            <span className="text-[var(--text-muted)]" aria-hidden="true">·</span>
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <CategoryIcon size={10} className="opacity-60" />
              {formatNotificationCategoryLabel(notification.category)}
            </span>
            <span className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md ${levelConfig.pillClass}`}>
              <LevelIcon size={10} />
              {levelConfig.label}
            </span>
            <span className="text-xs text-[var(--text-muted)]">
              {formatTimeAgo(notification.receivedAt)}
            </span>
            <WritebackStatus
              key={`${notification.id}:${notification.syncState}`}
              notification={notification}
            />
          </div>

          {/* Actions row — severity-colored buttons */}
          {!compact && (primaryAction || (!panel && secondaryActions.length > 0)) && (
            <div className="pointer-events-auto flex items-center gap-2 mt-2.5">
              {primaryAction && (
                <ActionButton
                  action={primaryAction}
                  isPrimary
                  levelConfig={levelConfig}
                  isAiSuggested={primaryAction.id === aiSuggested}
                  isLoading={pendingActionId === primaryAction.id}
                  disabled={pendingActionId !== null}
                  onClick={() => void handleInlineAction(primaryAction)}
                />
              )}
              {!panel && secondaryActions.map(action => (
                action.actionType === 'remind_later' ? (
                  <RemindLaterButton
                    key={action.id}
                    action={action}
                    disabled={pendingActionId !== null}
                    isLoading={pendingActionId === action.id}
                    onSelect={(duration) => void handleInlineAction(action, { duration })}
                  />
                ) : (
                  <ActionButton
                    key={action.id}
                    action={action}
                    levelConfig={levelConfig}
                    isAiSuggested={action.id === aiSuggested}
                    isLoading={pendingActionId === action.id}
                    disabled={pendingActionId !== null}
                    onClick={() => void handleInlineAction(action)}
                  />
                )
              ))}
            </div>
          )}
        </div>

        {/* Top-right: Level severity icon (larger, color-coded) */}
        <div className={`flex-shrink-0 ${levelConfig.color}`}>
          <LevelIcon size={20} />
        </div>
      </div>

      {/* Bottom toolbar: mark read, snooze, dismiss, pin — always visible */}
      {!compact && !panel && (
      <div className="pointer-events-auto relative z-10 flex items-center gap-1 mt-2.5 pt-2 border-t border-[var(--border)]/50">
        {isUnread ? (
          <Tooltip content="Mark read">
            <button
              onClick={(e) => { e.stopPropagation(); onMarkRead?.(); }}
              aria-label="Mark notification as read"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-900/20 transition-colors"
            >
              <Eye size={15} />
            </button>
          </Tooltip>
        ) : (
          <Tooltip content="Mark unread">
            <button
              onClick={(e) => { e.stopPropagation(); onMarkRead?.(); }}
              aria-label="Mark notification as unread"
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-blue-400 hover:bg-blue-900/20 transition-colors"
            >
              <EyeOff size={15} />
            </button>
          </Tooltip>
        )}
        <SnoozeMenu onSnooze={onSnooze} />
        {notification.connectorType === 'github-issues' && onMute && (
          <Tooltip content={notification.mutedAt ? 'Unmute' : 'Mute'}>
            <button
              onClick={(event) => { event.stopPropagation(); onMute(); }}
              aria-label={notification.mutedAt ? 'Unmute notification' : 'Mute notification'}
              className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-900/20 transition-colors"
            >
              <BellOff size={15} />
            </button>
          </Tooltip>
        )}
        <Tooltip content="Handle">
          <button
            onClick={(e) => { e.stopPropagation(); onHandle?.(); }}
            aria-label="Handle notification"
            className="p-1.5 rounded-md text-[var(--text-muted)] hover:text-emerald-400 hover:bg-emerald-900/20 transition-colors"
          >
            <Archive size={15} />
          </button>
        </Tooltip>
      </div>
      )}
    </motion.div>
  );
}

export interface NotificationDetailProps {
  notification: NotificationItem;
  onExecuteAction: (
    actionId: string,
    params?: Record<string, unknown>,
  ) => Promise<{ success: boolean }>;
  onMarkRead?: () => void | Promise<void>;
  onDismiss?: () => void | Promise<void>;
  onArchive?: () => void | Promise<void>;
  onSnooze?: (duration: string) => void | Promise<void>;
  onMute?: () => void | Promise<void>;
  onClose?: () => void;
  className?: string;
}

export function NotificationDetail({
  notification,
  onExecuteAction,
  onMarkRead,
  onDismiss,
  onArchive,
  onSnooze,
  onMute,
  onClose,
  className = '',
}: NotificationDetailProps) {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const levelConfig = NOTIFICATION_LEVELS[notification.level] || NOTIFICATION_LEVELS.fyi;
  const LevelIcon = LEVEL_ICONS[notification.level] || Info;
  const CategoryIcon = CATEGORY_ICONS[notification.category] || CATEGORY_ICONS.system;
  const sourceIcon = NOTIFICATION_SOURCE_ICONS[notification.connectorType];
  const {
    presentation,
    sourceName,
    displayBody,
    metadataChips,
    richContent,
  } = useNotificationDisplay(notification);
  const primaryAction = notification.actions?.find(action => action.isPrimary);
  const secondaryActions = notification.actions?.filter(action => !action.isPrimary).slice(0, 3) || [];

  const handleAction = async (
    action: NotificationAction,
    params?: Record<string, unknown>,
  ) => {
    if (
      action.requiresConfirmation
      && !window.confirm(`Are you sure you want to ${action.label.toLowerCase()}?`)
    ) {
      return;
    }

    setPendingActionId(action.id);
    try {
      const result = await onExecuteAction(action.id, params);
      if (result.success) {
        toast.success(`${action.label} completed`);
      } else {
        toast.error(`${action.label} failed`);
      }
    } catch {
      toast.error(`${action.label} failed`);
    } finally {
      setPendingActionId(null);
    }
  };

  return (
    <div className={`flex min-h-0 flex-col bg-[var(--surface-1)] ${className}`}>
      <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
        <div className="flex min-w-0 items-center gap-3">
          {sourceIcon ? (
            <Image
              src={sourceIcon}
              alt=""
              width={32}
              height={32}
              className="h-8 w-8 rounded-md"
            />
          ) : (
            <div
              aria-label={sourceName}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-[var(--surface-2)] ${levelConfig.color}`}
            >
              <CategoryIcon size={16} />
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-[var(--text-secondary)]">{sourceName}</p>
            <p className="mt-0.5 text-xs text-[var(--text-muted)]">
              {formatNotificationCategoryLabel(notification.category)} · {formatTimeAgo(notification.receivedAt)}
            </p>
          </div>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close notification preview"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div className="mb-3 flex items-center gap-2">
          <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${levelConfig.pillClass}`}>
            <LevelIcon size={11} />
            {levelConfig.label}
          </span>
          {isNotificationUnread(notification) && (
            <span className="text-xs font-medium text-blue-400">Unread</span>
          )}
          <WritebackStatus
            key={`${notification.id}:${notification.syncState}`}
            notification={notification}
          />
        </div>

        <h2 className="text-lg font-semibold leading-6 text-[var(--text-primary)]">
          {notification.title}
        </h2>
        {presentation.subtitle && (
          <p className="mt-1 text-sm font-medium text-[var(--accent)]">{presentation.subtitle}</p>
        )}
        {displayBody && (
          <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-[var(--text-secondary)]">
            {displayBody}
          </p>
        )}

        {metadataChips.length > 0 && (
          <div className="mt-4 flex flex-wrap gap-2" aria-label="Notification details">
            {metadataChips.map((chip, index) => (
              <span
                key={`${chip.label || ''}-${chip.value}-${index}`}
                className="inline-flex items-center gap-1 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 text-xs text-[var(--text-secondary)]"
              >
                {chip.label && <span className="text-[var(--text-muted)]">{chip.label}:</span>}
                {chip.value}
              </span>
            ))}
          </div>
        )}

        {richContent && (
          <div className="mt-4 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
            <RichNotificationContent content={richContent} />
          </div>
        )}

        {(primaryAction || secondaryActions.length > 0) && (
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
            {primaryAction && (
              <ActionButton
                action={primaryAction}
                isPrimary
                levelConfig={levelConfig}
                isAiSuggested={primaryAction.id === notification.aiSuggestedActionId}
                isLoading={pendingActionId === primaryAction.id}
                disabled={pendingActionId !== null}
                onClick={() => void handleAction(primaryAction)}
              />
            )}
            {secondaryActions.map(action => (
              action.actionType === 'remind_later' ? (
                <RemindLaterButton
                  key={action.id}
                  action={action}
                  disabled={pendingActionId !== null}
                  isLoading={pendingActionId === action.id}
                  onSelect={(duration) => void handleAction(action, { duration })}
                />
              ) : (
                <ActionButton
                  key={action.id}
                  action={action}
                  levelConfig={levelConfig}
                  isAiSuggested={action.id === notification.aiSuggestedActionId}
                  isLoading={pendingActionId === action.id}
                  disabled={pendingActionId !== null}
                  onClick={() => void handleAction(action)}
                />
              )
            ))}
          </div>
        )}
      </div>

      {(onMarkRead || onSnooze || onDismiss || onArchive || onMute) && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border)] px-5 py-3">
          {onMarkRead && (
            <button
              type="button"
              onClick={() => void onMarkRead()}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
            >
              {isNotificationUnread(notification) ? 'Mark read' : 'Mark unread'}
            </button>
          )}
          <SnoozeMenu onSnooze={onSnooze} label />
          {notification.connectorType === 'github-issues' && onMute && (
            <button
              type="button"
              onClick={() => void onMute()}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-amber-900/20 hover:text-amber-400"
            >
              <BellOff size={13} />
              {notification.mutedAt ? 'Unmute' : 'Mute'}
            </button>
          )}
          {onArchive && (
            <button
              type="button"
              onClick={() => void onArchive()}
              className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
            >
              <Archive size={13} />
              Handle
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              onClick={() => void onDismiss()}
              className="ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-red-900/20 hover:text-red-400"
            >
              <X size={13} />
              Dismiss
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const TONE_CLASSES: Record<NotificationPresentationTone, string> = {
  neutral: 'bg-[var(--surface-2)] border-[var(--border)] text-[var(--text-secondary)]',
  info: 'bg-blue-900/20 border-blue-800/30 text-blue-400',
  warning: 'bg-amber-900/20 border-amber-800/30 text-amber-400',
  danger: 'bg-red-900/20 border-red-800/30 text-red-400',
  success: 'bg-emerald-900/20 border-emerald-800/30 text-emerald-400',
};

const PROGRESS_CLASSES: Record<NotificationPresentationTone, string> = {
  neutral: 'bg-slate-500',
  info: 'bg-blue-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
  success: 'bg-emerald-500',
};

const TONE_TEXT_CLASSES: Record<NotificationPresentationTone, string> = {
  neutral: 'text-[var(--text-secondary)]',
  info: 'text-blue-400',
  warning: 'text-amber-400',
  danger: 'text-red-400',
  success: 'text-emerald-400',
};

function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function RichNotificationContent({ content }: { content: NotificationRichContent }) {
  const progressTone = content.progress?.tone || 'neutral';
  const progressMax = content.progress?.max && content.progress.max > 0
    ? content.progress.max
    : 1;
  const progressPercent = content.progress
    ? Math.min(100, Math.max(0, (content.progress.value / progressMax) * 100))
    : 0;

  return (
    <div className="mt-1.5 space-y-1.5">
      {(content.primaryText || content.secondaryText) && (
        <div className="flex items-center justify-between gap-2 text-xs">
          <span className="text-[var(--text-secondary)] font-medium">{content.primaryText}</span>
          <span className="text-[var(--text-muted)]">{content.secondaryText}</span>
        </div>
      )}
      {content.progress && (
        <>
          <div className="relative h-1.5 rounded-full bg-[var(--surface-2)] overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 rounded-full transition-all duration-300 ${PROGRESS_CLASSES[progressTone]}`}
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className={`font-medium ${TONE_TEXT_CLASSES[progressTone]}`}>
              {content.progress.label}
            </span>
            {content.footerText && (
              <span className="text-[var(--text-muted)]">{content.footerText}</span>
            )}
          </div>
        </>
      )}
      {content.stats && content.stats.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          {content.stats.map((stat, index) => (
            <span
              key={`${stat.label || ''}-${stat.value}-${index}`}
              className={`inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-md border font-medium ${TONE_CLASSES[stat.tone || 'neutral']}`}
            >
              {!stat.label && <DollarSign size={10} />}
              {stat.label ? `${stat.label}: ${stat.value}` : stat.value}
            </span>
          ))}
        </div>
      )}
      {!content.progress && content.footerText && (
        <p className="text-xs text-[var(--text-muted)]">{content.footerText}</p>
      )}
      {content.links?.filter(link => isSafeExternalUrl(link.url)).map(link => (
        <a
          key={`${link.label}-${link.url}`}
          href={link.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-[var(--accent)] hover:underline mt-0.5 mr-3"
          onClick={(event) => event.stopPropagation()}
        >
          <ExternalLink size={10} />
          {link.label}
        </a>
      ))}
    </div>
  );
}

// ─── SNOOZE MENU ────────────────────────────────────────────────────────────

const SNOOZE_OPTIONS = [
  { label: '30 min', value: '30m' },
  { label: '1 hour', value: '1h' },
  { label: '4 hours', value: '4h' },
  { label: 'Tomorrow', value: '1d' },
  { label: '3 days', value: '3d' },
  { label: '1 week', value: '1w' },
];

function SnoozeMenu({
  onSnooze,
  label = false,
}: {
  onSnooze?: (duration: string) => void | Promise<void>;
  label?: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!onSnooze) return null;

  return (
    <div className="relative flex items-center">
      <Tooltip content="Snooze">
        <button
          onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
          aria-label="Snooze notification"
          className={label
            ? 'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-amber-900/20 hover:text-amber-400'
            : 'p-1.5 rounded-md text-[var(--text-muted)] hover:text-amber-400 hover:bg-amber-900/20 transition-colors'
          }
        >
          <Clock size={15} />
          {label && <span>Snooze</span>}
        </button>
      </Tooltip>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12 }}
            className="absolute right-0 top-full mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-xl shadow-black/40 py-1 min-w-[120px]"
          >
            {SNOOZE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={(e) => { e.stopPropagation(); onSnooze(opt.value); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] transition-colors"
              >
                {opt.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const REMIND_LATER_OPTIONS = [
  { label: 'In 15 minutes', value: '15m' },
  { label: 'In 1 hour', value: '1h' },
  { label: 'Tomorrow morning', value: 'tomorrow_morning' },
] as const;

function RemindLaterButton({
  action,
  disabled,
  isLoading,
  onSelect,
}: {
  action: NotificationAction;
  disabled: boolean;
  isLoading: boolean;
  onSelect: (duration: typeof REMIND_LATER_OPTIONS[number]['value']) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(value => !value);
        }}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)] disabled:cursor-wait disabled:opacity-60"
      >
        {isLoading ? <LoaderCircle size={13} className="animate-spin" /> : <Clock size={13} />}
        {action.label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ duration: 0.12 }}
            role="menu"
            className="absolute left-0 top-full z-50 mt-1 min-w-40 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] py-1 shadow-xl shadow-black/40"
          >
            {REMIND_LATER_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpen(false);
                  onSelect(option.value);
                }}
                className="w-full px-3 py-1.5 text-left text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                {option.label}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


function ActionButton({
  action,
  isPrimary = false,
  levelConfig,
  isAiSuggested = false,
  isLoading = false,
  disabled = false,
  onClick,
}: {
  action: NotificationAction;
  isPrimary?: boolean;
  levelConfig?: { buttonClass: string };
  isAiSuggested?: boolean;
  isLoading?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = ACTION_ICONS[action.actionType] || ArrowRight;

  const variantClasses = isPrimary
    ? (levelConfig?.buttonClass || 'bg-[var(--accent)] text-white hover:bg-blue-500 shadow-sm shadow-blue-900/30')
    : 'bg-[var(--surface-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)]/80 border border-[var(--border)]';

  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      className={`
        relative inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md transition-all duration-100 cursor-pointer
        ${variantClasses}
        ${isAiSuggested ? 'ring-1 ring-purple-500/40' : ''}
        disabled:cursor-wait disabled:opacity-60
      `}
    >
      {isLoading ? <LoaderCircle size={12} className="animate-spin" /> : <Icon size={12} />}
      <span>{action.label}</span>
      {action.opensExternal && <ExternalLink size={9} className="opacity-60" />}
      {isAiSuggested && (
        <span className="absolute -top-1.5 -right-1.5 flex items-center gap-0.5 text-[9px] bg-purple-900/60 text-purple-300 px-1 py-0 rounded-full border border-purple-700/40">
          <Sparkles size={7} />
          AI
        </span>
      )}
    </button>
  );
}
