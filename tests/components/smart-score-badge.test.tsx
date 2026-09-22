import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SmartScoreBadge } from '@/components/smart-score/SmartScoreBadge';
import { TooltipProvider } from '@/components/ui/Tooltip';

vi.mock('@/components/ui/AnimatedCounter', () => ({
  AnimatedCounter: ({ value }: { value: number }) => <>{value}</>,
}));

describe('SmartScoreBadge', () => {
  it('shows new factors and scales each bar against that factor maximum', async () => {
    render(
      <TooltipProvider>
        <SmartScoreBadge
          score={64}
          breakdown={{
            priorityBase: 15,
            entityTier: 10,
            urgency: 10,
            planningHorizon: 7,
            sourceRank: 5,
            freshness: 6,
            executionFit: 4,
            snoozePenalty: -3,
            total: 54,
          }}
        />
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByRole('group', { name: 'Smart score: 64 out of 100' }));

    expect(await screen.findAllByText('Each factor uses its own maximum')).not.toHaveLength(0);
    expect(screen.getAllByText('15 / 20')[0]).toBeInTheDocument();
    expect(screen.getAllByText('7 / 10')[0]).toBeInTheDocument();
    expect(screen.getAllByText('4 / 5')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar', { name: 'Priority' })[0]).toHaveStyle({ width: '75%' });
    expect(screen.getAllByRole('progressbar', { name: 'Planning horizon' })[0]).toHaveStyle({ width: '70%' });
    expect(screen.getAllByRole('progressbar', { name: 'Execution fit' })[0]).toHaveStyle({ width: '80%' });
  });
});
