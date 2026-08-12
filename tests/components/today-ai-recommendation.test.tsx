import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AIRecommendation } from '@/components/today/AIRecommendation';

describe('AIRecommendation', () => {
  it('renders recommendation Markdown as formatted content', () => {
    render(
      <AIRecommendation
        recommendation={`1. **Watch "Lost City of Z"** - Unwind after work.
2. **Review notifications** - Clear the unread items.`}
        onDismiss={vi.fn()}
      />,
    );

    const list = screen.getByRole('list');
    expect(list.tagName).toBe('OL');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Watch "Lost City of Z"', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText(/1\. \*\*Watch/)).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('dismisses the recommendation', () => {
    const onDismiss = vi.fn();
    render(<AIRecommendation recommendation="Take a break." onDismiss={onDismiss} />);

    const dismissButton = screen.getByRole('button', { name: 'Dismiss AI recommendation' });
    expect(dismissButton).toHaveClass('min-h-10', 'min-w-10');
    fireEvent.click(dismissButton);

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
