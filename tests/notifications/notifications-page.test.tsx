import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NotificationsPage from '@/app/notifications/page';
import type { UseNotificationsReturn } from '@/lib/hooks/useNotifications';
import type { NotificationBulkResult } from '@/lib/hooks/useNotifications';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';
import type { NotificationItem } from '@/types';

const refresh = vi.fn();
const routerReplace = vi.fn();
let mockSearchParams = new URLSearchParams();
let hookState: UseNotificationsReturn;

vi.mock('@/lib/hooks/useNotifications', () => ({
  useNotifications: () => hookState,
}));

vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ back: vi.fn(), replace: routerReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: {
    div: ({ children, ...props }: Record<string, unknown>) => {
      const rest = { ...props };
      delete rest.initial;
      delete rest.animate;
      delete rest.exit;
      return <div {...rest}>{children as React.ReactNode}</div>;
    },
  },
}));

vi.mock('@/components/notifications/NotificationsSidebar', () => ({
  NotificationsSidebar: () => <aside>Filters</aside>,
}));

vi.mock('@/components/notifications/NotificationViewsBar', () => ({
  NotificationViewsBar: () => <nav>Saved views</nav>,
}));

vi.mock('@/components/notifications/NotificationCard', () => ({
  NotificationCard: ({
    notification,
    onSelect,
    onHandle,
  }: {
    notification: { title: string };
    onSelect: () => void;
    onHandle: () => void;
  }) => (
    <div>
      <button onClick={onSelect}>{notification.title}</button>
      <button onClick={onHandle} aria-label={`Handle ${notification.title}`}>Handle</button>
    </div>
  ),
  NotificationDetail: ({
    notification,
    onExecuteAction,
  }: {
    notification: { title: string };
    onExecuteAction: (actionId: string) => Promise<unknown>;
  }) => (
    <div data-testid="notification-detail">
      {notification.title}
      <button onClick={() => onExecuteAction('action-1')}>Execute detail action</button>
    </div>
  ),
}));

vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: forwardRef<
    HTMLButtonElement,
    ButtonHTMLAttributes<HTMLButtonElement>
  >(function MockSelectTrigger({ children, ...props }, ref) {
    return (
      <button
        ref={ref}
        role="combobox"
        aria-controls="mock-select-content"
        aria-expanded={false}
        {...props}
      >
        {children}
      </button>
    );
  }),
  SelectValue: () => <span>Newest</span>,
  SelectContent: ({ children }: { children: React.ReactNode }) => (
    <div id="mock-select-content">{children}</div>
  ),
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

function makeHook(overrides: Partial<UseNotificationsReturn>): UseNotificationsReturn {
  const bulkResult: NotificationBulkResult = {
    success: true,
    action: 'mark_read',
    scope: 'visible_page',
    acceptedCount: 1,
    updatedCount: 1,
    noOpCount: 0,
    failedCount: 0,
    queuedCount: 0,
  };
  return {
    notifications: [],
    stats: {
      total: 0,
      unread: 0,
      attention: 0,
      urgent: 0,
      actionNeeded: 0,
      headsUp: 0,
      fyi: 0,
      digest: 0,
      actionable: 0,
    },
    facets: { level: {}, category: {}, source: {}, state: {}, merchant: [] },
    matchingCount: 0,
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
    isLoading: false,
    isLoadingMore: false,
    error: null,
    filters: DEFAULT_NOTIFICATION_QUERY,
    setLevelFilter: vi.fn(),
    setCategoryFilter: vi.fn(),
    setMerchantFilter: vi.fn(),
    setSourceFilter: vi.fn(),
    setStateFilter: vi.fn(),
    setActionableOnly: vi.fn(),
    setDateRangeFilter: vi.fn(),
    setSearchFilter: vi.fn(),
    setRepositoryFilter: vi.fn(),
    setOwnerFilter: vi.fn(),
    setReasonFilter: vi.fn(),
    setSubjectTypeFilter: vi.fn(),
    setSourceAccountFilter: vi.fn(),
    setParticipatingFilter: vi.fn(),
    replaceFilters: vi.fn(),
    setAttentionView: vi.fn(),
    resetFilters: vi.fn(),
    sortNewest: true,
    setSortNewest: vi.fn(),
    markRead: vi.fn(async () => bulkResult),
    markUnread: vi.fn(async () => bulkResult),
    dismiss: vi.fn(async () => bulkResult),
    handle: vi.fn(async () => bulkResult),
    mute: vi.fn(async () => bulkResult),
    unmute: vi.fn(async () => bulkResult),
    archive: vi.fn(async () => bulkResult),
    restore: vi.fn(),
    actOnAllMatching: vi.fn(),
    snooze: vi.fn(),
    executeAction: vi.fn(async () => ({ success: true })),
    markAllRead: vi.fn(async () => bulkResult),
    loadMore: vi.fn(),
    selectedId: null,
    setSelectedId: vi.fn(),
    panelVisible: true,
    togglePanel: vi.fn(),
    setPanelVisible: vi.fn(),
    refresh,
    grouped: { today: [], yesterday: [], thisWeek: [], older: [] },
    unreadNotifications: [],
    ...overrides,
  };
}

function makeNotification(id: string, title: string): NotificationItem {
  return {
    id,
    sourceId: `source-${id}`,
    connectorType: 'github-issues',
    connectorInstanceId: 'github-1',
    title,
    body: 'Please review the change.',
    level: 'action_needed',
    levelRank: 1,
    category: 'social',
    state: 'unread',
    readState: 'unread',
    disposition: 'inbox',
    sourceState: 'active',
    syncState: 'synced',
    isActionable: true,
    receivedAt: new Date().toISOString(),
    sortAt: new Date().toISOString(),
    metadata: {},
    presentation: { reason: 'review_requested' },
    actions: [],
  };
}

describe('NotificationsPage data states', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  it('shows a loading state instead of an empty state during the initial fetch', () => {
    hookState = makeHook({ isLoading: true });
    render(<NotificationsPage />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading notifications');
    expect(screen.queryByText('All caught up!')).not.toBeInTheDocument();
  });

  it('shows the fetch error with a retry action', () => {
    hookState = makeHook({ error: 'HTTP 503' });
    render(<NotificationsPage />);

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load notifications");
    screen.getByRole('button', { name: 'Try again' }).click();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('shows URL-backed Finance and merchant selections with shared count and clear behavior', () => {
    const merchant = `merchant-v1_${'A'.repeat(43)}`;
    const replaceFilters = vi.fn();
    hookState = makeHook({
      filters: {
        ...DEFAULT_NOTIFICATION_QUERY,
        category: 'finance',
        merchant,
      },
      facets: {
        level: {},
        category: { finance: 2, tasks: 1 },
        source: { 'finance-manager': 2 },
        state: {},
        merchant: [{ key: merchant, label: 'Invented Market', count: 1 }],
      },
      replaceFilters,
    });

    render(<NotificationsPage />);

    expect(screen.getByRole('button', { name: 'Add filter' })).toBeInTheDocument();
    expect(screen.getByText('2 filters applied')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {
      name: 'Clear Merchant: Invented Market filter',
    }));

    expect(replaceFilters).toHaveBeenCalledWith({
      ...hookState.filters,
      merchant: null,
    });
  });

  it('shows only non-zero quick filters and applies them with one click', () => {
    const replaceFilters = vi.fn();
    hookState = makeHook({
      stats: {
        total: 2,
        unread: 0,
        attention: 2,
        urgent: 2,
        actionNeeded: 0,
        headsUp: 0,
        fyi: 0,
        digest: 0,
        actionable: 0,
      },
      replaceFilters,
    });

    render(<NotificationsPage />);

    fireEvent.click(screen.getByRole('button', { name: /Urgent/ }));
    expect(replaceFilters).toHaveBeenCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      level: 'urgent',
      state: 'unread',
    });
    expect(screen.queryByRole('button', { name: /Action needed/ })).not.toBeInTheDocument();
  });

  it('consumes browser history query changes before writing filter state back to the URL', () => {
    const replaceFilters = vi.fn();
    hookState = makeHook({ replaceFilters });
    const view = render(<NotificationsPage />);

    mockSearchParams = new URLSearchParams({ category: 'finance' });
    view.rerender(<NotificationsPage />);

    expect(replaceFilters).toHaveBeenCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      category: 'finance',
    });
    expect(routerReplace).not.toHaveBeenCalled();
  });

  it('keeps unread details visible after the selected row leaves the filtered list', async () => {
    const notification = {
      id: 'notification-1',
      sourceId: 'source-1',
      connectorType: 'github',
      connectorInstanceId: 'github-1',
      title: 'Review requested',
      body: 'Please review the change.',
      level: 'action_needed' as const,
      levelRank: 1,
      category: 'pr_review',
      state: 'unread' as const,
      readState: 'unread' as const,
      disposition: 'inbox' as const,
      sourceState: 'active' as const,
      syncState: 'synced' as const,
      isActionable: true,
      receivedAt: new Date().toISOString(),
      sortAt: new Date().toISOString(),
      metadata: {},
      presentation: {},
      actions: [],
    };
    const setSelectedId = vi.fn((id: string | null) => {
      hookState.selectedId = id;
    });
    hookState = makeHook({
      notifications: [notification],
      filters: {
        ...DEFAULT_NOTIFICATION_QUERY,
        state: 'unread',
      },
      setSelectedId,
    });
    const view = render(<NotificationsPage />);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Review requested' }));
    });
    hookState.notifications = [];
    view.rerender(<NotificationsPage />);

    expect(screen.getByTestId('notification-detail')).toHaveTextContent('Review requested');
  });

  it('clears the selected snapshot after a successful detail action', async () => {
    const notification = {
      id: 'notification-1',
      sourceId: 'source-1',
      connectorType: 'github',
      connectorInstanceId: 'github-1',
      title: 'Review requested',
      body: 'Please review the change.',
      level: 'action_needed' as const,
      levelRank: 1,
      category: 'pr_review',
      state: 'read' as const,
      readState: 'read' as const,
      disposition: 'inbox' as const,
      sourceState: 'active' as const,
      syncState: 'synced' as const,
      isActionable: true,
      receivedAt: new Date().toISOString(),
      sortAt: new Date().toISOString(),
      metadata: {},
      presentation: {},
      actions: [],
    };
    const setSelectedId = vi.fn((id: string | null) => {
      hookState.selectedId = id;
    });

    hookState = makeHook({
      notifications: [notification],
      selectedId: notification.id,
      setSelectedId,
      executeAction: vi.fn(async () => ({ success: true })),
    });
    const view = render(<NotificationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Execute detail action' }));
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith(null));
    view.rerender(<NotificationsPage />);

    expect(screen.queryByTestId('notification-detail')).not.toBeInTheDocument();
  });

  it('does not clear a newer selection when an earlier action completes', async () => {
    const first = {
      id: 'notification-1',
      sourceId: 'source-1',
      connectorType: 'github',
      connectorInstanceId: 'github-1',
      title: 'Review requested',
      body: 'Review this pull request.',
      level: 'action_needed' as const,
      levelRank: 1,
      category: 'pr_review',
      state: 'read' as const,
      readState: 'read' as const,
      disposition: 'inbox' as const,
      sourceState: 'active' as const,
      syncState: 'synced' as const,
      isActionable: true,
      receivedAt: new Date().toISOString(),
      sortAt: new Date().toISOString(),
      metadata: {},
      presentation: { sourceName: 'GitHub' },
      actions: [],
    };
    const second = {
      ...first,
      id: 'notification-2',
      sourceId: 'source-2',
      title: 'Another notification',
    };
    let resolveAction: ((value: { success: true }) => void) | undefined;
    const executeAction = vi.fn(() => new Promise<{ success: true }>(resolve => {
      resolveAction = resolve;
    }));
    const setSelectedId = vi.fn((id: string | null) => {
      hookState.selectedId = id;
    });
    hookState = makeHook({
      notifications: [first, second],
      selectedId: first.id,
      setSelectedId,
      executeAction,
    });
    const view = render(<NotificationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Execute detail action' }));
    hookState.selectedId = second.id;
    view.rerender(<NotificationsPage />);

    await act(async () => {
      resolveAction?.({ success: true });
    });

    expect(setSelectedId).not.toHaveBeenCalledWith(null);
    expect(screen.getByTestId('notification-detail')).toHaveTextContent('Another notification');
  });

  it('distinguishes visible selection from server-resolved all-matching selection', async () => {
    const notification = makeNotification('notification-1', 'Review requested');
    const actOnAllMatching = vi.fn(async () => ({
      success: true,
      action: 'mark_read',
      scope: 'all_matching' as const,
      acceptedCount: 4,
      updatedCount: 4,
      noOpCount: 0,
      failedCount: 0,
      queuedCount: 0,
    }));
    hookState = makeHook({
      notifications: [notification],
      matchingCount: 4,
      actOnAllMatching,
    });
    render(<NotificationsPage />);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select visible results' }));
    expect(screen.getByText('1 visible notification selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 4 matching' }));
    expect(screen.getByText('All 4 matching notifications selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Read' }));

    await waitFor(() => expect(actOnAllMatching).toHaveBeenCalledWith('mark_read'));
  });

  it('moves selection after removal and restores the prior item on undo', async () => {
    const first = makeNotification('notification-1', 'First review');
    const second = makeNotification('notification-2', 'Second review');
    const setSelectedId = vi.fn((id: string | null) => {
      hookState.selectedId = id;
    });
    const restore = vi.fn(async () => undefined);
    hookState = makeHook({
      notifications: [first, second],
      selectedId: first.id,
      setSelectedId,
      restore,
    });
    render(<NotificationsPage />);

    fireEvent.click(screen.getByRole('button', { name: 'Handle First review' }));
    await waitFor(() => expect(setSelectedId).toHaveBeenCalledWith(second.id));
    fireEvent.click(screen.getByRole('button', { name: 'Undo handle' }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith([
      expect.objectContaining({
        id: first.id,
        readState: 'unread',
        disposition: 'inbox',
      }),
    ]));
    expect(setSelectedId).toHaveBeenCalledWith(first.id);
  });

  it('does not offer undo when dismissal fails', async () => {
    const first = makeNotification('notification-1', 'First review');
    hookState = makeHook({
      notifications: [first],
      selectedId: first.id,
      dismiss: vi.fn(async () => {
        throw new Error('Dismiss unavailable');
      }),
    });
    render(<NotificationsPage />);

    fireEvent.keyDown(window, { key: 'd' });

    await waitFor(() => expect(screen.getByText('Dismiss unavailable')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Undo dismiss' })).not.toBeInTheDocument();
  });

  it('presents partial writeback failures as an alert', () => {
    hookState = makeHook({
      operationalStatus: {
        isSyncing: false,
        lastSyncAt: '2026-08-10T12:00:00.000Z',
        lastSyncSucceeded: true,
        backoffUntil: null,
        pendingWritebacks: 1,
        failedWritebacks: 2,
        error: null,
      },
    });
    render(<NotificationsPage />);

    expect(screen.getByRole('alert')).toHaveTextContent('2 writebacks failed');
  });
});
