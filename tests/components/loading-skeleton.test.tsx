import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RouteLoadingSkeleton } from '@/components/ui/Skeleton';

describe('route loading skeleton', () => {
  it('announces that the page is loading without collapsing the content area', () => {
    render(<RouteLoadingSkeleton />);

    const loadingRegion = screen.getByLabelText('Loading page');
    expect(loadingRegion).toHaveAttribute('aria-busy', 'true');
    expect(loadingRegion).toHaveClass('h-full', 'min-h-0');
  });
});
