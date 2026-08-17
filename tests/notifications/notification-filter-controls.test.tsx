import { useState } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  NotificationFilterControls,
  activeNotificationFilters,
} from '@/components/notifications/NotificationFilterControls';
import type { NotificationFacets } from '@/lib/hooks/useNotifications';
import {
  DEFAULT_NOTIFICATION_QUERY,
  type NotificationQuery,
} from '@/lib/notifications/query';

const merchant = `merchant-v1_${'A'.repeat(43)}`;
const facets: NotificationFacets = {
  level: { heads_up: 3 },
  category: { finance: 3, tasks: 2 },
  source: { 'finance-manager': 3, 'github-issues': 2 },
  state: { unread: 5 },
  merchant: [{ key: merchant, label: 'Invented Market', count: 2 }],
};
const query: NotificationQuery = {
  ...DEFAULT_NOTIFICATION_QUERY,
  category: 'finance',
  source: 'finance-manager',
  merchant,
};

describe('shared notification filter controls', () => {
  it('offers task-style filter types and facet-backed values on desktop and mobile', () => {
    const onDesktopChange = vi.fn();
    const onMobileChange = vi.fn();
    render(
      <>
        <div data-testid="desktop">
          <NotificationFilterControls
            query={query}
            facets={facets}
            onChange={onDesktopChange}
            includeCommonFilters={false}
          />
        </div>
        <div data-testid="mobile">
          <NotificationFilterControls
            query={query}
            facets={facets}
            onChange={onMobileChange}
            touchTargets
          />
        </div>
      </>,
    );

    const desktop = within(screen.getByTestId('desktop'));
    fireEvent.click(desktop.getByRole('button', { name: 'Add filter' }));
    expect(desktop.getByRole('dialog', { name: 'Add a notification filter' })).toBeInTheDocument();
    expect(desktop.queryByRole('button', { name: 'Source' })).not.toBeInTheDocument();
    fireEvent.click(desktop.getByRole('button', { name: 'Category' }));
    expect(desktop.getByRole('button', { name: /Finance\s+3/ })).toBeInTheDocument();
    expect(desktop.getByRole('button', { name: /Tasks\s+2/ })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });

    const mobile = within(screen.getByTestId('mobile'));
    fireEvent.click(mobile.getByRole('button', { name: 'Add filter' }));
    expect(mobile.getByRole('button', { name: 'Source' })).toBeInTheDocument();
    expect(mobile.getByRole('button', { name: 'Add filter' })).toHaveClass('min-h-[44px]');
    expect(activeNotificationFilters(query, facets).map(filter => filter.label)).toEqual([
      'Category: Finance',
      'Merchant: Invented Market',
      'Source: Finance Manager',
    ]);
  });

  it('adds free-text and boolean criteria through the builder', () => {
    const onChange = vi.fn();
    render(
      <NotificationFilterControls
        query={DEFAULT_NOTIFICATION_QUERY}
        facets={facets}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Repository' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Repository' }), {
      target: { value: 'octo/app' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      repository: 'octo/app',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Participating only' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      participating: true,
    });
  });

  it('clears one or all filters without changing sort and returns focus to the builder', () => {
    const onChange = vi.fn();
    render(
      <NotificationFilterControls
        query={{ ...query, sort: 'oldest' }}
        facets={facets}
        onChange={onChange}
        touchTargets
      />,
    );

    const merchantChip = screen.getByRole('button', {
      name: 'Clear Merchant: Invented Market filter',
    });
    expect(merchantChip).toHaveClass('min-h-[44px]');
    fireEvent.click(merchantChip);
    expect(onChange).toHaveBeenLastCalledWith({ ...query, merchant: null, sort: 'oldest' });
    expect(screen.getByRole('button', { name: 'Add filter' })).toHaveFocus();

    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      sort: 'oldest',
    });
  });

  it('keeps chip focus recovery stable as controlled filters unmount', () => {
    function FilterHarness() {
      const [currentQuery, setCurrentQuery] = useState(query);
      return (
        <NotificationFilterControls
          query={currentQuery}
          facets={facets}
          onChange={setCurrentQuery}
        />
      );
    }

    render(<FilterHarness />);
    fireEvent.click(screen.getByRole('button', {
      name: 'Clear Merchant: Invented Market filter',
    }));
    expect(screen.getByRole('button', { name: 'Add filter' })).toHaveFocus();
  });
});
