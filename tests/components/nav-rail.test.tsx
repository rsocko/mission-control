import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavRail } from '@/components/layout/NavRail';
import { TooltipProvider } from '@/components/ui/Tooltip';
import { SYNC_ICON_PREFERENCE_KEY } from '@/lib/hooks/useSyncIconPreference';
import type { ConnectorHealthInfo } from '@/lib/hooks/useSystemHealth';
import type { NavigationCounts } from '@/lib/navigation/badges';
import { RECENT_PROJECT_IDS_STORAGE_KEY } from '@/lib/navigation/recent-projects';
import { RecentProjectsNavItem } from '@/components/layout/RecentProjectsNavItem';
import { ChartNetwork } from 'lucide-react';

function renderNavRail({
  isAiActive = false,
  isSyncing = false,
  syncStatus = [],
  counts,
}: {
  isAiActive?: boolean;
  isSyncing?: boolean;
  syncStatus?: ConnectorHealthInfo[];
  counts?: NavigationCounts;
} = {}) {
  return render(
    <TooltipProvider>
      <NavRail
        features={{ aiEnabled: true, financeEnabled: true }}
        isAiActive={isAiActive}
        isSyncing={isSyncing}
        syncStatus={syncStatus}
        counts={counts}
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

  it('expands for keyboard focus so secondary navigation controls are reachable', () => {
    renderNavRail();
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });

    fireEvent.focus(screen.getByRole('link', { name: 'Projects' }));

    expect(nav).toHaveClass('w-[200px]');
    expect(screen.getByRole('button', { name: 'Open recent projects' })).toBeInTheDocument();
  });

  it('uses the shared shortcut icon and color for quick-access destinations', () => {
    renderNavRail();

    const cases = [
      ['My Day', 'lucide-sun', 'text-amber-400'],
      ['Triage', 'lucide-inbox', 'text-purple-400'],
      ['Projects', 'lucide-chart-network', 'text-violet-400'],
      ['Icon Finder', 'lucide-search', 'text-indigo-400'],
    ];

    for (const [name, iconClass, colorClass] of cases) {
      const icon = screen.getByRole('link', { name }).querySelector('svg');
      expect(icon).toHaveClass(iconClass, colorClass);
    }
  });

  it('opens recently viewed projects without changing the Projects destination', async () => {
    vi.useRealTimers();
    localStorage.setItem(
      RECENT_PROJECT_IDS_STORAGE_KEY,
      JSON.stringify(['proj-second', 'proj-first']),
    );
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      projects: [
        { id: 'proj-first', name: 'First project', color: '#3b82f6', icon: null },
        { id: 'proj-second', name: 'Second project', color: '#a855f7', icon: null },
      ],
    }), { status: 200 }));
    renderNavRail();

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    fireEvent.mouseEnter(nav);
    await waitFor(() => expect(nav).toHaveClass('w-[200px]'));

    const projectsLink = screen.getByRole('link', { name: 'Projects' });
    expect(projectsLink).toHaveAttribute('href', '/projects');
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open recent projects' }), {
      key: 'Enter',
    });

    const menu = await screen.findByRole('menu', { name: 'Recent projects' });
    await within(menu).findByRole('menuitem', { name: 'Second project' });
    const recentLinks = within(menu).getAllByRole('menuitem').slice(0, 2);
    expect(recentLinks.map((link) => link.textContent)).toEqual([
      'Second project',
      'First project',
    ]);
    expect(recentLinks[0]).toHaveAttribute('href', '/projects/proj-second');
    expect(within(menu).getByRole('menuitem', { name: 'View all projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it('records project detail visits as recently viewed', async () => {
    vi.useRealTimers();
    localStorage.setItem(
      RECENT_PROJECT_IDS_STORAGE_KEY,
      JSON.stringify(['proj-older', 'proj-current']),
    );

    render(
      <TooltipProvider>
        <RecentProjectsNavItem
          active
          expanded
          icon={ChartNetwork}
          open={false}
          pathname="/projects/proj-current"
          onOpenChange={() => {}}
        />
      </TooltipProvider>,
    );

    await waitFor(() => {
      expect(JSON.parse(localStorage.getItem(RECENT_PROJECT_IDS_STORAGE_KEY) || '[]')).toEqual([
        'proj-current',
        'proj-older',
      ]);
    });
  });

  it('shows an empty recent-project state without fetching', async () => {
    vi.useRealTimers();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    renderNavRail();

    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    fireEvent.mouseEnter(nav);
    await waitFor(() => expect(nav).toHaveClass('w-[200px]'));
    fireEvent.keyDown(screen.getByRole('button', { name: 'Open recent projects' }), {
      key: 'Enter',
    });

    const menu = await screen.findByRole('menu', { name: 'Recent projects' });
    expect(await within(menu).findByText('Projects you visit will appear here.')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
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
    const gradientId = brandIcon?.querySelector('linearGradient')?.getAttribute('id');

    expect(screen.queryByRole('link', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(brandIcon).toHaveClass('lucide-satellite');
    expect(gradientId).toMatch(/^mission-control-brand-gradient-/);
    expect(brandIcon?.getAttribute('stroke')).toBe(`url(#${gradientId})`);
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

  it('opens sync status from the nav and shows active syncing state', () => {
    renderNavRail({
      isSyncing: true,
      syncStatus: [
        {
          id: 'connector-1',
          type: 'local',
          name: 'Local',
          status: 'healthy',
          message: 'Healthy',
          lastSyncAt: undefined,
        },
      ],
    });

    fireEvent.click(screen.getByRole('button', { name: 'Sync status' }));

    const heading = screen.getByRole('heading', { name: 'Sync Status' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main navigation' })).not.toContainElement(heading);
    expect(screen.getAllByText('Syncing…').length).toBeGreaterThan(0);
    expect(screen.getByText('Local')).toBeInTheDocument();
    expect(screen.getByText('Never')).toBeInTheDocument();
  });

  it('shows inline sync details whenever the navigation is expanded', () => {
    renderNavRail({ isSyncing: true });
    const nav = screen.getByRole('navigation', { name: 'Main navigation' });
    const getInlineStatus = () =>
      screen.getByRole('button', { name: 'Sync status' }).querySelector('span:last-child');

    expect(getInlineStatus()).toHaveClass('opacity-0', 'max-w-0');

    fireEvent.mouseEnter(nav);
    act(() => vi.advanceTimersByTime(300));

    expect(getInlineStatus()).toHaveClass('opacity-100', 'max-w-[150px]');
    expect(getInlineStatus()).toHaveTextContent('Syncing…');
  });

  it('previews sync status while hovering the control or popover', () => {
    renderNavRail({ isSyncing: true });
    const trigger = screen.getByRole('button', { name: 'Sync status' });

    fireEvent.mouseEnter(trigger);

    const popover = screen.getByRole('dialog', { name: 'Sync status details' });
    expect(popover).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(popover).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    act(() => vi.advanceTimersByTime(50));
    fireEvent.mouseEnter(popover);
    act(() => vi.advanceTimersByTime(100));
    expect(popover).toBeInTheDocument();

    fireEvent.mouseLeave(popover);
    act(() => vi.advanceTimersByTime(100));
    expect(screen.queryByRole('dialog', { name: 'Sync status details' })).not.toBeInTheDocument();
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

  it('morphs a single element between collapsed bar and expanded badge', () => {
    renderNavRail({
      counts: {
        myDay: 12,
        notifications: 0,
        triage: 0,
        quickSort: 0,
        reconciliation: 0,
        overdue: 0,
        unreadNotifications: 0,
        notificationTone: 'blue',
      },
    });

    const morph = screen.getByLabelText('12 items need attention');
    expect(morph).toHaveAttribute('data-pressure-level', 'medium');
    expect(morph).toHaveAttribute('data-morph-state', 'bar');

    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));

    // Same DOM node must survive the transition, otherwise the morph restarts
    // from a stale frame (the My Day "jump up" regression).
    const expandedMorph = screen.getByLabelText('12 items need attention');
    expect(expandedMorph).toBe(morph);
    expect(expandedMorph).toHaveAttribute('data-morph-state', 'badge');
    expect(within(expandedMorph).getByText('12')).toBeInTheDocument();
  });

  it('pulses only urgent notification indicators', () => {
    renderNavRail({
      counts: {
        myDay: 0,
        notifications: 4,
        triage: 4,
        quickSort: 0,
        reconciliation: 0,
        overdue: 0,
        unreadNotifications: 4,
        notificationTone: 'red',
      },
    });

    const urgentNotification = screen.getAllByLabelText('4 items need attention')[0];
    const triage = screen.getAllByLabelText('4 items need attention')[1];
    expect(urgentNotification).toHaveClass('bg-red-500', 'motion-safe:animate-pulse');
    expect(triage).toHaveClass('bg-red-500');
    expect(triage).not.toHaveClass('motion-safe:animate-pulse');

    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));

    const notificationLink = screen.getByRole('link', { name: /^Notifications/ });
    expect(within(notificationLink).getByLabelText('4 items need attention')).toHaveClass(
      'bg-red-500',
      'motion-safe:animate-pulse',
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
