import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import packageJson from '../../package.json';
import { AboutSection } from '@/app/settings/components/AboutSection';

describe('AboutSection', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows current release details and project resources', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: true, revision: '0123456789abcdef0123456789abcdef' }),
    }));

    render(<AboutSection />);

    expect(screen.getByRole('heading', { name: 'About Mission Control' })).toBeInTheDocument();
    expect(screen.getByText(`v${packageJson.version}`)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('0123456789ab')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledWith('/api/health/live', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));

    const sourceLink = screen.getByRole('link', { name: /Source code/ });
    const documentationLink = screen.getByRole('link', { name: /Documentation/ });
    const supportLink = screen.getByRole('link', { name: /Support and feedback/ });
    const licensingLink = screen.getByRole('link', { name: /Licensing status/ });

    expect(sourceLink).toHaveAttribute('href', 'https://github.com/rsocko/mission-control');
    expect(documentationLink).toHaveAttribute(
      'href',
      'https://github.com/rsocko/mission-control/tree/main/docs/public',
    );
    expect(supportLink).toHaveAttribute('href', 'https://github.com/rsocko/mission-control/issues');
    expect(licensingLink).toHaveAttribute(
      'href',
      'https://github.com/rsocko/mission-control/blob/main/docs/governance/licensing.md',
    );
  });

  it('shows when build information is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    render(<AboutSection />);

    await waitFor(() => expect(screen.getByText('Unavailable')).toBeInTheDocument());
  });

  it('distinguishes an unreported development build from a request failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ live: true, revision: 'unreported' }),
    }));

    render(<AboutSection />);

    await waitFor(() => expect(screen.getByText('Unreported')).toBeInTheDocument());
  });
});
