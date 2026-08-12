import { NextResponse } from 'next/server';
import { getShortcuts, getLaunchMode, updateSettings, DEFAULT_SHORTCUTS, MAX_ENABLED_SHORTCUTS, type ShortcutConfig, type LaunchMode } from '@/lib/mode';

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

  // Validate each shortcut
  for (const s of shortcuts) {
    if (!s.id || !s.name || !s.url || !s.icon) {
      return NextResponse.json({ error: 'Each shortcut must have id, name, url, and icon' }, { status: 400 });
    }
  }

  // Enforce max enabled shortcuts
  const enabledCount = shortcuts.filter((s: ShortcutConfig) => s.enabled).length;
  if (enabledCount > MAX_ENABLED_SHORTCUTS) {
    return NextResponse.json(
      { error: `Maximum ${MAX_ENABLED_SHORTCUTS} enabled shortcuts allowed. Most browsers ignore extras.` },
      { status: 400 },
    );
  }

  // Validate launchMode if provided
  const validLaunchModes: LaunchMode[] = ['navigate-existing', 'navigate-new'];
  const updates: Record<string, unknown> = { shortcuts: shortcuts as ShortcutConfig[] };
  if (launchMode !== undefined) {
    if (!validLaunchModes.includes(launchMode)) {
      return NextResponse.json({ error: `launchMode must be one of: ${validLaunchModes.join(', ')}` }, { status: 400 });
    }
    updates.launchMode = launchMode;
  }

  updateSettings(updates);
  return NextResponse.json({ success: true, shortcuts, launchMode: launchMode || getLaunchMode() });
}

/**
 * POST /api/settings/shortcuts — Reset shortcuts to defaults
 * Body: { action: "reset" }
 */
export async function POST(request: Request) {
  const body = await request.json();

  if (body.action === 'reset') {
    updateSettings({ shortcuts: DEFAULT_SHORTCUTS });
    return NextResponse.json({ success: true, shortcuts: DEFAULT_SHORTCUTS });
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
}
