import type { ConnectorFactory, IConnector } from '../index';
import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
} from '@/types';
import { randomUUID } from 'crypto';

import { createRyMessageClient } from './rymessage-client';
import type { RyMessageClient } from './rymessage-client';
import { normalizeActionRecord, shouldImportAction, mapActionToAlert } from './message-transformer';
import type { RyMessageAction } from './message-transformer';

export type { RyMessageAction } from './message-transformer';

/**
 * RyMessage Action Center Connector
 *
 * Reads AI-extracted actions from RyMessage's Action Center.
 *
 * Integration modes:
 * - **webhook** (preferred): RyMessage pushes events to POST /api/integrations/rymessage.
 * - **rest** (dev/fallback): MC polls RyMessage's local REST API.
 * - **sqlite** (dev/fallback): MC reads RyMessage's SQLite database directly.
 */

interface RyMessageConfig {
  mode: 'webhook' | 'sqlite' | 'rest';
  sqlitePath?: string;
  restUrl?: string;
  apiKey?: string;
  minConfidence: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;

export class RyMessageConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'rymessage';
  readonly displayName = 'RyMessage Action Center';
  readonly icon = '\uD83D\uDCAC';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: false,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: false,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable',
    notificationOnly: true,
  };

  private config: ConnectorConfig | null = null;
  private settings: RyMessageConfig = { mode: 'rest', minConfidence: DEFAULT_MIN_CONFIDENCE };
  private client: RyMessageClient | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
    this.settings = {
      mode: 'webhook',
      minConfidence: DEFAULT_MIN_CONFIDENCE,
      ...(config.settings as unknown as Partial<RyMessageConfig>),
    };
    this.client = createRyMessageClient({
      mode: this.settings.mode,
      restUrl: this.settings.restUrl,
      sqlitePath: this.settings.sqlitePath,
      apiKey: this.settings.apiKey,
    });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      if (this.settings.mode === 'webhook') {
        return { success: true, message: 'Webhook mode: awaiting pushes from RyMessage' };
      }

      if (this.settings.mode === 'rest') {
        const result = await this.client!.testRest();
        if (result.ok) {
          return { success: true, message: 'Connected to RyMessage REST API' };
        }
        return { success: false, message: `HTTP ${result.status}` };
      }

      const result = await this.client!.testSqlite();
      if (result.exists) {
        return { success: true, message: `Database found at ${result.path}` };
      }
      return { success: false, message: 'Database file not found' };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.client = null;
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    return [{
      id: `${this.id}:actions`,
      connectorInstanceId: this.id,
      sourceId: 'action-center',
      name: 'Action Center',
      type: 'folder' as const,
      taskCount: 0,
      lastSyncedAt: new Date().toISOString(),
    }];
  }

  async *fetchTasks(since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    void since;
    yield [];
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    if (this.settings.mode === 'webhook') return [];

    const rawActions = await this.client!.fetchActions(since);
    const actions = rawActions
      .map((record) => normalizeActionRecord(record))
      .filter((action): action is RyMessageAction => action !== null);

    const filtered = since
      ? actions.filter((action) => {
          const actionTime = Date.parse(action.updatedAt ?? action.createdAt);
          return Number.isFinite(actionTime) ? actionTime > since.getTime() : true;
        })
      : actions;

    return filtered
      .filter((action) => shouldImportAction(action, this.settings.minConfidence))
      .map((action) => mapActionToAlert(action, this.type, this.id, randomUUID()));
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  /**
   * "Clear and refresh": re-fetch actions and filter by active lifecycle states.
   * Actions that have transitioned to handled/dismissed/completed won't appear,
   * so their notifications get auto-resolved.
   */
  async getActiveAlertSourceIds(since?: Date): Promise<string[] | null> {
    if (this.settings.mode === 'webhook') return null; // Can't poll in webhook mode

    try {
      const notifications = await this.fetchNotifications(since);
      // fetchNotifications returns notifications with sourceId like "rymessage:{id}"
      return notifications.map((notification) => notification.id);
    } catch {
      return null; // Fail-open
    }
  }
}

export const rymessageFactory: ConnectorFactory = {
  create: () => new RyMessageConnector(),
};

export const ryMessageFactory = rymessageFactory;