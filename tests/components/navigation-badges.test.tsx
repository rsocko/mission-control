import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import {
  NavigationBadge,
  NavigationRailMorph,
} from '@/components/layout/NavigationBadge';
import { NavBadgeSettingsCard } from '@/app/settings/components/NavBadgeSettingsCard';
import {
  DEFAULT_NAVIGATION_BADGE_PREFERENCES,
  type NavigationBadgePreferences,
  useNavigationCounts,
} from '@/lib/hooks/useNavigationBadges';
import { getNotificationBadgeState, getNotificationBadgeTone } from '@/lib/navigation/badges';
import { getLocalToday } from '@/lib/utils/client-date';

describe('navigation badges', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses the highest notification severity for the badge tone', () => {
    expect(getNotificationBadgeTone(1, 5)).toBe('red');
    expect(getNotificationBadgeTone(0, 5)).toBe('amber');
    expect(getNotificationBadgeTone(0, 0)).toBe('blue');
  });

  it('uses the count from only the highest notification severity', () => {
    expect(getNotificationBadgeState({
      attention: 9,
      urgent: 2,
      actionNeeded: 3,
      headsUp: 1,
      fyi: 3,
    })).toEqual({ count: 2, tone: 'red' });
    expect(getNotificationBadgeState({
      attention: 7,
      urgent: 0,
      actionNeeded: 0,
      headsUp: 2,
      fyi: 5,
    })).toEqual({ count: 2, tone: 'blue' });
  });

  it('hides zero counts and caps large counts', () => {
    const { rerender } = render(<NavigationBadge count={0} tone="red" />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    rerender(<NavigationBadge count={125} tone="red" />);
    expect(screen.getByText('99+')).toHaveAttribute('aria-label', '125 items need attention');
  });

  it('matches high-pressure badge width to its collapsed line', () => {
    render(<NavigationRailMorph count={60} tone="amber" expanded morphId="myDay" />);
    expect(screen.getByTestId('navigation-rail-morph')).toHaveAttribute(
      'data-pressure-level',
      'high',
    );
  });

  it('uses discrete pressure levels for the collapsed rail', () => {
    const { rerender } = render(
      <NavigationRailMorph count={7} tone="amber" expanded={false} morphId="myDay" />,
    );
    const morph = () => screen.getByTestId('navigation-rail-morph');
    expect(morph()).toHaveAttribute('data-pressure-level', 'low');
    expect(morph()).toHaveAttribute('data-morph-state', 'bar');

    rerender(<NavigationRailMorph count={12} tone="amber" expanded={false} morphId="myDay" />);
    expect(morph()).toHaveAttribute('data-pressure-level', 'medium');

    rerender(<NavigationRailMorph count={99} tone="red" expanded={false} morphId="notifications" />);
    expect(morph()).toHaveAttribute('data-pressure-level', 'high');
  });

  it('keeps one element mounted across the collapse/expand morph', () => {
    // Regression: the rail used to swap two elements sharing a layoutId, which
    // made the first badge in DOM order (My Day) jump vertically. A single
    // persistent element must survive the transition instead.
    const { rerender } = render(
      <NavigationRailMorph count={4} tone="amber" expanded={false} morphId="myDay" />,
    );
    const collapsed = screen.getByTestId('navigation-rail-morph');
    expect(collapsed).toHaveAttribute('data-morph-state', 'bar');

    rerender(<NavigationRailMorph count={4} tone="amber" expanded morphId="myDay" />);
    const expandedMorph = screen.getByTestId('navigation-rail-morph');
    expect(expandedMorph).toBe(collapsed);
    expect(expandedMorph).toHaveAttribute('data-morph-state', 'badge');
    expect(expandedMorph).toHaveAttribute('data-morph-id', 'myDay');
  });

  it('renders identical morph markup regardless of nav position', () => {
    const { unmount } = render(
      <NavigationRailMorph count={4} tone="amber" expanded={false} morphId="myDay" />,
    );
    const first = screen.getByTestId('navigation-rail-morph').getAttribute('style');
    unmount();

    render(
      <NavigationRailMorph count={4} tone="amber" expanded={false} morphId="reconciliation" />,
    );
    expect(screen.getByTestId('navigation-rail-morph')).toHaveAttribute('style', first!);
  });

  it('can pulse urgent indicators without changing non-urgent defaults', () => {
    const { rerender } = render(
      <NavigationRailMorph count={4} tone="red" expanded={false} pulse morphId="triage" />,
    );
    expect(screen.getByTestId('navigation-rail-morph')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="red" pulse />);
    expect(screen.getByText('4')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="amber" />);
    expect(screen.getByText('4')).not.toHaveClass('motion-safe:animate-pulse');
  });

  it('keeps the same element identity between pressure bar and badge', () => {
    const { rerender } = render(
      <NavigationRailMorph count={4} tone="amber" expanded={false} morphId="myDay" />,
    );
    const el = screen.getByTestId('navigation-rail-morph');
    expect(el).toHaveAttribute('data-morph-id', 'myDay');

    rerender(<NavigationRailMorph count={4} tone="amber" expanded morphId="myDay" />);
    expect(screen.getByTestId('navigation-rail-morph')).toBe(el);
  });

  it('requests navigation counts for the browser-local date', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        myDay: 2,
        notifications: 0,
        triage: 0,
        quickSort: 0,
        reconciliation: 0,
        overdue: 0,
        unreadNotifications: 0,
        notificationTone: 'blue',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useNavigationCounts(), { wrapper });

    await waitFor(() => expect(result.current.myDay).toBe(2));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/navigation/counts?date=${getLocalToday()}`,
    );
  });

  it('persists master and per-destination visibility choices', () => {
    render(<NavBadgeSettingsCard />);

    fireEvent.click(screen.getByRole('switch', { name: 'Show My Day badge' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Show navigation badges' }));

    const stored = JSON.parse(
      localStorage.getItem('mission-control:navigation-badges:v1') ?? '{}',
    ) as NavigationBadgePreferences;
    expect(stored).toEqual({
      ...DEFAULT_NAVIGATION_BADGE_PREFERENCES,
      enabled: false,
      items: {
        ...DEFAULT_NAVIGATION_BADGE_PREFERENCES.items,
        myDay: false,
      },
    });
    expect(screen.getByRole('switch', { name: 'Show My Day badge' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
