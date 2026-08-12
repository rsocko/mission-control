import { fireEvent, render, screen } from '@testing-library/react';
import { ShowCompletedToggle } from '@/components/toolbar/ShowCompletedToggle';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';

describe('ShowCompletedToggle', () => {
  afterEach(() => {
    useDashboardViewStore.getState().setStatusFilter([]);
  });

  it('supports controlled task collections without mutating dashboard filters', () => {
    const onShowCompletedChange = vi.fn();
    useDashboardViewStore.getState().setStatusFilter(['cancelled']);
    render(
      <ShowCompletedToggle
        showCompleted={false}
        onShowCompletedChange={onShowCompletedChange}
      />,
    );

    const toggle = screen.getByRole('button', { name: 'Show completed tasks' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(onShowCompletedChange).toHaveBeenCalledWith(true);
    expect(useDashboardViewStore.getState().statusFilter).toEqual(['cancelled']);
  });
});
