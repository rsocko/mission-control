import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WorkActivityChart } from '@/components/insights/WorkActivityChart';

const data = {
  lists: [{ key: 'work', label: 'Work', active: 12, closed: 7 }],
  tags: [{ key: 'planning', label: 'Planning', active: 4, closed: 9 }],
  projects: [],
  sources: [{ key: 'github', label: 'GitHub', active: 6, closed: 3 }],
};

describe('WorkActivityChart', () => {
  it('compares active and closed counts and switches dimensions accessibly', () => {
    render(<WorkActivityChart data={data} />);

    expect(screen.getByRole('img', { name: 'Work: 12 active now, 7 closed in the selected period' }))
      .toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Lists' })).toHaveAttribute('aria-selected', 'true');

    fireEvent.click(screen.getByRole('tab', { name: 'Tags' }));

    expect(screen.getByRole('tab', { name: 'Tags' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: 'Tags activity' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Planning: 4 active now, 9 closed in the selected period' }))
      .toBeInTheDocument();
  });

  it('shows a dimension-specific empty state', () => {
    render(<WorkActivityChart data={data} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Projects' }));
    expect(screen.getByText('No projects have active or recently closed tasks.')).toBeInTheDocument();
  });
});
