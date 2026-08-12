import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavRail } from '@/components/layout/NavRail';
import { TooltipProvider } from '@/components/ui/Tooltip';

function renderNavRail() {
  return render(
    <TooltipProvider>
      <NavRail features={{ aiEnabled: true, financeEnabled: true }} isAiActive={false} />
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
    const brandIcon = brandName.previousElementSibling?.querySelector('svg');

    expect(screen.queryByRole('link', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mission Control' })).not.toBeInTheDocument();
    expect(brandIcon).toHaveClass('lucide-satellite', 'text-violet-400');
    expect(brandName).toHaveClass('opacity-0', 'max-w-0');

    fireEvent.click(screen.getByRole('button', { name: 'Pin navigation open' }));

    expect(brandName).toHaveClass('opacity-100', 'max-w-[128px]');
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
