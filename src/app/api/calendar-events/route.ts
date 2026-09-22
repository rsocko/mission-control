import { NextResponse } from 'next/server';
import { getTimezone, ianaToWindowsTimezone } from '@/lib/mode';
import { getLocalToday } from '@/lib/utils/date';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

interface CalendarEvent {
  id: string;
  subject: string;
  startTime: string; // HH:MM
  endTime: string;
  duration: number; // minutes
  location?: string;
  isAllDay: boolean;
  source: 'outlook-calendar';
}

/**
 * GET /api/calendar-events?date=YYYY-MM-DD
 * Fetches calendar events for the given date from configured Outlook Calendar connectors.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get('date') || getLocalToday();

  try {
    // Find active outlook-calendar connectors
    const activeConnectors = await (
      await getConnectorManagementPersistence()
    ).listActiveConnectorsByType('outlook-calendar');

    if (activeConnectors.length === 0) {
      return NextResponse.json({ events: [], source: 'none' });
    }

    const allEvents: CalendarEvent[] = [];

    for (const connector of activeConnectors) {
      const creds = connector.credentials as Record<string, string> | null;
      const token = creds?.accessToken || creds?.access_token;
      if (!token) continue;

      try {
        // Use local day boundaries - the Prefer header tells Graph to interpret these in our timezone
        const startOfDay = `${date}T00:00:00`;
        const endOfDay = `${date}T23:59:59`;
        const windowsTz = ianaToWindowsTimezone(getTimezone());

        const res = await fetch(
          `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${startOfDay}&endDateTime=${endOfDay}&$top=50&$orderby=start/dateTime&$select=id,subject,start,end,location,isAllDay,isCancelled`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Prefer: `outlook.timezone="${windowsTz}"`,
            },
            signal: AbortSignal.timeout(10000),
          }
        );

        if (!res.ok) continue;
        const data = await res.json();

        for (const event of data.value || []) {
          if (event.isCancelled) continue;

          // Graph returns times in our configured timezone when Prefer header is set
          const startTimeStr = (event.start?.dateTime || '').slice(11, 16);
          const endTimeStr = (event.end?.dateTime || '').slice(11, 16);
          const startDT = new Date(event.start?.dateTime);
          const endDT = new Date(event.end?.dateTime);
          const duration = Math.round((endDT.getTime() - startDT.getTime()) / 60000);

          allEvents.push({
            id: event.id,
            subject: event.subject || '(No subject)',
            startTime: startTimeStr || '00:00',
            endTime: endTimeStr || '00:00',
            duration,
            location: event.location?.displayName || undefined,
            isAllDay: event.isAllDay || false,
            source: 'outlook-calendar',
          });
        }
      } catch {
        // Skip failed connector
      }
    }

    // Sort by start time
    allEvents.sort((a, b) => a.startTime.localeCompare(b.startTime));

    return NextResponse.json({ events: allEvents, date });
  } catch (error) {
    return ApiErrors.internal('Failed', error);
  }
}
