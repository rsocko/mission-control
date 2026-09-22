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
import { getTimezone, ianaToWindowsTimezone } from '@/lib/mode';
import logger from '@/lib/logger';
import { getNotificationPushPersistence } from '@/lib/push/notification-push-service';
import { isQuietHour } from './quiet-hours-window';
import {
  DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
  type NotificationPushPreferences,
} from '@/db/persistence/notification-push';

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

export type PushPrefs = NotificationPushPreferences;

export const DEFAULT_PREFS: PushPrefs = {
  ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
};

/** Load push notification preferences from DB, falling back to defaults. */
export async function getPreferences(): Promise<PushPrefs> {
  return (await getNotificationPushPersistence()).getPreferences();
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
    const accessTokens = await (
      await getNotificationPushPersistence()
    ).listActiveCalendarAccessTokens();
    if (accessTokens.length === 0) return false;

    const now = new Date();
    const windowsTz = ianaToWindowsTimezone(getTimezone());

    for (const token of accessTokens) {
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
