import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  GraphLoadingState,
  ProjectGraphPhaseDetails,
} from '@/components/graph/ProjectStructureGraphParts';

describe('project structure graph rendering parts', () => {
  it('renders the staged loading state independently', () => {
    render(<GraphLoadingState stage="layout" />);

    expect(screen.getByRole('status')).toHaveTextContent('Arranging project graph');
    expect(screen.getByRole('progressbar', {
      name: 'Project graph loading progress',
    })).toBeInTheDocument();
  });

  it('renders phase details independently and delegates close behavior', () => {
    const onClose = vi.fn();
    render(
      <ProjectGraphPhaseDetails
        phase={{
          id: 'phase:planning',
          entityId: 'planning',
          kind: 'phase',
          label: 'Planning',
          description: 'Define the delivery path.',
          status: 'in_progress',
          taskCount: 3,
        }}
        statusLabel="In progress"
        onClose={onClose}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Planning' })).toBeInTheDocument();
    expect(screen.getByText('3 tasks · In progress')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Close phase details' }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
