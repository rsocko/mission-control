import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import {
  NavigationBadge,
  NavigationPressureBar,
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

  it('matches high-pressure shared badge width to its collapsed line', () => {
    const { rerender } = render(
      <NavigationBadge count={60} tone="amber" morphId="myDay" />,
    );
    expect(screen.getByText('60')).toHaveClass('w-[30px]');

    rerender(<NavigationBadge count={60} tone="amber" />);
    expect(screen.getByText('60')).not.toHaveClass('w-[30px]');
  });

  it('uses discrete centered pressure lengths for collapsed navigation', () => {
    const { rerender } = render(
      <NavigationPressureBar count={7} tone="amber" morphId="myDay" />,
    );
    expect(screen.getByLabelText('7 items need attention')).toHaveAttribute('data-pressure-level', 'low');
    expect(screen.getByLabelText('7 items need attention')).toHaveClass(
      'left-1/2',
      '-translate-x-1/2',
      'w-2',
    );
    expect(screen.getByLabelText('7 items need attention')).toHaveAttribute(
      'data-layout-anchor',
      'bottom-center',
    );

    rerender(<NavigationPressureBar count={12} tone="amber" morphId="myDay" />);
    expect(screen.getByLabelText('12 items need attention')).toHaveAttribute('data-pressure-level', 'medium');
    expect(screen.getByLabelText('12 items need attention')).toHaveClass('w-4');
    expect(screen.getByLabelText('12 items need attention')).toHaveAttribute(
      'data-layout-anchor',
      'bottom-center',
    );

    rerender(<NavigationPressureBar count={99} tone="red" morphId="notifications" />);
    expect(screen.getByLabelText('99 items need attention')).toHaveAttribute('data-pressure-level', 'high');
    expect(screen.getByLabelText('99 items need attention')).toHaveClass('w-[30px]');
    expect(screen.getByLabelText('99 items need attention')).toHaveAttribute(
      'data-layout-anchor',
      'bottom-center',
    );
  });

  it('can pulse urgent indicators without changing non-urgent defaults', () => {
    const { rerender } = render(<NavigationPressureBar count={4} tone="red" pulse />);
    expect(screen.getByLabelText('4 items need attention')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="red" pulse />);
    expect(screen.getByText('4')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="amber" />);
    expect(screen.getByText('4')).not.toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={12} tone="amber" morphId="myDay" />);
    expect(screen.getByText('12')).toHaveAttribute('data-layout-anchor', 'bottom-center');

    rerender(<NavigationBadge count={12} tone="amber" morphId="notifications" />);
    expect(screen.getByText('12')).toHaveAttribute('data-layout-anchor', 'bottom-center');

    rerender(<NavigationBadge count={12} tone="amber" />);
    expect(screen.getByText('12')).not.toHaveAttribute('data-layout-anchor');
  });

  it('keeps the same shared element identity between pressure bar and badge', () => {
    const { rerender } = render(
      <NavigationPressureBar count={4} tone="amber" morphId="myDay" />,
    );
    expect(screen.getByLabelText('4 items need attention')).toHaveAttribute(
      'data-morph-id',
      'myDay',
    );
    expect(screen.getByLabelText('4 items need attention')).toHaveAttribute(
      'data-layout-anchor',
      'bottom-center',
    );

    rerender(<NavigationBadge count={4} tone="amber" morphId="myDay" />);
    expect(screen.getByText('4')).toHaveAttribute('data-morph-id', 'myDay');
    expect(screen.getByText('4')).toHaveAttribute('data-layout-anchor', 'bottom-center');
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
