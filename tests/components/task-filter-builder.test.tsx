import { fireEvent, render, screen } from '@testing-library/react';
import { TaskFilterBuilder } from '@/components/filters/TaskFilterBuilder';
describe('TaskFilterBuilder', () => {
  it('adds included and excluded values from guided categories', () => {
    const onToggleToken = vi.fn();
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[{ type: 'github-issues', name: 'GitHub Issues', icon: 'github' }]}
        sourceLists={[]}
        tags={[]}
        assignees={['octo-org']}
        projects={[]}
        onToggleToken={onToggleToken}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Priority' }));
    fireEvent.click(screen.getByRole('button', { name: /P1 High/ }));
    expect(onToggleToken).toHaveBeenCalledWith('priority', 'high', false);

    fireEvent.click(screen.getByRole('button', { name: 'Including' }));
    fireEvent.click(screen.getByRole('button', { name: /P3 Low/ }));
    expect(onToggleToken).toHaveBeenCalledWith('priority', 'low', true);
  });

  it('builds due-date comparison tokens', () => {
    const onToggleToken = vi.fn();
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[]}
        sourceLists={[]}
        tags={[]}
        assignees={['octo-org']}
        projects={[]}
        onToggleToken={onToggleToken}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Due Date' }));
    fireEvent.click(screen.getByRole('button', { name: 'Before date' }));
    fireEvent.change(screen.getByLabelText('Before date'), { target: { value: '2026-08-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(onToggleToken).toHaveBeenCalledWith('due', '<2026-08-01', false);
  });

  it('searches dynamic values', () => {
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[]}
        sourceLists={[]}
        tags={[
          { id: 'one', name: 'area:tasks', slug: 'area-tasks', type: 'label', color: null },
          { id: 'two', name: 'type:feature', slug: 'type-feature', type: 'label', color: null },
        ]}
        assignees={['octo-org']}
        projects={[]}
        onToggleToken={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tag' }));
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'feature' } });

    expect(screen.getByRole('button', { name: 'type:feature' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'area:tasks' })).not.toBeInTheDocument();
  });

  it('adds project and phase filters and exposes unassigned values', () => {
    const onToggleToken = vi.fn();
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[]}
        sourceLists={[]}
        tags={[]}
        assignees={[]}
        projects={[{
          id: 'project-1',
          name: 'Mission Control',
          color: '#000000',
          icon: null,
          phases: [{ id: 'phase-1', name: 'Delivery' }],
        }]}
        onToggleToken={onToggleToken}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Project' }));
    fireEvent.click(screen.getByRole('button', { name: 'No project' }));
    expect(onToggleToken).toHaveBeenCalledWith('project', 'none', false);

    fireEvent.click(screen.getByRole('button', { name: 'Back to filter categories' }));
    fireEvent.click(screen.getByRole('button', { name: 'Phase' }));
    fireEvent.click(screen.getByRole('button', { name: /Delivery/ }));
    expect(onToggleToken).toHaveBeenCalledWith('phase', 'phase-1', false);
  });

  it('hides scoped categories without removing their related options', () => {
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[]}
        sourceLists={[]}
        tags={[]}
        assignees={[]}
        projects={[{
          id: 'project-1',
          name: 'Mission Control',
          color: '#000000',
          icon: null,
          phases: [{ id: 'phase-1', name: 'Delivery' }],
        }]}
        hiddenCategories={['project']}
        onToggleToken={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));

    expect(screen.queryByRole('button', { name: 'Project' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Phase' })).toBeInTheDocument();
  });

  it.each([
    ['Assignee', 'No assignee', 'assignee'],
    ['Tag', 'No tags', 'tag'],
    ['List', 'No list', 'list'],
    ['Priority', 'No priority', 'priority'],
    ['Project', 'No project', 'project'],
    ['Phase', 'No phase', 'phase'],
    ['Due Date', 'No due date', 'due'],
  ] as const)('offers an unassigned option for %s', (category, option, type) => {
    const onToggleToken = vi.fn();
    render(
      <TaskFilterBuilder
        tokens={[]}
        sources={[]}
        sourceLists={[]}
        tags={[]}
        assignees={[]}
        projects={[]}
        onToggleToken={onToggleToken}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add Filter' }));
    fireEvent.click(screen.getByRole('button', { name: category }));
    fireEvent.click(screen.getByRole('button', { name: option }));

    expect(onToggleToken).toHaveBeenCalledWith(type, 'none', false);
  });
});
