import { beforeEach, describe, expect, it, vi } from 'vitest';

const manifestState = vi.hoisted(() => ({
  shortcuts: [] as Array<{
    id: string;
    name: string;
    url: string;
    description: string;
    icon: string;
    enabled: boolean;
  }>,
}));

vi.mock('@/lib/mode', () => ({
  getShortcuts: () => manifestState.shortcuts,
  getLaunchMode: () => 'navigate-existing',
  MAX_ENABLED_SHORTCUTS: 4,
}));

import { GET } from '@/app/api/manifest/route';

describe('PWA manifest branding', () => {
  beforeEach(() => {
    manifestState.shortcuts = [];
  });

  it('uses app chrome colors and the complete branded icon set', async () => {
    const response = await GET();
    const manifest = await response.json();

    expect(manifest.background_color).toBe('#020617');
    expect(manifest.theme_color).toBe('#0b1120');
    expect(manifest.icons).toEqual([
      { src: '/icon-v4-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-v4-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-v4-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-v4-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('only includes configured shortcuts and uses their navigation-matched icons', async () => {
    manifestState.shortcuts = [
      {
        id: 'icon-finder',
        name: 'Icon Finder',
        url: '/icons',
        description: 'Search and copy icons',
        icon: 'shortcut-icon-finder.svg',
        enabled: true,
      },
      {
        id: 'today',
        name: 'My Day',
        url: '/today',
        description: 'View today\'s tasks',
        icon: 'shortcut-today.svg',
        enabled: true,
      },
    ];

    const response = await GET();
    const manifest = await response.json();

    expect(manifest.shortcuts).toEqual([
      expect.objectContaining({
        name: 'Icon Finder',
        url: '/icons',
        icons: [{ src: '/icons/shortcut-icon-finder.svg?v=2', sizes: '96x96', type: 'image/svg+xml' }],
      }),
      expect.objectContaining({
        name: 'My Day',
        url: '/today',
        icons: [{ src: '/icons/shortcut-today.svg?v=2', sizes: '96x96', type: 'image/svg+xml' }],
      }),
    ]);
  });

  it('does not force Icon Finder into an empty configured menu', async () => {
    const response = await GET();
    const manifest = await response.json();

    expect(manifest.shortcuts).toEqual([]);
  });
});
