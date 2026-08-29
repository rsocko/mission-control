import { fireEvent, render, screen } from '@testing-library/react';
import {
  PlanningHorizonFieldLabel,
  PlanningHorizonOption,
} from '@/components/PlanningHorizonVisuals';
import { PlanningHorizonBadge } from '@/components/task-list/PlanningHorizonBadge';
import { TooltipProvider } from '@/components/ui/Tooltip';

describe('planning horizon visuals', () => {
  it('explains the field from a focusable clock icon', async () => {
    render(
      <TooltipProvider>
        <PlanningHorizonFieldLabel />
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByLabelText(/About horizon/));

    expect(await screen.findAllByText('Broad planning intent, independent of due dates.'))
      .not.toHaveLength(0);
  });

  it('uses a consistent temporal palette for values and badges', () => {
    const { container } = render(
      <TooltipProvider>
        <>
          <PlanningHorizonOption value="next" />
          <PlanningHorizonOption value="soon" />
          <PlanningHorizonOption value="later" />
          <PlanningHorizonOption value="someday" />
          <PlanningHorizonOption value={null} />
          <PlanningHorizonBadge planningHorizon="later" />
        </>
      </TooltipProvider>,
    );

    expect(screen.getByText('Next').previousElementSibling).toHaveTextContent('H1');
    expect(screen.getByText('Next').previousElementSibling).toHaveClass('text-emerald-400');
    expect(screen.getByText('Soon').previousElementSibling).toHaveTextContent('H2');
    expect(screen.getByText('Soon').previousElementSibling).toHaveClass('text-blue-400');
    expect(screen.getByText('Later').previousElementSibling).toHaveTextContent('H3');
    expect(screen.getByText('Later').previousElementSibling).toHaveClass('text-violet-400');
    expect(screen.getByText('Someday').previousElementSibling).toHaveTextContent('∞');
    expect(screen.getByText('Someday').previousElementSibling).toHaveClass('text-slate-400');
    expect(screen.getByText('Not set').previousElementSibling).toHaveClass('border');
    expect(screen.getByLabelText('Horizon: Later')).toHaveTextContent('H3');
    expect(screen.getByLabelText('Horizon: Later')).not.toHaveTextContent('Later');
    expect(screen.getByLabelText('Horizon: Later')).toHaveClass('text-violet-400');
    expect(container.querySelector('.lucide-telescope')).not.toBeInTheDocument();
    expect(container.querySelector('.lucide-clock-3')).not.toBeInTheDocument();
    expect(container.querySelector('.lucide-layers-3')).not.toBeInTheDocument();
  });

  it('shows the full horizon label in a row badge tooltip', async () => {
    render(
      <TooltipProvider>
        <PlanningHorizonBadge planningHorizon="soon" />
      </TooltipProvider>,
    );

    fireEvent.pointerMove(screen.getByLabelText('Horizon: Soon'), {
      pointerType: 'mouse',
    });

    expect(await screen.findByRole('tooltip')).toHaveTextContent('Horizon: Soon');
  });
});
