import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TodayUtilityPanels } from '@/components/today/TodayUtilityPanels';

let resizeObserverCallback: ResizeObserverCallback | null = null;

vi.mock('@/components/today/TodaySidebar', () => ({
  TodaySidebar: () => <aside aria-label="Plan and focus suggestions">Plan panel</aside>,
}));

vi.mock('@/components/notifications/NotificationsPanel', () => ({
  NotificationsPanel: () => <aside aria-label="Notifications">Notifications panel</aside>,
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

  it('uses tabs when only one utility panel fits', () => {
    renderPanels();
    resizeWorkspace(1200);

    expect(screen.getByRole('tablist', { name: 'My Day utility panel' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /notifications/i }));

    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();
  });

  it('shows both existing panels automatically when the workspace is wide', () => {
    renderPanels();
    resizeWorkspace(1400);

    expect(screen.queryByRole('tablist', { name: 'My Day utility panel' })).not.toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('keeps one active panel beside task detail on wide workspaces', () => {
    renderPanels(true);
    resizeWorkspace(1400);

    expect(screen.getByRole('tablist', { name: 'My Day utility panel' })).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Notifications' })).not.toBeInTheDocument();
  });

  it('collapses to a rail with a temporary panel on constrained detail layouts', () => {
    renderPanels(true);
    resizeWorkspace(1200);

    expect(screen.getByRole('complementary', { name: 'My Day utility panels (collapsed)' })).toBeInTheDocument();
    expect(screen.queryByRole('complementary', { name: 'Plan and focus suggestions' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show Plan & Focus' }));

    expect(screen.getByRole('complementary', { name: 'Plan and focus suggestions' })).toBeInTheDocument();
  });
});
