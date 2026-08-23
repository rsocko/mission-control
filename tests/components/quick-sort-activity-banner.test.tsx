import { render, screen } from '@testing-library/react';
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
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      json: () => Promise.resolve({
        thisWeek: {
          total: 10,
          byMode: {
            no_priority: 4,
            quadrant: 1,
            no_effort: 3,
            no_tags: 2,
            no_due_date: 1,
          },
        },
        streak: 5,
      }),
    }));

    render(<ActivityBanner />);

    expect(await screen.findByText(/tasks sorted this week/)).toBeDefined();
    expect(screen.getAllByTestId('animated-counter').map((counter) => counter.textContent))
      .toEqual(['10', '5', '4', '1', '3', '2', '1']);
  });
});
