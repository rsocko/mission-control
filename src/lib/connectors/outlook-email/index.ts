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
import { connectorRegistry } from '../index';
import { createGraphClient, type GraphClient } from '../microsoft-todo/graph-client';

/**
 * Outlook Email Connector
 * 
 * Surfaces flagged/important emails as alerts. Action-required emails become
 * high-severity actionable alerts with a direct link to the message.
 * 
 * Auth: OAuth2 via Azure AD (shared with MS Todo connector if same tenant)
 * API: https://graph.microsoft.com/v1.0/me/mailFolders/{folderId}/messages
 * Permissions: Mail.Read (delegated)
 */

interface OutlookEmailConfig {
  accessToken?: string;
  refreshToken?: string;
  filterMode: 'flagged' | 'important' | 'both'; // which emails become alerts
  maxAgeHours: number; // only surface emails received within N hours
}

export class OutlookEmailConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'outlook-email';
  readonly displayName = 'Outlook Email';
  readonly icon = '📧';
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
    const creds = config.credentials as unknown as OutlookEmailConfig;
    this.hasCredentials = !!creds.accessToken;
    this.client = createGraphClient(this.id);
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.hasCredentials) {
      return { success: false, message: 'No access token configured' };
    }
    try {
      const res = await this.graphFetch('/me/mailFolders/inbox');
      if (res.ok) {
        const data = await res.json();
        return { success: true, message: `Connected — Inbox has ${data.totalItemCount} messages` };
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
    const res = await this.graphFetch('/me/mailFolders?$top=20');
    if (!res.ok) {
      throw new Error(
        res.status === 401
          ? 'Outlook Email token expired or invalid — re-authenticate in Settings'
          : `Outlook Email folder lookup failed: HTTP ${res.status}`
      );
    }
    const data = await res.json();

    return (data.value || []).map((folder: { id: string; displayName: string; totalItemCount: number }) => ({
      id: `${this.id}:${folder.id}`,
      connectorInstanceId: this.id,
      sourceId: folder.id,
      name: folder.displayName,
      type: 'folder' as const,
      taskCount: folder.totalItemCount,
      lastSyncedAt: new Date().toISOString(),
    }));
  }

  async *fetchTasks(_since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    // Email connector doesn't produce tasks, only alerts
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    const settings = (this.config?.settings || {}) as unknown as OutlookEmailConfig;
    let filterMode = settings.filterMode || 'both';
    const maxAgeHours = settings.maxAgeHours || 72;
    // An empty selection is intentionally Inbox-only; additional folders are opt-in.
    const configuredFolderIds = this.config?.syncedLists
      .map(folderId => folderId.startsWith(`${this.id}:`) ? folderId.slice(this.id.length + 1) : folderId)
      .filter(Boolean) || [];
    const folderIds = [...new Set(configuredFolderIds.length > 0 ? configuredFolderIds : ['inbox'])];

    // When Microsoft Todo connector is active, it owns flagged emails as full tasks.
    // Avoid duplicating them as alerts here — only surface importance-based alerts.
    const todoConnectorActive = connectorRegistry.getAllConnectors()
      .some(c => c.type === 'microsoft-todo');
    if (todoConnectorActive && filterMode === 'both') {
      filterMode = 'important';
    } else if (todoConnectorActive && filterMode === 'flagged') {
      // Todo already handles flagged emails — nothing for us to surface
      return [];
    }

    const sinceDate = since || new Date(Date.now() - maxAgeHours * 3600000);
    const notifications: InboundNotification[] = [];

    // Build filter query
    const filters: string[] = [];
    filters.push(`receivedDateTime ge ${sinceDate.toISOString()}`);

    if (filterMode === 'flagged') {
      filters.push("flag/flagStatus eq 'flagged'");
    } else if (filterMode === 'important') {
      filters.push("importance eq 'high'");
    } else {
      // both: flagged OR important
      filters.push("(flag/flagStatus eq 'flagged' or importance eq 'high')");
    }

    const filter = filters.join(' and ');
    const query = `$filter=${encodeURIComponent(filter)}&$top=50&$orderby=receivedDateTime desc&$select=id,subject,bodyPreview,from,receivedDateTime,importance,flag,webLink,isRead`;

    for (const folderId of folderIds) {
      const url = `/me/mailFolders/${encodeURIComponent(folderId)}/messages?${query}`;
      const res = await this.graphFetch(url);
      if (!res.ok) {
        throw new Error(
          res.status === 401
            ? 'Outlook Email token expired or invalid — re-authenticate in Settings'
            : `Outlook Email message fetch failed for folder ${folderId}: HTTP ${res.status}`
        );
      }
      const data = await res.json();

      for (const msg of data.value || []) {
        const isFlagged = msg.flag?.flagStatus === 'flagged';
        const isImportant = msg.importance === 'high';

        notifications.push({
          id: randomUUID(),
          sourceId: `email:${msg.id}`,
          connectorType: this.type,
          connectorInstanceId: this.id,
          title: msg.subject || '(No subject)',
          body: msg.from?.emailAddress
            ? `From: ${msg.from.emailAddress.name || msg.from.emailAddress.address} — ${msg.bodyPreview?.slice(0, 120) || ''}`
            : msg.bodyPreview?.slice(0, 150) || undefined,
          level: isImportant ? 'action_needed' : isFlagged ? 'heads_up' : 'fyi',
          category: 'email',
          isRead: msg.isRead || false,
          isActionable: true,
          actionUrl: msg.webLink || undefined,
          receivedAt: msg.receivedDateTime,
          expiresAt: undefined,
          relatedTaskId: undefined,
          hubProjectIds: [],
          tags: [],
          metadata: {
            messageId: msg.id,
            from: msg.from?.emailAddress?.address,
            isFlagged,
            isImportant,
          },
        });
      }
    }

    return notifications;
  }

  async getLastSyncToken(): Promise<string | null> {
    return null; // Could implement delta queries later
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async graphFetch(path: string, options?: RequestInit): Promise<Response> {
    if (!this.client) {
      throw new Error('Outlook Email connector not initialized');
    }
    return this.client.graphFetch(path, options);
  }
}

export const outlookEmailFactory = {
  create: () => new OutlookEmailConnector(),
};
