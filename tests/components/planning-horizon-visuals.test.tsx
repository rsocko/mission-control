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

    fireEvent.focus(screen.getByLabelText(/About planning horizon/));

    expect(await screen.findAllByText('Broad planning intent, independent of due dates.'))
      .not.toHaveLength(0);
  });

  it('uses a consistent temporal palette for values and badges', () => {
    const { container } = render(
      <>
        <PlanningHorizonOption value="now" />
        <PlanningHorizonOption value="next" />
        <PlanningHorizonOption value="later" />
        <PlanningHorizonOption value="someday" />
        <PlanningHorizonOption value={null} />
        <PlanningHorizonBadge planningHorizon="later" />
      </>,
    );

    expect(screen.getByText('Now').previousElementSibling).toHaveClass('bg-emerald-400');
    expect(screen.getByText('Next').previousElementSibling).toHaveClass('bg-blue-400');
    expect(screen.getAllByText('Later')[0].previousElementSibling).toHaveClass('bg-violet-400');
    expect(screen.getByText('Someday').previousElementSibling).toHaveClass('bg-slate-400');
    expect(screen.getByText('Not set').previousElementSibling).toHaveClass('border');
    expect(screen.getByTitle('Planning horizon: Later')).toHaveClass('text-violet-400');
    expect(container.querySelector('.lucide-clock-3')).toBeInTheDocument();
    expect(container.querySelector('.lucide-layers-3')).not.toBeInTheDocument();
  });
});
