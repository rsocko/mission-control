import { fireEvent, render, screen } from '@testing-library/react';
import { GroupByDropdown } from '@/components/toolbar/GroupByDropdown';
import { SortDropdown, type SortOption } from '@/components/toolbar/SortDropdown';

const OPTIONS: readonly SortOption[] = [
  { value: 'manual', label: 'Manual Order', supportsDirection: false },
  { value: 'priority', label: 'Priority' },
];

describe('ordering dropdowns', () => {
  it('supports a controlled Manual Order option without a direction control', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <SortDropdown
        options={OPTIONS}
        value="priority"
        direction="asc"
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sort by: Priority' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manual Order' }));
    expect(onChange).toHaveBeenCalledWith('manual', 'asc');

    rerender(
      <SortDropdown
        options={OPTIONS}
        value="manual"
        direction="asc"
        onChange={onChange}
      />,
    );
    expect(screen.queryByRole('button', { name: /Sort direction/ })).not.toBeInTheDocument();
  });

  it('reports controlled grouping changes to its owner', () => {
    const onChange = vi.fn();
    render(<GroupByDropdown value="none" onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Group by: None' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Project + Phase' }));

    expect(onChange).toHaveBeenCalledWith('project');
  });
});
