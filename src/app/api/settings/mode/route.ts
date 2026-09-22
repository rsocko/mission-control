import { NextResponse } from 'next/server';
import { getAppMode, setAppMode, getSettings, updateSettings, type AppMode } from '@/lib/mode';
import { isPublicDemoMode } from '@/lib/public-demo';
import { resolveRelativeReminderMutation } from '@/lib/tasks/relative-reminder';
import {
  getDemoSeedCommandService,
  getRelativeReminderTimezoneRepository,
} from '@/lib/settings/mode-route-services';

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
 *
 * `resetDemoDatabase`/`clearDatabase`/`clearTriageSampleData` are the
 * narrow, documented seed/demo exception to the L02 web/API PostgreSQL
 * parity migration (see `docs/architecture/persistence-boundaries.md`):
 * there is no PostgreSQL equivalent yet. They are reached exclusively
 * through `getDemoSeedCommandService()` (see
 * `@/lib/settings/mode-route-services`), a backend-neutral registry with no
 * import edge of its own to `@/db`/SQLite, so this module stays fully clean
 * under PostgreSQL. The concrete implementation registered for
 * `MC_DATABASE_BACKEND=postgres` rejects all three commands before any
 * SQLite-side module is evaluated (see `initializeRuntimeDatabase` in
 * `src/db/runtime.ts`).
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
    await getDemoSeedCommandService().resetDemoDatabase();
    updateSettings({ demoSeededAt: new Date().toISOString() });
    return NextResponse.json({ success: true, message: 'Demo data reset successfully' });
  }

  if (action === 'clear-data') {
    await getDemoSeedCommandService().clearDatabase();
    return NextResponse.json({ success: true, message: 'All data cleared' });
  }

  if (action === 'clear-triage-samples') {
    const deleted = await getDemoSeedCommandService().clearTriageSampleData();
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
      await getDemoSeedCommandService().clearDatabase();
    }
  }

  // When switching to demo, replace live data with the canonical demo dataset.
  if (mode === 'demo' && body.seedIfEmpty !== false) {
    const settings = getSettings();
    if (!settings.demoSeededAt) {
      await getDemoSeedCommandService().resetDemoDatabase();
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
    if (typeof updates.timezone === 'string' && updates.timezone !== getSettings().timezone) {
      const timezone = updates.timezone;
      const now = new Date();
      const repository = getRelativeReminderTimezoneRepository();
      const { invalidCount } = await repository.applyTimezoneRecompute({
        now,
        recompute: (task) => resolveRelativeReminderMutation({
          current: task,
          input: { dueDate: task.dueDate },
          timezone,
          now,
        }),
      });
      if (invalidCount > 0) {
        return NextResponse.json({
          error: 'The timezone change would make one or more relative reminders invalid or past',
          code: 'RELATIVE_REMINDER_TIMEZONE_CONFLICT',
          affectedCount: invalidCount,
        }, { status: 409 });
      }
    }
    updateSettings(updates as Partial<{ timezone: string }>);
  }

  const settings = getSettings();
  return NextResponse.json({ success: true, ...settings });
}
