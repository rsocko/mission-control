import { render, screen, within } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePathname } from 'next/navigation';
import { GraphRouteShell } from '@/components/graph/GraphRouteShell';

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(),
}));

vi.mock('lucide-react', () => {
  const Icon = () => <span aria-hidden="true" />;
  return {
    ChartNetwork: Icon,
    Cloud: Icon,
    Lightbulb: Icon,
    Orbit: Icon,
    Tags: Icon,
  };
});

const mockedUsePathname = vi.mocked(usePathname);

describe('GraphRouteShell', () => {
  beforeEach(() => {
    mockedUsePathname.mockReturnValue('/graph/words');
  });

  it('presents every graph view in the expected order', () => {
    render(<GraphRouteShell><div>Graph content</div></GraphRouteShell>);

    const navigation = screen.getByRole('navigation', { name: 'Graph views' });
    const links = within(navigation).getAllByRole('link');

    expect(links.map((link) => link.textContent?.trim())).toEqual([
      'Project',
      'Ideation',
      'Universe',
      'Tags',
      'Words',
    ]);
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '/projects',
      '/graph/ideation',
      '/graph/universe',
      '/graph/tags',
      '/graph/words',
    ]);
  });

  it('exposes only the current view with an accessible active state', () => {
    render(<GraphRouteShell><div>Graph content</div></GraphRouteShell>);

    expect(screen.getByRole('link', { name: 'Words' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Tags' })).not.toHaveAttribute('aria-current');
  });

  it('does not activate a link for a merely similar pathname', () => {
    mockedUsePathname.mockReturnValue('/graph/words-extra');

    render(<GraphRouteShell><div>Graph content</div></GraphRouteShell>);

    expect(screen.getByRole('link', { name: 'Words' })).not.toHaveAttribute('aria-current');
  });
});
