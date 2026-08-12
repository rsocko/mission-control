import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TriageSourceIcon } from '@/components/triage/TriageSourceIcon';

describe('TriageSourceIcon', () => {
  it('labels informative brand images and hides decorative brand images', () => {
    const { container, rerender } = render(<TriageSourceIcon source="github" />);

    expect(screen.getByRole('img', { name: 'GitHub' })).toBeInTheDocument();

    rerender(<TriageSourceIcon source="github" decorative />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('labels informative fallback icons and hides decorative fallback icons', () => {
    const { container, rerender } = render(<TriageSourceIcon source="ios_share" />);

    expect(screen.getByRole('img', { name: 'iOS Share' })).toBeInTheDocument();

    rerender(<TriageSourceIcon source="ios_share" decorative />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
