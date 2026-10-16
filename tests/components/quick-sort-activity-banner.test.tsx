import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityBanner from '@/components/quick-sort/ActivityBanner';

vi.mock('@/components/ui/AnimatedCounter', () => ({
  AnimatedCounter: ({ value }: { value: number }) => (
    <span data-testid="animated-counter">{value}</span>
  ),
}));

describe('Quick Sort activity banner', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders activity totals and the streak with animated counters', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        thisWeek: {
          total: 10,
          byMode: {
            no_priority: 4,
            quadrant: 1,
            no_effort: 3,
            no_tags: 2,
            no_planning_horizon: 1,
            no_project: 2,
          },
        },
        streak: 5,
      })),
    ));

    render(<ActivityBanner />);

    await screen.findAllByTestId('animated-counter');
    expect(document.body).toHaveTextContent('10 tasks sorted this week');
    expect(screen.getAllByTestId('animated-counter').map((counter) => counter.textContent))
      .toEqual(['10', '5', '4', '1', '3', '2', '1', '2']);
  });

  it('keeps the previous summary mounted while refreshed stats are pending', async () => {
    let resolveRefresh: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        thisWeek: {
          total: 10,
          byMode: {
            no_priority: 4,
            quadrant: 1,
            no_effort: 3,
            no_tags: 2,
            no_planning_horizon: 1,
            no_project: 2,
          },
        },
        streak: 5,
      })))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      }));
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(<ActivityBanner refreshKey={0} />);
    await screen.findAllByTestId('animated-counter');
    expect(document.body).toHaveTextContent('10 tasks sorted this week');

    rerender(<ActivityBanner refreshKey={1} />);
    expect(document.body).toHaveTextContent('10 tasks sorted this week');

    await act(async () => {
      if (!resolveRefresh) throw new Error('Expected pending stats refresh');
      resolveRefresh(new Response(JSON.stringify({
        thisWeek: {
          total: 11,
          byMode: {
            no_priority: 4,
            quadrant: 1,
            no_effort: 3,
            no_tags: 3,
            no_planning_horizon: 1,
            no_project: 2,
          },
        },
        streak: 5,
      })));
    });

    expect(document.body).toHaveTextContent('11 tasks sorted this week');
  });
});
