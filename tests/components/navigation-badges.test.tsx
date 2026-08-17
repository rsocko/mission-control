import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NavigationBadge } from '@/components/layout/NavigationBadge';
import { NavBadgeSettingsCard } from '@/app/settings/components/NavBadgeSettingsCard';
import {
  DEFAULT_NAVIGATION_BADGE_PREFERENCES,
  type NavigationBadgePreferences,
} from '@/lib/hooks/useNavigationBadges';
import { getNotificationBadgeTone } from '@/lib/navigation/badges';

describe('navigation badges', () => {
  beforeEach(() => {
    localStorage.clear();
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
