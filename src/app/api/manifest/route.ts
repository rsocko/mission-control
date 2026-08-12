import { NextResponse } from 'next/server';
import { getShortcuts, getLaunchMode, MAX_ENABLED_SHORTCUTS } from '@/lib/mode';
import { APP_DARK_BACKGROUND, APP_DARK_CHROME } from '@/lib/brand';

/**
 * GET /api/manifest — Dynamic Web App Manifest
 * Serves the PWA manifest with user-configured shortcuts.
 */
export async function GET() {
  const shortcuts = getShortcuts();
  const launchMode = getLaunchMode();

  const enabledShortcuts = shortcuts
    .filter(s => s.enabled)
    .slice(0, MAX_ENABLED_SHORTCUTS) // Browsers silently ignore extras; be explicit
    .map(s => {
      const isNewWindow = s.openInNewWindow === true;
      return {
        name: isNewWindow ? `${s.name} ↗` : s.name,
        short_name: s.name,
        url: isNewWindow ? `/new-window?target=${encodeURIComponent(s.url)}` : s.url,
        description: isNewWindow ? `${s.description} (new window)` : s.description,
        icons: [
          { src: `/icons/${s.icon}`, sizes: '96x96', type: 'image/svg+xml' },
        ],
      };
    });

  const manifest = {
    id: '/',
    name: 'Mission Control',
    short_name: 'MissionCtrl',
    description: 'Personal task & notification aggregation system',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: APP_DARK_BACKGROUND,
    theme_color: APP_DARK_CHROME,
    orientation: 'any',
    categories: ['productivity', 'utilities'],
    launch_handler: {
      client_mode: launchMode,
    },
    shortcuts: [
      {
        name: 'Icon Finder',
        short_name: 'Icons',
        url: '/icons',
        description: 'Search and copy icons from multiple sources',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
        ],
      },
      ...enabledShortcuts,
    ],
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };

  return new NextResponse(JSON.stringify(manifest, null, 2), {
    headers: {
      'Content-Type': 'application/manifest+json',
      'Cache-Control': 'no-cache',
    },
  });
}
