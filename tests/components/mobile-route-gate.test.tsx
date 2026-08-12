import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MobileRouteGate } from '@/components/layout/MobileRouteGate';
import { getRouteMetadata } from '@/lib/navigation/route-metadata';

describe('MobileRouteGate', () => {
  const setViewport = (matches: boolean) => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({
        matches,
        media: '(max-width: 639px)',
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  };

  beforeEach(() => {
    setViewport(true);
  });

  it('explains that unsupported phone routes remain available on desktop or tablet', () => {
    render(
      <MobileRouteGate route={getRouteMetadata('/kanban')}>
        <div>Kanban board</div>
      </MobileRouteGate>
    );

    expect(
      screen.getByRole('heading', { name: "Kanban isn't available on this phone" })
    ).toBeInTheDocument();
    expect(screen.getByText(/Open this view on a desktop or tablet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Today' })).toHaveAttribute('href', '/today');
    expect(screen.getByRole('link', { name: 'View all tasks' })).toHaveAttribute('href', '/all-tasks');
    expect(screen.queryByText('Kanban board')).not.toBeInTheDocument();
  });

  it('mounts route content only after confirming a tablet or desktop viewport', async () => {
    setViewport(false);
    const { container } = render(
      <MobileRouteGate route={getRouteMetadata('/timeline')}>
        <div>Timeline calendar</div>
      </MobileRouteGate>
    );

    const message = screen.getByRole('region', {
      name: "Timeline isn't available on this phone",
    });
    expect(message).toHaveClass('sm:hidden');

    const desktopContent = (await screen.findByText('Timeline calendar')).parentElement;
    expect(desktopContent).toHaveClass('hidden', 'sm:block');
    expect(container).toHaveTextContent('desktop or tablet');
    await waitFor(() => {
      expect(screen.queryByRole('status', { name: 'Loading Timeline...' })).not.toBeInTheDocument();
    });
  });

  it('allows hidden routes that support phone layouts to render normally', () => {
    render(
      <MobileRouteGate route={getRouteMetadata('/doc-intelligence')}>
        <div>Document actions</div>
      </MobileRouteGate>
    );

    expect(screen.getByText('Document actions')).toBeInTheDocument();
    expect(screen.queryByText(/desktop or tablet/)).not.toBeInTheDocument();
  });
});
