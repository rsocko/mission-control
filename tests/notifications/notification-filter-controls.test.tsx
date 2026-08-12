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
  it('gives desktop and mobile identical choices, selected labels, and applied counts', () => {
    const onDesktopChange = vi.fn();
    const onMobileChange = vi.fn();
    render(
      <>
        <div data-testid="desktop">
          <NotificationFilterControls query={query} facets={facets} onChange={onDesktopChange} />
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
    const mobile = within(screen.getByTestId('mobile'));
    for (const label of ['Category filter', 'Source filter', 'Merchant filter']) {
      const desktopControl = desktop.getByRole('combobox', { name: label });
      const mobileControl = mobile.getByRole('combobox', { name: label });
      expect(
        within(desktopControl).getAllByRole('option').map(option => option.textContent),
      ).toEqual(
        within(mobileControl).getAllByRole('option').map(option => option.textContent),
      );
    }
    expect(desktop.getByRole('combobox', { name: 'Category filter' })).toHaveValue('finance');
    expect(mobile.getByRole('combobox', { name: 'Source filter' })).toHaveValue('finance-manager');
    expect(mobile.getByRole('combobox', { name: 'Merchant filter' })).toHaveValue(merchant);
    expect(desktop.getByText('3 filters applied')).toBeInTheDocument();
    expect(mobile.getByText('3 filters applied')).toBeInTheDocument();
    expect(activeNotificationFilters(query, facets).map(filter => filter.label)).toEqual([
      'Category: Finance',
      'Merchant: Invented Market',
      'Source: Finance Manager',
    ]);
  });

  it('clears one or all filters without changing sort and exposes mobile touch targets', () => {
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

    fireEvent.click(screen.getByRole('button', { name: 'Clear all filters' }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...DEFAULT_NOTIFICATION_QUERY,
      sort: 'oldest',
    });
    expect(screen.getByRole('combobox', { name: 'Merchant filter' })).toHaveClass('min-h-[44px]');
  });

  it('moves focus to a stable filter control when an applied filter unmounts', () => {
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
    const merchantChip = screen.getByRole('button', {
      name: 'Clear Merchant: Invented Market filter',
    });
    merchantChip.focus();
    fireEvent.click(merchantChip);
    expect(screen.getByRole('combobox', { name: 'Merchant filter' })).toHaveFocus();

    const clearAll = screen.getByRole('button', { name: 'Clear all filters' });
    clearAll.focus();
    fireEvent.click(clearAll);
    expect(screen.getByRole('combobox', { name: 'Category filter' })).toHaveFocus();
  });
});
