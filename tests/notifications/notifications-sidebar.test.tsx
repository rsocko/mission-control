import { fireEvent, render, screen } from '@testing-library/react';
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
            sourceAccount: [],
            notificationType: [],
            state: {},
            merchant: [],
          },
          filters: DEFAULT_NOTIFICATION_QUERY,
          setLevelFilter: vi.fn(),
          setSourceFilter: vi.fn(),
          setSourceAccountFilter: vi.fn(),
          setNotificationTypeFilter: vi.fn(),
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

  it('nests instances under the active source and shows contextual types', () => {
    const setSourceAccountFilter = vi.fn();
    const setNotificationTypeFilter = vi.fn();
    render(
      <NotificationsSidebar
        hook={{
          facets: {
            level: { action_needed: 2, heads_up: 3 },
            category: {},
            source: { 'home-assistant': 5 },
            sourceAccount: [
              { key: 'ha-home', label: 'Home', source: 'home-assistant', count: 3 },
              { key: 'ha-cabin', label: 'Cabin', source: 'home-assistant', count: 2 },
            ],
            notificationType: [
              { key: 'ha_update_critical', label: 'ha_update_critical', count: 2 },
              { key: 'home_assistant_entity_alert', label: 'home_assistant_entity_alert', count: 3 },
            ],
            state: {},
            merchant: [],
          },
          filters: { ...DEFAULT_NOTIFICATION_QUERY, source: 'home-assistant' },
          setLevelFilter: vi.fn(),
          setSourceFilter: vi.fn(),
          setSourceAccountFilter,
          setNotificationTypeFilter,
          setStateFilter: vi.fn(),
          setDateRangeFilter: vi.fn(),
        }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cabin 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Critical update available 2' }));

    expect(setSourceAccountFilter).toHaveBeenCalledWith('ha-cabin');
    expect(setNotificationTypeFilter).toHaveBeenCalledWith('ha_update_critical');
    expect(screen.getByRole('button', { name: 'Device alert 3' })).toBeInTheDocument();
  });
});
