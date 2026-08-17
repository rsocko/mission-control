import { useMemo, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationCard } from '@/components/notifications/NotificationCard';
import {
  CollapsedNotificationsRail,
  NotificationsPanel,
} from '@/components/notifications/NotificationsPanel';
import type { UseNotificationsReturn } from '@/lib/hooks/useNotifications';
import type { NotificationBulkResult } from '@/lib/hooks/useNotifications';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';
import type { NotificationItem, NotificationLevel } from '@/types';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const rest = { ...props };
      delete rest.layout;
      delete rest.transition;
      delete rest.initial;
      delete rest.animate;
      delete rest.exit;
      return <div {...rest}>{children as React.ReactNode}</div>;
    },
    section: ({ children, ...props }: Record<string, unknown>) => {
      const rest = { ...props };
      delete rest.transition;
      delete rest.initial;
      delete rest.animate;
      delete rest.exit;
      return <section {...rest}>{children as React.ReactNode}</section>;
    },
    span: ({ children, ...props }: Record<string, unknown>) => {
      const rest = { ...props };
      delete rest.layoutId;
      delete rest.transition;
      return <span {...rest}>{children as React.ReactNode}</span>;
    },
  },
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const BULK_RESULT: NotificationBulkResult = {
  success: true,
  action: 'mark_read',
  scope: 'visible_page',
  acceptedCount: 1,
  updatedCount: 1,
  noOpCount: 0,
  failedCount: 0,
  queuedCount: 0,
};
const markRead = vi.fn(async (ids: string[]) => {
  void ids;
  return BULK_RESULT;
});
const executeAction = vi.fn(async () => ({ success: true }));
const refresh = vi.fn();

function makeNotification(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'notification-1',
    sourceId: 'source-1',
    connectorType: 'github',
    connectorInstanceId: 'github-1',
    title: 'Review requested',
    body: 'A pull request is waiting for review.',
    level: 'action_needed',
    levelRank: 1,
    category: 'pr_review',
    state: 'unread',
    readState: 'unread',
    disposition: 'inbox',
    sourceState: 'active',
    syncState: 'synced',
    isActionable: true,
    receivedAt: new Date().toISOString(),
    sortAt: new Date().toISOString(),
    metadata: {},
    presentation: { sourceName: 'GitHub' },
    actions: [{
      id: 'review-action',
      notificationId: 'notification-1',
      actionType: 'open_url',
      label: 'Review PR',
      variant: 'primary',
      isPrimary: true,
      sortOrder: 0,
      payload: {},
      opensExternal: true,
      requiresConfirmation: false,
      createdBy: 'connector',
    }],
    ...overrides,
  };
}

const actionable = makeNotification({});
const passive = makeNotification({
  id: 'digest-1',
  sourceId: 'digest-source',
  title: 'Weekly finance summary',
  body: 'Spending finished below forecast.',
  level: 'digest',
  levelRank: 4,
  category: 'finance',
  isActionable: false,
  actions: [],
});

function Harness({
  initialUnread = false,
  isLoading = false,
  error = null,
  empty = false,
  statsOverride,
}: {
  initialUnread?: boolean;
  isLoading?: boolean;
  error?: string | null;
  empty?: boolean;
  statsOverride?: Partial<UseNotificationsReturn['stats']>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [allNotifications, setAllNotifications] = useState(() => empty ? [] : [actionable, passive]);
  const [level, setLevel] = useState<NotificationLevel | null>(null);
  const [unreadOnly, setUnreadOnly] = useState(initialUnread);
  const [actionableOnly, setActionableOnly] = useState(false);
  const notifications = useMemo(() => allNotifications.filter(notification => {
    if (level && notification.level !== level) return false;
    if (unreadOnly && notification.state !== 'unread') return false;
    if (actionableOnly && !notification.isActionable) return false;
    return true;
  }), [actionableOnly, allNotifications, level, unreadOnly]);
  const filters = {
    ...DEFAULT_NOTIFICATION_QUERY,
    level,
    state: unreadOnly ? 'unread' as const : null,
    actionableOnly,
  };
  const hook: UseNotificationsReturn = {
    notifications,
    stats: {
      total: 2,
      unread: 2,
      attention: 1,
      urgent: 0,
      actionNeeded: 1,
      headsUp: 0,
      fyi: 0,
      digest: 1,
      actionable: 1,
      ...statsOverride,
    },
    facets: {
      level: { action_needed: 1, digest: 1 },
      category: { pr_review: 1, finance: 1 },
      source: { github: 2 },
      state: { unread: 2 },
      merchant: [],
    },
    matchingCount: notifications.length,
    operationalStatus: {
      isSyncing: false,
      lastSyncAt: null,
      lastSyncSucceeded: null,
      backoffUntil: null,
      pendingWritebacks: 0,
      failedWritebacks: 0,
      error: null,
    },
    hasMore: false,
    isLoading,
    isLoadingMore: false,
    error,
    filters,
    setLevelFilter: setLevel,
    setCategoryFilter: vi.fn(),
    setMerchantFilter: vi.fn(),
    setSourceFilter: vi.fn(),
    setStateFilter: state => setUnreadOnly(state === 'unread'),
    setActionableOnly,
    setDateRangeFilter: vi.fn(),
    setSearchFilter: vi.fn(),
    setRepositoryFilter: vi.fn(),
    setOwnerFilter: vi.fn(),
    setReasonFilter: vi.fn(),
    setSubjectTypeFilter: vi.fn(),
    setSourceAccountFilter: vi.fn(),
    setParticipatingFilter: vi.fn(),
    replaceFilters: vi.fn(),
    setAttentionView: view => {
      setUnreadOnly(view === 'unread');
      setActionableOnly(view === 'action');
    },
    resetFilters: vi.fn(),
    sortNewest: true,
    setSortNewest: vi.fn(),
    markRead: async (ids) => {
      await markRead(ids);
      setAllNotifications(items => items.map(item => (
       ids.includes(item.id)
         ? { ...item, state: 'read' as const, readState: 'read' as const }
         : item
      )));
      return BULK_RESULT;
    },
    markUnread: vi.fn(async () => BULK_RESULT),
    dismiss: vi.fn(async () => BULK_RESULT),
    handle: vi.fn(async () => BULK_RESULT),
    mute: vi.fn(async () => BULK_RESULT),
    unmute: vi.fn(async () => BULK_RESULT),
    archive: vi.fn(async () => BULK_RESULT),
    restore: vi.fn(async () => undefined),
    actOnAllMatching: vi.fn(async () => BULK_RESULT),
    snooze: vi.fn(async () => undefined),
    executeAction,
    markAllRead: vi.fn(async () => BULK_RESULT),
    loadMore: vi.fn(),
    selectedId,
    setSelectedId,
    panelVisible: true,
    togglePanel: vi.fn(),
    setPanelVisible: vi.fn(),
    refresh,
    grouped: { today: notifications, yesterday: [], thisWeek: [], older: [] },
    unreadNotifications: notifications,
  };

  return <NotificationsPanel hook={hook} />;
}

describe('NotificationsPanel V2', () => {
  it('shows only the highest-severity count in the collapsed rail badge', () => {
    render(
      <CollapsedNotificationsRail
        attentionCount={8}
        urgentCount={2}
        actionCount={3}
        headsUpCount={1}
        fyiCount={2}
        onExpand={vi.fn()}
      />,
    );

    expect(screen.getByText('2')).toHaveClass('bg-red-500');
    expect(screen.queryByText('8')).not.toBeInTheDocument();
  });

  it('shows unread counts by level with complementary attribute filters', () => {
    render(<Harness />);

    expect(screen.getByText('1 need attention · 1 with actions')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All: 2 unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Action: 1 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unread only' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Actionable only' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('moves wider level badges outward while keeping single digits anchored', () => {
    const { rerender } = render(<Harness />);

    expect(within(screen.getByRole('button', { name: 'All: 2 unread' })).getByText('2'))
      .toHaveClass('-right-3.5');
    expect(within(screen.getByRole('button', { name: 'Action: 1 unread' })).getByText('1'))
      .toHaveClass('-right-3.5');

    rerender(<Harness statsOverride={{ unread: 42 }} />);
    expect(within(screen.getByRole('button', { name: 'All: 42 unread' })).getByText('42'))
      .toHaveClass('-right-4.5');

    rerender(<Harness statsOverride={{ unread: 121 }} />);
    expect(within(screen.getByRole('button', { name: 'All: 121 unread' })).getByText('99+'))
      .toHaveClass('-right-5.5');
  });

  it('opens a meaningful preview and marks an unread row as read', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: /review requested/i }));

    const preview = screen.getByRole('region', { name: 'Notification preview' });
    expect(within(preview).getByText('A pull request is waiting for review.')).toBeInTheDocument();
    expect(within(preview).getByRole('button', { name: 'Review PR' })).toBeInTheDocument();
    expect(markRead).toHaveBeenCalledWith(['notification-1']);
  });

  it('keeps the preview open after marking an item read in the Unread view', async () => {
    render(<Harness initialUnread />);

    fireEvent.click(screen.getByRole('button', { name: /open review requested/i }));

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Notification preview' })).toHaveFocus();
    });
    expect(screen.queryByRole('button', { name: /open review requested/i })).not.toBeInTheDocument();
  });

  it('closes the preview after a successful action removes its executable state', async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: /open review requested/i }));

    const preview = screen.getByRole('region', { name: 'Notification preview' });
    fireEvent.click(within(preview).getByRole('button', { name: 'Review PR' }));

    await waitFor(() => {
      expect(screen.queryByRole('region', { name: 'Notification preview' })).not.toBeInTheDocument();
    });
  });

  it('shows loading and retryable error states instead of an empty success state', () => {
    const loading = render(<Harness isLoading empty />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications');
    expect(screen.queryByText('All caught up')).not.toBeInTheDocument();

    loading.rerender(<Harness error="HTTP 503" />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load notifications");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('combines level, unread, and actionable filters and carries them to the full center', () => {
    render(<Harness />);

    fireEvent.click(screen.getByRole('button', { name: 'Action: 1 unread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actionable only' }));

    expect(screen.getByText('Review requested')).toBeInTheDocument();
    expect(screen.queryByText('Weekly finance summary')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action: 1 unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Unread only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Actionable only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('link', { name: /open notification center/i }))
      .toHaveAttribute('href', '/notifications?level=action_needed&state=unread&actionableOnly=true');
  });

  it('does not select a row when a nested CTA handles keyboard input', () => {
    const onSelect = vi.fn();

    render(
      <NotificationCard
        notification={actionable}
        panel
        onSelect={onSelect}
        onExecuteAction={vi.fn()}
      />,
    );

    fireEvent.keyDown(screen.getByRole('button', { name: 'Review PR' }), { key: 'Enter' });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
