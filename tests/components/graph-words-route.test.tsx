import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import WordsGraphPage from '@/app/graph/words/page';
import WordInsightsPage from '@/app/word-insights/page';

vi.mock('@/components/word-insights/WordInsightsLoader', () => ({
  default: () => <div>Shared word insights</div>,
}));

describe('word insights routes', () => {
  it.each([
    ['canonical graph route', WordsGraphPage],
    ['compatible legacy route', WordInsightsPage],
  ])('renders the existing lazy loader from the %s', (_label, Page) => {
    render(<Page />);

    expect(screen.getByText('Shared word insights')).toBeInTheDocument();
  });
});
