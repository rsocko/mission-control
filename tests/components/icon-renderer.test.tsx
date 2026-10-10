import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IconPicker } from '@rsocko/icon-picker/picker';
import { IconRenderer } from '@rsocko/icon-picker/renderer';
import {
  getIconUrl,
  getSimpleIconNames,
  parseIconValue,
  serializeIconValue,
} from '@rsocko/icon-picker/core';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('IconRenderer', () => {
  it('preserves every supported stored value without a database migration', () => {
    expect(parseIconValue('🚀')).toEqual({ source: 'emoji', name: '🚀' });
    expect(parseIconValue('lucide:rocket')).toEqual({ source: 'lucide', name: 'rocket' });
    expect(parseIconValue('rocket')).toEqual({ source: 'lucide', name: 'rocket' });
    expect(serializeIconValue({ source: 'emoji', name: '🚀' })).toBe('🚀');
    expect(serializeIconValue({ source: 'dash', name: 'home-assistant' }))
      .toBe('dash:home-assistant');
  });

  it('normalizes current and legacy Simple Icons catalog responses', () => {
    expect(getSimpleIconNames({ uncategorized: ['github', 'visualstudiocode'] })).toEqual([
      'github',
      'visualstudiocode',
    ]);
    expect(getSimpleIconNames([{ title: 'GitHub' }, { title: 'Visual Studio Code' }])).toEqual([
      'github',
      'visualstudiocode',
    ]);
    expect(getSimpleIconNames({ icons: [{ slug: 'custom-slug', title: 'Custom' }] })).toEqual([
      'custom-slug',
    ]);
  });

  it('preserves renamed Dashboard Icons values', () => {
    expect(getIconUrl({ source: 'dash', name: 'pihole' })).toContain('/pi-hole.svg');
    expect(getIconUrl({ source: 'si', name: 'twitter' })).toContain('/x');
  });

  it('inherits the theme color for uncolored monochrome icons', () => {
    render(<IconRenderer value="pin" size={16} />);

    const icon = screen.getByRole('img', { name: 'lucide icon: pin' });
    expect(icon.tagName).toBe('SPAN');
    expect(icon).toHaveClass('rs-icon-picker__renderer-mask');
    expect(icon).toHaveStyle({ width: '16px', height: '16px' });
    expect(icon.style.maskImage).toContain('/lucide/pin.svg');
  });

  it('falls back when a masked (uncolored) remote icon fails to load', () => {
    render(<IconRenderer value="pin" size={16} fallback={<span data-testid="fallback">?</span>} />);

    // The masked icon renders optimistically alongside a hidden probe <img>
    // used solely to detect load failures (mask-image has no error event).
    expect(screen.getByRole('img', { name: 'lucide icon: pin' })).toBeInTheDocument();
    expect(screen.queryByTestId('fallback')).not.toBeInTheDocument();

    const probe = document.querySelector('img[aria-hidden="true"]');
    expect(probe).not.toBeNull();
    fireEvent.error(probe as HTMLImageElement);

    expect(screen.queryByRole('img', { name: 'lucide icon: pin' })).not.toBeInTheDocument();
    expect(screen.getByTestId('fallback')).toBeInTheDocument();
  });

  it('requests the selected color when one is set', () => {
    render(<IconRenderer value="lucide:pin" size={16} color="#3b82f6" />);

    expect(screen.getByRole('img', { name: 'lucide icon: pin' })).toHaveAttribute(
      'src',
      expect.stringContaining('color=%233b82f6'),
    );
  });

  it('offers the theme-aware color as an explicit picker option', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    const onColorChange = vi.fn();
    render(
      <IconPicker
        value="lucide:pin"
        onChange={vi.fn()}
        color="#3b82f6"
        onColorChange={onColorChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Use theme color' }));
    expect(onColorChange).toHaveBeenCalledWith('');
  });

  it('keeps every icon source available in the responsive source group', () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    render(<IconPicker value={null} onChange={vi.fn()} />);

    const sourceGroup = screen.getByRole('group', { name: 'Icon sources' });
    expect(sourceGroup).toHaveClass('rs-icon-picker__filters');
    for (const source of ['Emoji', 'Lucide', 'Material', 'Phosphor', 'Apps', 'Brands']) {
      expect(screen.getByRole('button', { name: source })).toBeVisible();
    }
  });

  it('renders aliases in the default Iconify icon groups', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/lucide.json?')) {
        return {
          ok: true,
          json: async () => ({
            prefix: 'lucide',
            width: 24,
            height: 24,
            icons: {
              house: { body: '<path d="M3 11 12 2l9 9v11H3z"/>' },
            },
            aliases: { home: { parent: 'house' } },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<IconPicker value={null} onChange={vi.fn()} />);

    const aliasResult = await screen.findByRole('img', { name: 'lucide:home' });
    expect(aliasResult.style.maskImage).toContain(encodeURIComponent('M3 11 12 2l9 9v11H3z'));
  });

  it('renders searched Iconify results from batched icon-set requests', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/search?') && url.includes('prefix=mdi')) {
        return {
          ok: true,
          json: async () => ({ icons: ['mdi:city', 'mdi:room'], total: 2 }),
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
              city: { body: '<path fill="currentColor" d="M0 0h24v24H0z"/>' },
              'map-marker': { body: '<path fill="currentColor" d="M12 2v20"/>' },
            },
            aliases: { room: { parent: 'map-marker' } },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = render(
      <IconPicker value={null} onChange={vi.fn()} searchDebounceMs={0} />,
    );
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search icons' }), {
      target: { value: 'city' },
    });

    const result = await screen.findByRole('img', { name: 'mdi:city' });
    expect(result).toHaveStyle({ backgroundColor: 'currentColor' });
    expect(result.style.maskImage).toContain('data:image/svg+xml');

    const aliasResult = await screen.findByRole('img', { name: 'mdi:room' });
    expect(aliasResult.style.maskImage).toContain(encodeURIComponent('M12 2v20'));

    const maskImage = result.style.maskImage;
    rerender(
      <IconPicker
        value={null}
        onChange={vi.fn()}
        color="#3b82f6"
        searchDebounceMs={0}
      />,
    );
    expect(await screen.findByRole('img', { name: 'mdi:city' })).toHaveStyle({
      backgroundColor: '#3b82f6',
    });
    expect(screen.getByRole('img', { name: 'mdi:city' }).style.maskImage).toBe(maskImage);
    await waitFor(() => {
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringMatching(/\/mdi\/city\.svg/),
      );
    });
  });

  it('surfaces provider failures without discarding built-in choices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));

    render(<IconPicker value={null} onChange={vi.fn()} searchDebounceMs={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'Lucide' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search icons' }), {
      target: { value: 'rocketship' },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'One provider is temporarily unavailable.',
    );
    expect(screen.getByRole('button', { name: 'Retry providers' })).toBeInTheDocument();
  });
});
