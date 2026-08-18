import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPush = vi.fn();
const mockReplace = vi.fn();
const mockFetch = vi.fn();
let mockSearchParams = new URLSearchParams();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/',
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/hooks/usePullToRefresh', () => ({
  usePullToRefresh: () => ({
    containerRef: { current: null },
    isRefreshing: false,
    pullDistance: 0,
    containerProps: {},
    contentStyle: {},
  }),
}));

vi.mock('@/components/ui/PullToRefreshIndicator', () => ({
  PullToRefreshIndicator: () => <div data-testid="pull-to-refresh-indicator" />,
}));

vi.mock('@/components/ui/Tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('motion/react', async () => {
  const React = await import('react');

  function createMotionComponent(tag: keyof React.JSX.IntrinsicElements) {
    return React.forwardRef<HTMLElement, Record<string, unknown>>(function MotionComponent(props, ref) {
      const {
        children,
        variants,
        initial,
        animate,
        exit,
        transition,
        layout,
        drag,
        dragConstraints,
        dragElastic,
        dragMomentum,
        dragControls,
        style,
        onDragStart,
        onDrag,
        onDragEnd,
        ...rest
      } = props;
      void [
        variants,
        initial,
        animate,
        exit,
        transition,
        layout,
        dragConstraints,
        dragElastic,
        dragMomentum,
        dragControls,
      ];
      const dragStartHandler = onDragStart as ((event: PointerEvent) => void) | undefined;
      const dragHandler = onDrag as ((
        event: PointerEvent,
        info: { offset: { x: number; y: number } },
      ) => void) | undefined;
      const dragEndHandler = onDragEnd as ((
        event: PointerEvent,
        info: { offset: { x: number; y: number } },
      ) => void) | undefined;
      const startXRef = React.useRef<number | null>(null);
      const lastXRef = React.useRef(0);
      const sanitizedStyle = style && typeof style === 'object'
        ? Object.fromEntries(
            Object.entries(style as Record<string, unknown>).filter(
              ([key, value]) => key !== 'x' && (typeof value === 'string' || typeof value === 'number'),
            ),
          )
        : style;

      const dragProps = drag
        ? {
            onPointerDown: (event: PointerEvent) => {
              startXRef.current = event.clientX;
              lastXRef.current = event.clientX;
              dragStartHandler?.(event);
            },
            onPointerMove: (event: PointerEvent) => {
              if (startXRef.current === null) return;
              lastXRef.current = event.clientX;
              dragHandler?.(event, { offset: { x: event.clientX - startXRef.current, y: 0 } });
            },
            onPointerUp: (event: PointerEvent) => {
              if (startXRef.current === null) return;
              const offsetX = (event.clientX ?? lastXRef.current) - startXRef.current;
              dragEndHandler?.(event, { offset: { x: offsetX, y: 0 } });
              startXRef.current = null;
            },
          }
        : {};

      const MotionTag: React.ElementType = tag;
      return React.createElement(MotionTag, {
        ref,
        style: sanitizedStyle as React.CSSProperties | undefined,
        ...(rest as React.HTMLAttributes<HTMLElement>),
        ...dragProps,
      }, children as React.ReactNode);
    });
  }

  return {
    motion: {
      div: createMotionComponent('div'),
      section: createMotionComponent('section'),
      button: createMotionComponent('button'),
    },
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useMotionValue: (value: number) => ({ get: () => value, set: vi.fn() }),
    useReducedMotion: () => false,
    useTransform: () => 0,
    useDragControls: () => ({ start: vi.fn() }),
  };
});

import { MobileNotificationsScreen } from '@/components/mobile/MobileNotificationsScreen';

function makeNotification(overrides: Record<string, unknown> = {}) {
  return {
    id: 'notif-1',
    sourceId: 'source-1',
    connectorType: 'github',
    connectorInstanceId: 'github-1',
    title: 'Urgent ping',
    body: 'Needs attention',
    level: 'urgent',
    levelRank: 0,
    category: 'alerts',
    state: 'unread',
    isActionable: false,
    receivedAt: '2030-01-01T00:00:00.000Z',
    sortAt: '2030-01-01T00:00:00.000Z',
    metadata: {},
    presentation: {},
    actions: [],
    ...overrides,
  };
}

function mockNotificationsApi(
  notifications: Array<Record<string, unknown>>,
  actionResult: Record<string, unknown> = { type: 'navigate', target: '/projects/123' },
) {
  mockFetch.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';

    if (url.startsWith('/api/notifications') && !url.includes('/actions/') && method === 'GET') {
      const params = new URL(url, 'http://localhost').searchParams;
      const requestedSource = params.get('source');
      const financeSources = new Set(['finance', 'finance-manager', 'monarch-money']);
      const filtered = notifications.filter(notification => {
        if (params.get('level') && notification.level !== params.get('level')) return false;
        if (params.get('category') && notification.category !== params.get('category')) return false;
        if (params.get('state') === 'unread' && notification.state !== 'unread') return false;
        if (params.get('actionableOnly') === 'true' && notification.isActionable !== true) return false;
        if (requestedSource) {
          const actualSource = String(notification.connectorType);
          if (requestedSource === 'finance-manager') {
            if (!financeSources.has(actualSource)) return false;
          } else if (actualSource !== requestedSource) {
            return false;
          }
        }
        if (
          params.get('merchant')
          && (notification.presentation as Record<string, unknown>)?.financeMerchantKey !== params.get('merchant')
        ) {
          return false;
        }
        return true;
      });
      const source = notifications.reduce<Record<string, number>>((result, notification) => {
        const raw = String(notification.connectorType);
        const key = financeSources.has(raw) ? 'finance-manager' : raw;
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {});
      const category = notifications.reduce<Record<string, number>>((result, notification) => {
        const key = String(notification.category);
        result[key] = (result[key] ?? 0) + 1;
        return result;
      }, {});
      const merchantByKey = new Map<string, { key: string; label: string; count: number }>();
      for (const notification of notifications) {
        const presentation = notification.presentation as Record<string, unknown>;
        const key = presentation.financeMerchantKey;
        const label = presentation.financeMerchantLabel;
        if (typeof key !== 'string' || typeof label !== 'string') continue;
        const current = merchantByKey.get(key);
        merchantByKey.set(key, { key, label, count: (current?.count ?? 0) + 1 });
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          notifications: filtered,
          matchingCount: filtered.length,
          stats: {
            unread: notifications.filter(notification => notification.state === 'unread').length,
            actionable: notifications.filter(notification => notification.isActionable === true).length,
            urgent: notifications.filter(notification =>
              notification.level === 'urgent' && notification.state === 'unread').length,
            actionNeeded: notifications.filter(notification =>
              notification.level === 'action_needed' && notification.state === 'unread').length,
            headsUp: notifications.filter(notification =>
              notification.level === 'heads_up' && notification.state === 'unread').length,
            fyi: notifications.filter(notification =>
              notification.level === 'fyi' && notification.state === 'unread').length,
          },
          facets: {
            level: {},
            category,
            source,
            state: {},
            merchant: [...merchantByKey.values()],
          },
        }),
      });
    }

    if (url === '/api/notifications/bulk' && method === 'POST') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }

    if (url.startsWith('/api/notifications/') && method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }

    if (url === '/api/notifications' && method === 'PATCH') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }

    if (url.includes('/actions/') && method === 'POST') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          result: actionResult,
        }),
      });
    }

    return Promise.reject(new Error(`Unexpected fetch: ${method} ${url}`));
  });
}

describe('MobileNotificationsScreen', () => {
  beforeEach(() => {
    mockPush.mockReset();
    mockReplace.mockReset();
    mockFetch.mockReset();
    mockSearchParams = new URLSearchParams();
    global.fetch = mockFetch as typeof fetch;
  });

  it('shows a loading skeleton while fetching', () => {
    let resolveRequest: ((value: unknown) => void) | undefined;
    mockFetch.mockImplementation(() => new Promise((resolve) => { resolveRequest = resolve; }));

    const { container } = render(<MobileNotificationsScreen onBack={vi.fn()} />);

    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);

    resolveRequest?.({
      ok: true,
      json: () => Promise.resolve({ notifications: [] }),
    });
  });

  it('fetches and renders notifications as a flat list', async () => {
    mockNotificationsApi([
      makeNotification({ id: 'critical-1', title: 'Urgent ping', level: 'urgent' }),
      makeNotification({ id: 'standard-1', title: 'Heads up', level: 'heads_up', state: 'read' }),
      makeNotification({ id: 'low-1', title: 'Weekly digest', level: 'fyi', state: 'read' }),
    ]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    expect(await screen.findByText('Urgent ping')).toBeInTheDocument();
    expect(screen.getByText('Heads up')).toBeInTheDocument();
    expect(screen.getByText('Weekly digest')).toBeInTheDocument();
  });

  it('shows an unread dot and applies the desktop level and attribute filters together', async () => {
    mockNotificationsApi([
      makeNotification({
        id: 'actionable-unread',
        title: 'Actionable unread',
        state: 'unread',
        level: 'action_needed',
        isActionable: true,
      }),
      makeNotification({
        id: 'passive-unread',
        title: 'Passive unread',
        state: 'unread',
        level: 'action_needed',
      }),
      makeNotification({ id: 'urgent-read', title: 'Urgent read', state: 'read', level: 'urgent' }),
    ]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    expect(await screen.findByText('Actionable unread')).toBeInTheDocument();
    expect(screen.getAllByLabelText('Unread')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'All: 2 unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Urgent: 0 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action: 2 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Heads Up: 0 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FYI: 0 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All: 2 unread' }).querySelector('.lucide-inbox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Urgent: 0 unread' }).querySelector('.lucide-triangle-alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action: 2 unread' }).querySelector('.lucide-clipboard-check')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Heads Up: 0 unread' }).querySelector('.lucide-bell-ring')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'FYI: 0 unread' }).querySelector('.lucide-info')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Action: 2 unread' }));
    fireEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Actionable only' }));

    expect(await screen.findByText('Actionable unread')).toBeInTheDocument();
    expect(screen.queryByText('Passive unread')).not.toBeInTheDocument();
    expect(screen.queryByText('Urgent read')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Action: 2 unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Unread only' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Actionable only' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/notifications?level=action_needed&state=unread&actionableOnly=true',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
  });

  it('round-trips Finance category and exact merchant filters with shared clear behavior', async () => {
      const merchantA = `merchant-v1_${'A'.repeat(43)}`;
      const merchantB = `merchant-v1_${'B'.repeat(43)}`;
      mockSearchParams = new URLSearchParams({
        category: 'finance',
        merchant: merchantA,
        view: 'finance-view',
      });
      mockNotificationsApi([
        makeNotification({
          id: 'finance-a',
          title: 'Invented Market mover',
          connectorType: 'finance-manager',
          category: 'finance',
          presentation: {
            financeMerchantKey: merchantA,
            financeMerchantLabel: 'Invented Market',
          },
        }),
        makeNotification({
          id: 'finance-b',
          title: 'Fictional Transit mover',
          connectorType: 'monarch-money',
          category: 'finance',
          presentation: {
            financeMerchantKey: merchantB,
            financeMerchantLabel: 'Fictional Transit',
          },
        }),
        makeNotification({
          id: 'task-a',
          title: 'Invented Market task',
          category: 'tasks',
          presentation: {
            financeMerchantKey: merchantA,
            financeMerchantLabel: 'Invented Market',
          },
        }),
      ]);

      render(<MobileNotificationsScreen onBack={vi.fn()} />);

      expect(await screen.findByText('Invented Market mover')).toBeInTheDocument();
      expect(screen.queryByText('Fictional Transit mover')).not.toBeInTheDocument();
      expect(screen.queryByText('Invented Market task')).not.toBeInTheDocument();
      expect(screen.getByRole('button', {
        name: 'Clear Category: Finance filter',
      })).toHaveTextContent('Category: Finance');
      expect(screen.getByRole('button', {
        name: 'Clear Merchant: Invented Market filter',
      })).toHaveTextContent('Merchant: Invented Market');
      expect(screen.getByText('2 filters applied')).toBeInTheDocument();
      expect(screen.getByRole('button', {
        name: 'Clear Merchant: Invented Market filter',
      })).toHaveClass('min-h-[44px]');
      await waitFor(() => {
        expect(mockFetch).toHaveBeenCalledWith(
          `/api/notifications?category=finance&merchant=${merchantA}`,
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        );
      });

      fireEvent.click(screen.getByRole('button', { name: 'Clear Category: Finance filter' }));
      expect(await screen.findByText('Invented Market task')).toBeInTheDocument();
      expect(screen.queryByText('Fictional Transit mover')).not.toBeInTheDocument();
      await waitFor(() => {
        expect(mockReplace).toHaveBeenLastCalledWith(
          `/notifications?merchant=${merchantA}&view=finance-view`,
          { scroll: false },
        );
      });

      fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
      expect(await screen.findByText('Fictional Transit mover')).toBeInTheDocument();
      expect(screen.queryByText(/filters applied/)).not.toBeInTheDocument();
      await waitFor(() => {
        expect(mockReplace).toHaveBeenLastCalledWith(
          '/notifications?view=finance-view',
          { scroll: false },
        );
      });
  });

  it.each(['finance', 'finance-manager', 'monarch-money'])(
    'canonicalizes the %s source alias and fetches the complete Finance family',
    async source => {
        mockSearchParams = new URLSearchParams({ source });
        mockNotificationsApi([
          makeNotification({ id: 'finance', title: 'Finance alias', connectorType: 'finance' }),
          makeNotification({ id: 'manager', title: 'Manager alias', connectorType: 'finance-manager' }),
          makeNotification({ id: 'monarch', title: 'Monarch alias', connectorType: 'monarch-money' }),
          makeNotification({ id: 'github', title: 'GitHub source', connectorType: 'github-issues' }),
        ]);

        render(<MobileNotificationsScreen onBack={vi.fn()} />);

        expect(await screen.findByText('Finance alias')).toBeInTheDocument();
        expect(screen.getByText('Manager alias')).toBeInTheDocument();
        expect(screen.getByText('Monarch alias')).toBeInTheDocument();
        expect(screen.queryByText('GitHub source')).not.toBeInTheDocument();
        expect(screen.getByRole('button', {
          name: 'Clear Source: Tyrion filter',
        })).toHaveTextContent('Source: Tyrion');
        await waitFor(() => {
          expect(mockFetch).toHaveBeenCalledWith(
            '/api/notifications?source=finance-manager',
            expect.objectContaining({ signal: expect.any(AbortSignal) }),
          );
        });
    },
  );

  it('consumes back and forward URL changes without overwriting them', async () => {
    mockNotificationsApi([
      makeNotification({ id: 'finance', title: 'Finance result', category: 'finance' }),
      makeNotification({ id: 'task', title: 'Task result', category: 'tasks' }),
    ]);
    const view = render(<MobileNotificationsScreen onBack={vi.fn()} />);
    expect(await screen.findByText('Task result')).toBeInTheDocument();

    mockReplace.mockClear();
    mockSearchParams = new URLSearchParams({ category: 'finance' });
    view.rerender(<MobileNotificationsScreen onBack={vi.fn()} />);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/notifications?category=finance',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });
    expect(screen.queryByText('Task result')).not.toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();

    mockSearchParams = new URLSearchParams();
    view.rerender(<MobileNotificationsScreen onBack={vi.fn()} />);
    expect(await screen.findByText('Task result')).toBeInTheDocument();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('calls the bulk API when marking all visible notifications as read', async () => {
    mockNotificationsApi([
      makeNotification({ id: 'unread-1', title: 'Unread item', state: 'unread' }),
      makeNotification({ id: 'unread-2', title: 'Another unread', state: 'unread' }),
    ]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    await screen.findByText('Unread item');
    expect(screen.getByRole('button', { name: 'All: 2 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Urgent: 2 unread' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mark all visible notifications as read' }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/notifications/bulk',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['unread-1', 'unread-2'], action: 'read' }),
        }),
      );
    });
    expect(screen.getByRole('button', { name: 'All: 0 unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Urgent: 0 unread' })).toBeInTheDocument();
    expect(screen.queryByText('Unread item')).not.toBeInTheDocument();
    expect(screen.queryByText('Another unread')).not.toBeInTheDocument();
  });

  it('swipes to handle and removes a notification', async () => {
    mockNotificationsApi([makeNotification({ id: 'dismiss-me', title: 'Dismiss me' })]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    const item = await screen.findByRole('button', { name: /notification: dismiss me/i });

    fireEvent.pointerDown(item, { clientX: 0 });
    fireEvent.pointerMove(item, { clientX: -120 });
    fireEvent.pointerUp(item, { clientX: -120 });

    await waitFor(() => {
      expect(screen.queryByText('Dismiss me')).not.toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/notifications/bulk', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ ids: ['dismiss-me'], action: 'handle' }),
    }));
  });

  it('right swipes an unread notification to mark it read', async () => {
    mockNotificationsApi([makeNotification({ id: 'read-me', title: 'Read me' })]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    const item = await screen.findByRole('button', { name: /notification: read me/i });

    fireEvent.pointerDown(item, { clientX: 0 });
    fireEvent.pointerMove(item, { clientX: 120 });
    fireEvent.pointerUp(item, { clientX: 120 });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/bulk', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['read-me'], action: 'read' }),
      }));
    });
    expect(screen.queryByLabelText('Unread')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All: 0 unread' })).toBeInTheDocument();
  });

  it('right swipes a read notification to mark it unread', async () => {
    mockNotificationsApi([makeNotification({
      id: 'unread-me',
      title: 'Unread me',
      state: 'read',
      readState: 'read',
    })]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    const item = await screen.findByRole('button', { name: /notification: unread me/i });

    fireEvent.pointerDown(item, { clientX: 0 });
    fireEvent.pointerMove(item, { clientX: 120 });
    fireEvent.pointerUp(item, { clientX: 120 });

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith('/api/notifications/bulk', expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ ids: ['unread-me'], action: 'mark_unread' }),
      }));
    });
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All: 1 unread' })).toBeInTheDocument();
  });

  it('taps to open the detail sheet and marks a notification as read', async () => {
    mockNotificationsApi([makeNotification({ id: 'open-me', title: 'Open me' })]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /notification: open me/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/notifications/bulk',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ ids: ['open-me'], action: 'read' }),
        }),
      );
    });

    expect(screen.getByRole('dialog', { name: 'Notification: Open me' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('executes a provider CTA from the detail sheet', async () => {
    mockNotificationsApi([
      makeNotification({
        id: 'open-project',
        title: 'Review project',
        isActionable: true,
        actions: [{
          id: 'action-1',
          notificationId: 'open-project',
          actionType: 'navigate',
          label: 'Open project',
          variant: 'primary',
          isPrimary: true,
          sortOrder: 0,
          payload: {},
          opensExternal: false,
          requiresConfirmation: false,
          createdBy: 'system',
        }],
      }),
    ]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /notification: review project/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Open project' }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/projects/123');
    });
  });

  it('preopens external actions before awaiting the action API', async () => {
      const replace = vi.fn();
      const close = vi.fn();
      const popup = {
        closed: false,
        opener: window,
        location: { replace },
        close,
      } as unknown as Window;
      const open = vi.spyOn(window, 'open').mockReturnValue(popup);
      mockNotificationsApi([
        makeNotification({
          id: 'open-source',
          title: 'Open source',
          isActionable: true,
          actions: [{
            id: 'action-external',
            notificationId: 'open-source',
            actionType: 'open_url',
            label: 'Open source',
            variant: 'primary',
            isPrimary: true,
            sortOrder: 0,
            payload: {},
            opensExternal: true,
            requiresConfirmation: false,
            createdBy: 'connector',
          }],
        }),
      ], { type: 'open_url', url: 'https://example.test/source' });

      render(<MobileNotificationsScreen onBack={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: /notification: open source/i }));
      fireEvent.click(screen.getByRole('button', { name: 'Open source' }));

      expect(open).toHaveBeenCalledWith('about:blank', '_blank');
      await waitFor(() => {
        expect(replace).toHaveBeenCalledWith('https://example.test/source');
      });
      expect(close).not.toHaveBeenCalled();
      open.mockRestore();
  });

  it('restores focus to a stable control when the opening unread row disappears', async () => {
    mockNotificationsApi([makeNotification({ id: 'unread-detail', title: 'Unread detail' })]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    await screen.findByText('Unread detail');
    fireEvent.click(screen.getByRole('button', { name: 'Unread only' }));
    fireEvent.click(await screen.findByRole('button', { name: /notification: unread detail/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    await waitFor(() => {
      expect(screen.queryByText('Unread detail')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go back' })).toHaveFocus();
    });
  });

  it('shows an empty state when there are no notifications', async () => {
    mockNotificationsApi([]);

    render(<MobileNotificationsScreen onBack={vi.fn()} />);

    expect(await screen.findByText('No notifications')).toBeInTheDocument();
    expect(screen.getByText('When Mission Control has new activity, it will show up here.')).toBeInTheDocument();
  });
});
