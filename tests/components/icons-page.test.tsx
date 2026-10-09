import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import IconsPage from '@/app/icons/page';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IconsPage', () => {
  it('renders searched Iconify results from a batched icon-set request', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/search?') && url.includes('prefix=mdi')) {
        return {
          ok: true,
          json: async () => ({ icons: ['mdi:zoom-in', 'mdi:zoom-out'], total: 2 }),
        };
      }
      if (url.includes('/mdi.json?')) {
        return {
          ok: true,
          json: async () => ({
            prefix: 'mdi',
            width: 24,
            height: 24,
            icons: {
              'zoom-in': { body: '<path d="M4 4h8v8H4z"/>' },
              'zoom-out': { body: '<path d="M2 2h12v12H2z"/>' },
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IconsPage />);
    fireEvent.click(screen.getByRole('button', { name: '⬡ MDI' }));
    fireEvent.change(screen.getByPlaceholderText('Search icons… (⌘K)'), {
      target: { value: 'zoom' },
    });

    const zoomIn = await screen.findByRole('img', { name: 'mdi:zoom-in' });
    expect(zoomIn.style.maskImage).toContain(encodeURIComponent('M4 4h8v8H4z'));
    expect(await screen.findByRole('img', { name: 'mdi:zoom-out' })).toBeVisible();

    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringMatching(/\/mdi\/zoom-(?:in|out)\.svg/),
      );
    });
  });
});
