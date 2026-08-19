import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NotificationsSidebar } from '@/components/notifications/NotificationsSidebar';
import { DEFAULT_NOTIFICATION_QUERY } from '@/lib/notifications/query';

describe('notifications sidebar', () => {
  it('uses level colors on icons without rendering attention dots', () => {
    render(
      <NotificationsSidebar
        hook={{
          facets: {
            level: { heads_up: 4 },
            category: {},
            source: {},
            state: {},
            merchant: [],
          },
          filters: DEFAULT_NOTIFICATION_QUERY,
          setLevelFilter: vi.fn(),
          setSourceFilter: vi.fn(),
          setStateFilter: vi.fn(),
          setDateRangeFilter: vi.fn(),
        }}
      />,
    );

    const urgent = screen.getByRole('button', { name: 'Urgent' });
    expect(urgent.querySelector('.lucide-triangle-alert')).toHaveStyle({ color: '#ef4444' });
    expect(urgent.querySelector('.rounded-full')).not.toBeInTheDocument();

    const headsUp = screen.getByRole('button', { name: 'Heads Up 4' });
    expect(headsUp.querySelector('.lucide-bell-ring')).toHaveStyle({ color: '#3b82f6' });
    expect(headsUp.querySelector('.rounded-full')).not.toBeInTheDocument();
  });
});
