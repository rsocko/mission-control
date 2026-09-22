import { fireEvent, render, screen } from '@testing-library/react';
import { EmptyStateQueryFilters } from '@/components/filters/EmptyStateQueryFilters';

describe('EmptyStateQueryFilters', () => {
  it('renders project:none as a removable badge', () => {
    const onQueryChange = vi.fn();

    render(
      <EmptyStateQueryFilters
        query="project:none"
        projects={[]}
        onQueryChange={onQueryChange}
      />,
    );

    expect(screen.getByText('project: No project')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove project:none filter' }));
    expect(onQueryChange).toHaveBeenCalledWith('');
  });

  it('removes only the selected structured query filter', () => {
    const onQueryChange = vi.fn();

    render(
      <EmptyStateQueryFilters
        query="project:none due:overdue"
        projects={[]}
        onQueryChange={onQueryChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove project:none filter' }));
    expect(onQueryChange).toHaveBeenCalledWith('due:overdue');
  });
});
