import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DemoModeBanner } from '@/components/DemoModeBanner';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function modeResponse(publicDemo: boolean) {
  return {
    ok: true,
    json: async () => ({ mode: 'demo', publicDemo }),
  } as Response;
}

describe('DemoModeBanner', () => {
  it('labels a public demo without offering live mode', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(modeResponse(true)));

    render(<DemoModeBanner />);

    expect(await screen.findByText(/Public Demo/)).toBeInTheDocument();
    expect(screen.getByText(/changes reset on restart/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Switch to Live/ })).not.toBeInTheDocument();
  });

  it('retains the live-mode action for a regular local demo', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(modeResponse(false))
      .mockResolvedValueOnce({ ok: true }));

    render(<DemoModeBanner />);

    expect(await screen.findByText(/Demo Mode/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Switch to Live/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm switch to Live' }));
    await waitFor(() => expect(screen.queryByText(/Demo Mode/)).not.toBeInTheDocument());
  });
});
