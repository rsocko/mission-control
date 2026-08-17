import { NextResponse } from 'next/server';
import { getAppMode, setAppMode, getSettings, updateSettings, type AppMode } from '@/lib/mode';
import { clearDatabase, resetDemoDatabase } from '@/lib/seed-api';
import { clearTriageSampleData } from '@/lib/triage/lifecycle';
import { isPublicDemoMode } from '@/lib/public-demo';

/**
 * GET /api/settings/mode — Get current app mode and settings
 */
export async function GET() {
  const mode = getAppMode();
  const settings = getSettings();
  return NextResponse.json({ ...settings, mode, publicDemo: isPublicDemoMode() });
}

/**
 * POST /api/settings/mode — Switch between demo and live mode
 * Body: { mode: "demo" | "live" } or { action: "reset-demo" | "clear-data" }
 */
export async function POST(request: Request) {
  if (isPublicDemoMode()) {
    return NextResponse.json(
      { error: 'Demo environment settings are managed by the deployment.' },
      { status: 403 },
    );
  }

  const body = await request.json();
  const { mode, action } = body;

  // Handle special actions
  if (action === 'reset-demo') {
    await resetDemoDatabase();
    updateSettings({ demoSeededAt: new Date().toISOString() });
    return NextResponse.json({ success: true, message: 'Demo data reset successfully' });
  }

  if (action === 'clear-data') {
    await clearDatabase();
    return NextResponse.json({ success: true, message: 'All data cleared' });
  }

  if (action === 'clear-triage-samples') {
    const deleted = await clearTriageSampleData();
    return NextResponse.json({ success: true, message: `Cleared ${deleted} triage sample item(s)` });
  }

  if (!mode || !['demo', 'live'].includes(mode)) {
    return NextResponse.json({ error: 'mode must be "demo" or "live"' }, { status: 400 });
  }

  const previousMode = getAppMode();
  setAppMode(mode as AppMode);

  // When switching to live, optionally clear demo data
  if (previousMode === 'demo' && mode === 'live') {
    if (body.clearDemoData) {
      await clearDatabase();
    }
  }

  // When switching to demo, replace live data with the canonical demo dataset.
  if (mode === 'demo' && body.seedIfEmpty !== false) {
    const settings = getSettings();
    if (!settings.demoSeededAt) {
      await resetDemoDatabase();
      updateSettings({ demoSeededAt: new Date().toISOString() });
    }
  }

  return NextResponse.json({
    success: true,
    mode,
    previousMode,
    message: `Switched to ${mode} mode`,
  });
}

/**
 * PATCH /api/settings/mode — Update individual settings (e.g. timezone)
 * Body: { timezone?: string }
 */
export async function PATCH(request: Request) {
  if (isPublicDemoMode()) {
    return NextResponse.json(
      { error: 'Demo environment settings are managed by the deployment.' },
      { status: 403 },
    );
  }

  const body = await request.json();
  const updates: Record<string, unknown> = {};

  if (body.timezone && typeof body.timezone === 'string') {
    // Validate it's a real IANA timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: body.timezone });
      updates.timezone = body.timezone;
    } catch {
      return NextResponse.json({ error: 'Invalid timezone' }, { status: 400 });
    }
  }

  if (Object.keys(updates).length > 0) {
    updateSettings(updates as Partial<{ timezone: string }>);
  }

  const settings = getSettings();
  return NextResponse.json({ success: true, ...settings });
}
