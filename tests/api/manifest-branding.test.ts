import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/mode', () => ({
  getShortcuts: () => [],
  getLaunchMode: () => 'navigate-existing',
  MAX_ENABLED_SHORTCUTS: 4,
}));

import { GET } from '@/app/api/manifest/route';

describe('PWA manifest branding', () => {
  it('uses app chrome colors and the complete branded icon set', async () => {
    const response = await GET();
    const manifest = await response.json();

    expect(manifest.background_color).toBe('#020617');
    expect(manifest.theme_color).toBe('#0b1120');
    expect(manifest.icons).toEqual([
      { src: '/icon-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-v2-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-v2-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);
  });
});
