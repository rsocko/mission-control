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
import { getNotificationBadgeTone } from '@/lib/navigation/badges';
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

  it('hides zero counts and caps large counts', () => {
    const { rerender } = render(<NavigationBadge count={0} tone="red" />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();

    rerender(<NavigationBadge count={125} tone="red" />);
    expect(screen.getByText('99+')).toHaveAttribute('aria-label', '125 items need attention');
  });

  it('uses discrete centered pressure lengths for collapsed navigation', () => {
    const { rerender } = render(<NavigationPressureBar count={7} tone="amber" />);
    expect(screen.getByLabelText('7 items need attention')).toHaveAttribute('data-pressure-level', 'low');
    expect(screen.getByLabelText('7 items need attention')).toHaveClass('left-1/2', '-translate-x-1/2', 'w-2');

    rerender(<NavigationPressureBar count={12} tone="amber" />);
    expect(screen.getByLabelText('12 items need attention')).toHaveAttribute('data-pressure-level', 'medium');
    expect(screen.getByLabelText('12 items need attention')).toHaveClass('w-4');

    rerender(<NavigationPressureBar count={99} tone="red" />);
    expect(screen.getByLabelText('99 items need attention')).toHaveAttribute('data-pressure-level', 'high');
    expect(screen.getByLabelText('99 items need attention')).toHaveClass('w-[30px]');
  });

  it('can pulse urgent indicators without changing non-urgent defaults', () => {
    const { rerender } = render(<NavigationPressureBar count={4} tone="red" pulse />);
    expect(screen.getByLabelText('4 items need attention')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="red" pulse />);
    expect(screen.getByText('4')).toHaveClass('motion-safe:animate-pulse');

    rerender(<NavigationBadge count={4} tone="amber" />);
    expect(screen.getByText('4')).not.toHaveClass('motion-safe:animate-pulse');
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
