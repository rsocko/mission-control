import { NextResponse } from 'next/server';
import {
  getShortcuts,
  getLaunchMode,
  updateSettings,
  DEFAULT_SHORTCUTS,
  MAX_ENABLED_SHORTCUTS,
  SHORTCUT_CONFIG_VERSION,
  type ShortcutConfig,
  type LaunchMode,
} from '@/lib/mode';
import { getShortcutPage } from '@/lib/navigation/shortcut-catalog';

/**
 * GET /api/settings/shortcuts — Get current shortcut configuration
 */
export async function GET() {
  const shortcuts = getShortcuts();
  const launchMode = getLaunchMode();
  return NextResponse.json({ shortcuts, launchMode, defaults: DEFAULT_SHORTCUTS, maxEnabled: MAX_ENABLED_SHORTCUTS });
}

/**
 * PUT /api/settings/shortcuts — Save entire shortcuts configuration
 * Body: { shortcuts: ShortcutConfig[], launchMode?: LaunchMode }
 */
export async function PUT(request: Request) {
  const body = await request.json();
  const { shortcuts, launchMode } = body;

  if (!Array.isArray(shortcuts)) {
    return NextResponse.json({ error: 'shortcuts must be an array' }, { status: 400 });
  }

  const canonicalShortcuts: ShortcutConfig[] = [];
  const seenUrls = new Set<string>();
  for (const s of shortcuts) {
    const page = typeof s?.url === 'string' ? getShortcutPage(s.url) : undefined;
    if (
      !page
      || typeof s.enabled !== 'boolean'
      || (s.openInNewWindow !== undefined && typeof s.openInNewWindow !== 'boolean')
    ) {
      return NextResponse.json({ error: 'Each shortcut must be a supported page with an enabled state' }, { status: 400 });
    }
    if (seenUrls.has(page.url)) {
      return NextResponse.json({ error: `Duplicate shortcut URL: ${page.url}` }, { status: 400 });
    }
    seenUrls.add(page.url);
    canonicalShortcuts.push({
      id: page.id,
      name: page.name,
      url: page.url,
      description: page.description,
      icon: page.icon,
      enabled: s.enabled,
      openInNewWindow: s.openInNewWindow === true,
    });
  }

  // Enforce max enabled shortcuts
  const enabledCount = canonicalShortcuts.filter(s => s.enabled).length;
  if (enabledCount > MAX_ENABLED_SHORTCUTS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_ENABLED_SHORTCUTS} enabled shortcuts allowed. Most browsers ignore extras.` },
      { status: 400 },
    );
  }

  // Validate launchMode if provided
  const validLaunchModes: LaunchMode[] = ['navigate-existing', 'navigate-new'];
  const updates: Parameters<typeof updateSettings>[0] = {
    shortcuts: canonicalShortcuts,
    shortcutConfigVersion: SHORTCUT_CONFIG_VERSION,
  };
  if (launchMode !== undefined) {
    if (!validLaunchModes.includes(launchMode)) {
      return NextResponse.json({ error: `launchMode must be one of: ${validLaunchModes.join(', ')}` }, { status: 400 });
    }
    updates.launchMode = launchMode;
  }

  updateSettings(updates);
  return NextResponse.json({ success: true, shortcuts: canonicalShortcuts, launchMode: launchMode || getLaunchMode() });
}

/**
 * POST /api/settings/shortcuts — Reset shortcuts to defaults
 * Body: { action: "reset" }
 */
export async function POST(request: Request) {
  const body = await request.json();

  if (body.action === 'reset') {
    updateSettings({ shortcuts: DEFAULT_SHORTCUTS, shortcutConfigVersion: SHORTCUT_CONFIG_VERSION });
    return NextResponse.json({ success: true, shortcuts: DEFAULT_SHORTCUTS });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
