/**
 * Quiet-hours and notification gate — determines whether a notification
 * should be suppressed based on user preferences, quiet hours, calendar
 * busy blocks, and do-not-disturb mode.
 *
 * All push notification triggers (#1539-#1541) should pass through
 * `shouldSuppressNotification()` before sending.
 *
 * Refs: #1542
 */
import db from '@/db';
import { pushPreferences, connectorConfigs } from '@/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getTimezone, ianaToWindowsTimezone } from '@/lib/mode';
import logger from '@/lib/logger';
import { isQuietHour } from './quiet-hours-window';

export { isQuietHour } from './quiet-hours-window';

/** Get the current hour (0-23) in the user's configured timezone. */
function getCurrentHourInUserTz(): number {
  const tz = getTimezone();
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour: 'numeric',
    hourCycle: 'h23',
  }).format(new Date());
  return parseInt(formatted, 10);
}

export interface NotificationGateResult {
  suppressed: boolean;
  reason?: 'dnd' | 'quiet_hours' | 'calendar_busy';
}

export interface PushPrefs {
  morningEnabled: boolean;
  morningHour: number;
  triageNudgeEnabled: boolean;
  triageNudgeThreshold: number;
  carryForwardEnabled: boolean;
  carryForwardHour: number;
  quietStart: number | null;
  quietEnd: number | null;
  doNotDisturb: boolean;
}

const DEFAULT_PREFS: PushPrefs = {
  morningEnabled: true,
  morningHour: 8,
  triageNudgeEnabled: true,
  triageNudgeThreshold: 5,
  carryForwardEnabled: true,
  carryForwardHour: 18,
  quietStart: null,
  quietEnd: null,
  doNotDisturb: false,
};

/** Load push notification preferences from DB, falling back to defaults. */
export async function getPreferences(): Promise<PushPrefs> {
  const rows = await db.select().from(pushPreferences).where(eq(pushPreferences.id, 'default')).limit(1);
  if (rows.length === 0) return { ...DEFAULT_PREFS };

  const r = rows[0];
  return {
    morningEnabled: r.morningEnabled,
    morningHour: r.morningHour,
    triageNudgeEnabled: r.triageNudgeEnabled,
    triageNudgeThreshold: r.triageNudgeThreshold,
    carryForwardEnabled: r.carryForwardEnabled,
    carryForwardHour: r.carryForwardHour,
    quietStart: r.quietStart,
    quietEnd: r.quietEnd,
    doNotDisturb: r.doNotDisturb,
  };
}

/**
 * Check if the given hour falls within the quiet-hours window.
 * Handles windows that wrap around midnight (e.g., 22:00–07:00).
 */
/**
 * Check if any calendar connector reports a busy block at the current time.
 * Returns true if the user is currently in a calendar event (busy).
 */
export async function isCalendarBusy(): Promise<boolean> {
  try {
    const calConnectors = await db
      .select()
      .from(connectorConfigs)
      .where(and(eq(connectorConfigs.type, 'outlook-calendar'), isNull(connectorConfigs.deletedAt)));

    const activeConnectors = calConnectors.filter(c => c.enabled);
    if (activeConnectors.length === 0) return false;

    const now = new Date();
    const windowsTz = ianaToWindowsTimezone(getTimezone());

    for (const connector of activeConnectors) {
      const creds = connector.credentials as Record<string, string> | null;
      const token = creds?.accessToken || creds?.access_token;
      if (!token) continue;

      try {
        // Query a narrow 1-minute window around "now" to see if user is in a meeting
        const startISO = now.toISOString();
        const endCheck = new Date(now.getTime() + 60_000);
        const endISO = endCheck.toISOString();

        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startISO}&endDateTime=${endISO}&$top=5&$select=id,isAllDay,isCancelled,showAs`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Prefer: `outlook.timezone="${windowsTz}"`,
            },
            signal: AbortSignal.timeout(5000),
          },
        );

        if (!res.ok) continue;
        const data = await res.json();

        for (const event of data.value || []) {
          if (event.isCancelled) continue;
          if (event.isAllDay) continue;
          // showAs: 'busy', 'tentative', 'oof' (out of office) indicate user is unavailable
          if (event.showAs === 'busy' || event.showAs === 'oof') {
            return true;
          }
        }
      } catch {
        // Skip failed connector — don't block notifications on calendar errors
      }
    }

    return false;
  } catch (err) {
    logger.warn({ err }, 'Failed to check calendar busy status');
    return false;
  }
}

/**
 * Primary notification gate: checks DND, quiet hours, and calendar busy blocks.
 * Call this before sending any push notification.
 *
 * @param prefs  User preferences (pass from getPreferences() to avoid re-fetching)
 * @param options.skipCalendarCheck  If true, skip the calendar busy check (useful for morning/evening where time-based triggers are the main gate)
 */
export async function shouldSuppressNotification(
  prefs: PushPrefs,
  options: { skipCalendarCheck?: boolean } = {},
): Promise<NotificationGateResult> {
  // 1. Do-not-disturb override
  if (prefs.doNotDisturb) {
    return { suppressed: true, reason: 'dnd' };
  }

  // 2. Quiet hours (use configured timezone, not server timezone)
  const currentHour = getCurrentHourInUserTz();
  if (isQuietHour(currentHour, prefs.quietStart, prefs.quietEnd)) {
    return { suppressed: true, reason: 'quiet_hours' };
  }

  // 3. Calendar busy blocks
  if (!options.skipCalendarCheck) {
    const busy = await isCalendarBusy();
    if (busy) {
      return { suppressed: true, reason: 'calendar_busy' };
    }
  }

  return { suppressed: false };
}
