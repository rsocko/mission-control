import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodayUtilityPanels } from '@/components/today/TodayUtilityPanels';

let resizeObserverCallback: ResizeObserverCallback | null = null;

vi.mock('@/components/today/TodaySidebar', () => ({
  TodaySidebar: ({ onCollapse }: { onCollapse?: () => void }) => (
    <aside aria-label="Plan and focus suggestions">
      Plan panel
      {onCollapse && <button onClick={onCollapse}>Collapse Suggested</button>}
    </aside>
  ),
}));

vi.mock('@/components/notifications/NotificationsPanel', () => ({
  NotificationsPanel: ({ onCollapse }: { onCollapse?: () => void }) => (
    <aside aria-label="Notifications">
      Notifications panel
      {onCollapse && <button onClick={onCollapse}>Collapse Notifications</button>}
    </aside>
  ),
}));

vi.mock('@/components/layout/NavigationBadge', () => ({
  NavigationBadge: ({ count }: { count: number }) => count > 0 ? <span>{count}</span> : null,
}));

vi.mock('@/lib/hooks/useNotifications', () => ({
  useNotifications: () => ({
    isLoading: false,
    error: null,
    stats: {
      total: 2,
      unread: 2,
      attention: 2,
      urgent: 0,
      actionNeeded: 1,
      headsUp: 1,
      fyi: 0,
      digest: 0,
      actionable: 1,
    },
  }),
}));

class TestResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeObserverCallback = callback;
  }

  observe() {}
  unobserve() {}
  disconnect() {}
}

function resizeWorkspace(width: number) {
  act(() => {
    resizeObserverCallback?.(
      [{ contentRect: { width } } as ResizeObserverEntry],
      {} as ResizeObserver,
    );
  });
}

function renderPanels(detailOpen = false) {
  return render(
    <div>
      <TodayUtilityPanels
        detailOpen={detailOpen}
        todaySidebarProps={{} as never}
      />
    </div>,
  );
}

describe('TodayUtilityPanels', () => {
  beforeEach(() => {
    resizeObserverCallback = null;
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('defaults to Suggested open with Notifications collapsed to the rail', () => {
    renderPanels();

    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'My Day utility panes' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Collapse Suggested' })[1]).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Open Notifications' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('allows either, both, or neither pane to remain open', () => {
    renderPanels();

    fireEvent.click(screen.getByRole('button', { name: 'Open Notifications' }));
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse Suggested' })[0]);
    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse Notifications' })[0]);
    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('rehydrates the saved pane choices', () => {
    const { unmount } = renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open Notifications' }));
    unmount();

    renderPanels();
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('keeps the last-used open pane beside task detail on wide workspaces', () => {
    const { rerender } = renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open Notifications' }));

    rerender(
      <div>
        <TodayUtilityPanels detailOpen todaySidebarProps={{} as never} />
      </div>,
    );
    resizeWorkspace(1400);

    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('uses temporary overlays for constrained task detail without changing saved choices', () => {
    const { rerender } = renderPanels();
    fireEvent.click(screen.getByRole('button', { name: 'Open Notifications' }));

    rerender(
      <div>
        <TodayUtilityPanels detailOpen todaySidebarProps={{} as never} />
      </div>,
    );
    resizeWorkspace(1200);

    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Temporarily show Suggested' }));
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Collapse Suggested' })[0]);

    rerender(
      <div>
        <TodayUtilityPanels detailOpen={false} todaySidebarProps={{} as never} />
      </div>,
    );

    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();
  });
});
