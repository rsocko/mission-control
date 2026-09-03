import type { IConnector } from '../index';
import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  SyncResult,
} from '@/types';
import { randomUUID } from 'crypto';
import { getTimezone, ianaToWindowsTimezone } from '@/lib/mode';
import { createGraphClient, type GraphClient } from '../microsoft-todo/graph-client';

/**
 * Outlook Calendar Connector
 * 
 * Generates time-based alerts for upcoming calendar events.
 * Helps the user see "what's next" without checking Outlook separately.
 * 
 * Auth: OAuth2 via Azure AD (shared with MS Todo / Email)
 * API: https://graph.microsoft.com/v1.0/me/calendarView
 * Permissions: Calendars.Read (delegated)
 */

interface OutlookCalendarConfig {
  accessToken?: string;
  refreshToken?: string;
  lookaheadHours: number; // surface events within N hours
  includeAllDay: boolean;
  alertBeforeMinutes: number; // generate alert N minutes before event
}

export class OutlookCalendarConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'outlook-calendar';
  readonly displayName = 'Outlook Calendar';
  readonly icon = '📅';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: false,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: false,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable', // read-only connector
    notificationOnly: true,
  };

  private config: ConnectorConfig | null = null;
  private hasCredentials: boolean = false;
  private client: GraphClient | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    const creds = config.credentials as unknown as OutlookCalendarConfig;
    this.hasCredentials = !!creds.accessToken;
    this.client = createGraphClient(this.id);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.hasCredentials) {
      return { success: false, message: 'No access token configured' };
    }
    try {
      const res = await this.graphFetch('/me/calendars');
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: `Connected — ${data.value?.length || 0} calendars found` };
      }
      return { success: false, message: `HTTP ${res.status}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.hasCredentials = false;
    this.client = null;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    const res = await this.graphFetch('/me/calendars');
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'Outlook Calendar token expired or invalid — re-authenticate in Settings'
          : `Outlook Calendar lookup failed: HTTP ${res.status}`
      );
    }
    const data = await res.json();

    return (data.value || []).map((cal: { id: string; name: string }) => ({
      id: `${this.id}:${cal.id}`,
      connectorInstanceId: this.id,
      sourceId: cal.id,
      name: cal.name,
      type: 'folder' as const,
      taskCount: 0,
      lastSyncedAt: new Date().toISOString(),
    }));
  }

  async *fetchTasks(_since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    // Calendar connector doesn't produce tasks, only alerts
    yield [];
  }

  async fetchNotifications(_since?: Date): Promise<InboundNotification[]> {
    const settings = (this.config?.settings || {}) as unknown as OutlookCalendarConfig;
    const lookaheadHours = settings.lookaheadHours || 24;
    const includeAllDay = settings.includeAllDay !== false;

    const now = new Date();
    const end = new Date(now.getTime() + lookaheadHours * 3600000);

    const url = `/me/calendarView?startDateTime=${now.toISOString()}&endDateTime=${end.toISOString()}&$top=50&$orderby=start/dateTime&$select=id,subject,start,end,location,organizer,isAllDay,webLink,importance,isCancelled`;

    const res = await this.graphFetch(url);
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'Outlook Calendar token expired or invalid — re-authenticate in Settings'
          : `Outlook Calendar event fetch failed: HTTP ${res.status}`
      );
    }
    const data = await res.json();

    const notifications: InboundNotification[] = [];

    for (const event of data.value || []) {
      if (event.isCancelled) continue;
      if (!includeAllDay && event.isAllDay) continue;

      const startTime = new Date(event.start?.dateTime + 'Z');
      const minutesUntil = Math.round((startTime.getTime() - now.getTime()) / 60000);

      // Determine level based on time proximity
      let level: InboundNotification['level'] = 'digest';
      if (minutesUntil <= 5) level = 'urgent';
      else if (minutesUntil <= 15) level = 'action_needed';
      else if (minutesUntil <= 60) level = 'heads_up';
      else level = 'fyi';

      const locationStr = event.location?.displayName ? ` — ${event.location.displayName}` : '';
      const timeStr = event.isAllDay
        ? 'All day'
        : startTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

      notifications.push({
        id: randomUUID(),
        sourceId: `cal:${event.id}`,
        connectorType: this.type,
        connectorInstanceId: this.id,
        title: `${event.subject || '(No title)'} — ${timeStr}`,
        body: `${event.organizer?.emailAddress?.name || 'Unknown organizer'}${locationStr}`,
        level,
        category: 'calendar',
        isRead: false,
        isActionable: !!event.webLink,
        actionUrl: event.webLink || undefined,
        receivedAt: now.toISOString(),
        expiresAt: new Date(event.end?.dateTime + 'Z').toISOString(),
        relatedTaskId: undefined,
        hubProjectIds: [],
        tags: [],
        metadata: {
          eventId: event.id,
          startTime: event.start?.dateTime,
          endTime: event.end?.dateTime,
          isAllDay: event.isAllDay,
          minutesUntil,
        },
      });
    }

    return notifications;
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async graphFetch(path: string, options?: RequestInit): Promise<Response> {
    if (!this.client) {
      throw new Error('Outlook Calendar connector not initialized');
    }
    const windowsTz = ianaToWindowsTimezone(getTimezone());
    return this.client.graphFetch(path, {
      ...options,
      headers: {
        Prefer: `outlook.timezone="${windowsTz}"`,
        ...(options?.headers || {}),
      },
    });
  }
}

export const outlookCalendarFactory = {
  create: () => new OutlookCalendarConnector(),
};
