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
            priority: 19,
            organizationalContext: 14,
            urgency: 10,
            planningHorizon: 14,
            momentum: 6,
            sourceTrust: 3,
            snoozePenalty: -3,
            total: 63,
            audit: {
              confidence: { level: 'medium', percentage: 70 },
              evidence: [{
                factor: 'momentum',
                label: 'Committed to My Day',
                detail: 'This task is in My Day now.',
                points: 6,
              }],
              missingSignals: ['No priority entity matches this task'],
              sessionFit: {
                estimatedDuration: null,
                effort: 4,
                status: 'todo',
                note: 'Duration and effort inform contextual planning, not Smart Score.',
              },
              ranking: {
                scope: {
                  label: 'Homelab',
                  rank: 2,
                  total: 250,
                  topPercent: 0.8,
                },
                overall: {
                  label: 'all open tasks',
                  rank: 12,
                  total: 8912,
                  topPercent: 0.2,
                },
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    fireEvent.focus(screen.getByRole('group', { name: 'Smart score: 64 out of 100' }));

    expect(await screen.findAllByText('Attention-worthiness, not ease of execution')).not.toHaveLength(0);
    expect(screen.getAllByText('19 / 25')[0]).toBeInTheDocument();
    expect(screen.getAllByText('14 / 20')[0]).toBeInTheDocument();
    expect(screen.getAllByText('6 / 10')[0]).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar', { name: 'Priority' })[0]).toHaveStyle({ width: '76%' });
    expect(screen.getAllByRole('progressbar', { name: 'Planning horizon' })[0]).toHaveStyle({ width: '70%' });
    expect(screen.getAllByRole('progressbar', { name: 'Momentum' })[0]).toHaveStyle({ width: '60%' });
    expect(screen.getAllByText(/Duration unknown/)[0]).toBeInTheDocument();
    expect(screen.getAllByText('#2 of 250 · Top 0.8%')[0]).toBeInTheDocument();
    expect(screen.getAllByText('#12 of 8,912 · Top 0.2%')[0]).toBeInTheDocument();
  });

  it('uses percentile-specific content and color only in percentile display mode', async () => {
    render(
      <TooltipProvider>
        <SmartScoreBadge
          score={64}
          displayMode="percentile"
          breakdown={{
            priority: 19,
            organizationalContext: 14,
            urgency: 10,
            planningHorizon: 14,
            momentum: 6,
            sourceTrust: 3,
            snoozePenalty: 0,
            total: 66,
            audit: {
              confidence: { level: 'medium', percentage: 70 },
              evidence: [],
              missingSignals: [],
              sessionFit: {
                estimatedDuration: null,
                effort: null,
                status: 'todo',
                note: 'Duration and effort inform contextual planning, not Smart Score.',
              },
              ranking: {
                scope: {
                  label: 'current view',
                  rank: 1,
                  total: 200,
                  topPercent: 0.5,
                },
              },
            },
          }}
        />
      </TooltipProvider>,
    );

    expect(screen.getByRole('group', {
      name: 'Smart score percentile: top 0.5 percent in current view',
    })).toHaveTextContent('Top 0.5%');
    expect(screen.getByText('Top 0.5%').className).toContain('text-emerald-950');
  });
});
