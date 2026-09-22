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
    expect(screen.getByRole('button', { name: 'Critical update available 2' })
      .querySelector('.lucide-package')).toHaveClass('text-red-400');
    expect(screen.getByRole('button', { name: 'Device alert 3' })
      .querySelector('.lucide-radio')).toHaveClass('text-cyan-400');
  });

  it('keeps type discoverable and flattens sources with one instance', () => {
    render(
      <NotificationsSidebar
        hook={{
          facets: {
            level: { heads_up: 3 },
            category: {},
            source: { 'home-assistant': 3 },
            sourceAccount: [
              { key: 'ha-home', label: 'Home', source: 'home-assistant', count: 3 },
            ],
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
        savedViews={<div>Saved views marker</div>}
      />,
    );

    expect(screen.getByText('Choose a source to see its types.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Home 3' })).not.toBeInTheDocument();
    const sourceFilter = screen.getByRole('button', { name: 'Home Assistant 3' });
    expect(sourceFilter).not.toHaveAttribute('aria-expanded');
    expect(sourceFilter.querySelector('.lucide-chevron-right')).not.toBeInTheDocument();

    const source = screen.getByRole('button', { name: 'Source' });
    const level = screen.getByRole('button', { name: 'Level' });
    const type = screen.getByRole('button', { name: 'Type' });
    const savedViews = screen.getByText('Saved views marker');
    expect(source.compareDocumentPosition(level) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(level.compareDocumentPosition(type) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(type.compareDocumentPosition(savedViews) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
