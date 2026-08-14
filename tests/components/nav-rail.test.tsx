import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavRail } from '@/components/layout/NavRail';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { SYNC_ICON_PREFERENCE_KEY } from '@/lib/hooks/useSyncIconPreference';

function renderNavRail({
  isAiActive = false,
  isSyncing = false,
}: {
  isAiActive?: boolean;
  isSyncing?: boolean;
} = {}) {
  return render(
    <TooltipProvider>
      <NavRail
        features={{ aiEnabled: true, financeEnabled: true }}
        isAiActive={isAiActive}
        isSyncing={isSyncing}
      />
    </TooltipProvider>
  );
}

describe('NavRail', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('auto-expands after a deliberate hover', () => {
    renderNavRail();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });

    fireEvent.mouseEnter(nav);
    expect(nav).toHaveClass('w-16');

    act(() => vi.advanceTimersByTime(300));

    expect(nav).toHaveClass('w-[200px]');
  });

  it('cancels pending expansion when a collapsed item is clicked', () => {
    renderNavRail();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const projectsLink = screen.getByRole('link', { name: 'Projects' });

    fireEvent.mouseEnter(nav);
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerDown(projectsLink);

    expect(projectsLink).toHaveAttribute('href', '/projects');
    expect(fireEvent.click(projectsLink)).toBe(true);
    fireEvent.mouseLeave(nav);
    act(() => vi.advanceTimersByTime(800));

    expect(nav).toHaveClass('w-16');
  });

  it('expands immediately when explicitly pinned', () => {
    renderNavRail();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });

    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));

    expect(nav).toHaveClass('w-[200px]');
  });

  it('renders a static brand mark and reveals its name when expanded', () => {
    renderNavRail();
    const brandName = screen.getByText('Mission Control');
    const brandIcon = brandName.parentElement?.previousElementSibling?.querySelector('svg');

    expect(screen.queryByRole('link', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(brandIcon).toHaveClass('lucide-satellite');
    expect(brandIcon?.getAttribute('stroke')).toBe('url(#mission-control-brand-gradient)');
    expect(brandName.parentElement).toHaveClass('-ml-1.5', 'opacity-0', 'max-w-0');
    expect(brandName).toHaveClass('text-[14px]', 'font-bold', 'tracking-[-0.015em]');
    expect(screen.getByText('Houston: standing by')).toHaveClass(
      'font-mono',
      'text-[9px]'
    );
    expect(screen.getByText('Houston: standing by')).toHaveStyle({ color: '#60a5fa' });

    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));

    expect(brandName.parentElement).toHaveClass('opacity-100', 'max-w-[128px]');
  });

  it('reflects active Houston work in the brand subtitle', () => {
    renderNavRail({ isAiActive: true });

    expect(screen.getByText('Houston: working')).toHaveClass(
      'font-mono',
      'text-[9px]'
    );
    expect(screen.getByText('Houston: working')).toHaveStyle({ color: '#a855f7' });
  });

  it('replaces the static brand mark with the alternating signal while syncing', () => {
    localStorage.setItem(SYNC_ICON_PREFERENCE_KEY, 'alternating');
    renderNavRail({ isSyncing: true });

    const syncIcon = screen.getByTestId('mission-control-sync-icon');
    const outbound = syncIcon.querySelector('[data-signal-direction="outbound"]');
    const inbound = syncIcon.querySelector('[data-signal-direction="inbound"]');
    const pathData = (group: Element | null) =>
      Array.from(group?.querySelectorAll('path') ?? [], path => path.getAttribute('d'));

    expect(syncIcon).toBeInTheDocument();
    expect(document.querySelector('.lucide-satellite')).not.toBeInTheDocument();
    expect(pathData(inbound)).toEqual(pathData(outbound));
    expect(inbound?.querySelector('g')).toHaveAttribute(
      'transform',
      'matrix(-1 0 0 -1 14.8 34.6)'
    );
  });

  it('renders three independent particle streams when that treatment is selected', () => {
    localStorage.setItem(SYNC_ICON_PREFERENCE_KEY, 'particles');
    renderNavRail({ isSyncing: true });

    const syncIcon = screen.getByTestId('mission-control-sync-icon');
    const streams = syncIcon.querySelector('[data-particle-streams="true"]');

    expect(syncIcon).toHaveAttribute('data-sync-variant', 'particles');
    expect(streams?.querySelectorAll('line')).toHaveLength(3);
    expect(streams?.querySelectorAll('circle, rect')).toHaveLength(3);
  });

  it('chooses a new treatment at the start of each sync when both are enabled', () => {
    localStorage.setItem(SYNC_ICON_PREFERENCE_KEY, 'both');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const rendered = renderNavRail({ isSyncing: true });

    expect(screen.getByTestId('mission-control-sync-icon')).toHaveAttribute(
      'data-sync-variant',
      'particles'
    );

    rendered.rerender(
      <TooltipProvider>
        <NavRail features={{ aiEnabled: true, financeEnabled: true }} isAiActive={false} isSyncing={false} />
      </TooltipProvider>
    );
    random.mockReturnValue(0.1);
    rendered.rerender(
      <TooltipProvider>
        <NavRail features={{ aiEnabled: true, financeEnabled: true }} isAiActive={false} isSyncing />
      </TooltipProvider>
    );

    expect(screen.getByTestId('mission-control-sync-icon')).toHaveAttribute(
      'data-sync-variant',
      'alternating'
    );
    random.mockRestore();
  });

  it('groups navigation by purpose', () => {
    renderNavRail();

    expect(screen.getByRole('group', { name: 'Plan' })).toHaveTextContent(
      'DashboardMy DayProjectsKanbanGoalsTimeline'
    );
    expect(screen.getByRole('group', { name: 'Operate' })).toHaveTextContent(
      'NotificationsRoutinesTriageQuick SortReconciliation'
    );
    expect(screen.getByRole('group', { name: 'Understand' })).toHaveTextContent(
      'InsightsGraph'
    );
    expect(screen.getByRole('group', { name: 'Domains' })).toHaveTextContent(
      'DocsMoney'
    );
    expect(screen.getByRole('group', { name: 'Assistant' })).toHaveTextContent(
      'Houston'
    );
  });

  it('uses distinct colors for adjacent Routines and Triage icons', () => {
    renderNavRail();

    const routinesIcon = screen.getByRole('link', { name: 'Routines' }).querySelector('svg');
    const triageIcon = screen.getByRole('link', { name: 'Triage' }).querySelector('svg');
    const quickSortIcon = screen.getByRole('link', { name: 'Quick Sort' }).querySelector('svg');

    expect(routinesIcon).toHaveClass('text-emerald-400');
    expect(triageIcon).toHaveClass('text-purple-400');
    expect(quickSortIcon).toHaveClass('text-amber-400');
  });

  it('uses Tyrion-styled coins for Money', () => {
    renderNavRail();

    const moneyIcon = screen.getByRole('link', { name: 'Money' }).querySelector('svg');

    expect(moneyIcon).toHaveClass('lucide-coins', 'text-amber-400');
  });

  it('hides Money when no finance connector is enabled', () => {
    render(
      <TooltipProvider>
        <NavRail features={{ aiEnabled: true, financeEnabled: false }} isAiActive={false} />
      </TooltipProvider>
    );

    expect(screen.queryByRole('link', { name: 'Money' })).not.toBeInTheDocument();
  });
});
