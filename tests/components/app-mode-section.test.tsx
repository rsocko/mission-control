import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppModeSection } from '@/app/settings/components/AppModeSection';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AppModeSection database capabilities', () => {
  it('disables demo and destructive controls on PostgreSQL', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      mode: 'live',
      publicDemo: false,
      databaseBackend: 'postgres',
      demoOperationsSupported: false,
    }), { status: 200 })));

    render(<AppModeSection />);

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Demo mode and destructive demo-data tools are disabled',
    );
    expect(screen.getByRole('button', { name: /Demo Mode/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reset' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear Samples' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Clear All' })).toBeDisabled();
  });

  it('shows an API failure as an error instead of a success message', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mode: 'live',
        publicDemo: false,
        databaseBackend: 'sqlite',
        demoOperationsSupported: true,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: 'Reset failed',
      }), { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);

    render(<AppModeSection />);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, Reset' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Reset failed');
    expect(screen.queryByText('Demo data reset')).not.toBeInTheDocument();
  });
});
