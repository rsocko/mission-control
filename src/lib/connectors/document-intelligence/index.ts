import type { ConnectorFactory, IConnector } from '../index';
import type {
  InboundNotification,
  ConnectorCapabilities,
  ConnectorConfig,
  SourceList,
  TaskItem,
  TriageItem,
} from '@/types';

import { createDocumentClient } from './document-client';
import type { DocClient, DocHealthResponse, DocStatsResponse } from './document-client';
import {
  isTaskAction,
  isSinceMatch,
  mapActionToTask,
  mapActionToTriageItem,
  mapMissingStatementToNotification,
  mapUnmatchedEobToNotification,
} from './document-parser';
import type { DocAction, MissingStatement, UnmatchedEob } from './document-parser';
import { DOCUMENT_INTELLIGENCE_NOTIFICATION_TYPES } from '@/lib/notifications/push-policy/catalogs';
import { DOCUMENT_INTELLIGENCE_TASK_AUTHORITY } from '../task-source-profiles';

export type { DocAction, MissingStatement, UnmatchedEob } from './document-parser';
export type { DocHealthResponse, DocStatsResponse } from './document-client';
export { buildDocHubUrl, buildDocHubTaskLinks, buildDocHubEobUrl, buildDocHubStatementsUrl } from './doc-hub-links';
export type { DocHubLinkType, DocHubLinkOptions } from './doc-hub-links';

export const DEFAULT_DOCUMENT_INTELLIGENCE_URL = 'http://localhost:8200';

export interface DocIntelligenceConfig {
  baseUrl: string;
  apiKey?: string;
  modules: {
    actionQueue: boolean;
    statements: boolean;
    eobMatching: boolean;
  };
  paperlessBaseUrl?: string;
}

const DEFAULT_MODULES: DocIntelligenceConfig['modules'] = {
  actionQueue: true,
  statements: true,
  eobMatching: true,
};

export function getDocumentIntelligenceBaseUrl(
  settings?: Record<string, unknown> | null
): string {
  const configuredBaseUrl = settings && typeof settings.baseUrl === 'string'
    ? settings.baseUrl.trim()
    : '';

  return (
    configuredBaseUrl ||
    process.env.DOC_INTELLIGENCE_URL ||
    DEFAULT_DOCUMENT_INTELLIGENCE_URL
  ).replace(/\/$/, '');
}

export function getDocumentIntelligenceApiKey(
  credentials?: Record<string, string> | null,
  settings?: Record<string, unknown> | null
): string {
  const credentialKey = credentials?.apiKey || credentials?.api_key || credentials?.token;
  const settingKey = settings && typeof settings.apiKey === 'string'
    ? settings.apiKey.trim()
    : '';

  return credentialKey || settingKey || process.env.DOC_INTELLIGENCE_API_KEY || '';
}

export class DocumentIntelligenceConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'document-intelligence';
  readonly displayName = 'OWL';
  readonly icon = '🦉';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: true,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable',
    ...DOCUMENT_INTELLIGENCE_TASK_AUTHORITY,
  };

  private config: ConnectorConfig | null = null;
  private settings: DocIntelligenceConfig = {
    baseUrl: DEFAULT_DOCUMENT_INTELLIGENCE_URL,
    modules: DEFAULT_MODULES,
  };
  private client: DocClient | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;

    const rawSettings = (config.settings || {}) as Record<string, unknown>;
    this.settings = {
      baseUrl: getDocumentIntelligenceBaseUrl(rawSettings),
      apiKey: getDocumentIntelligenceApiKey(config.credentials, rawSettings) || undefined,
      modules: {
        ...DEFAULT_MODULES,
        ...((rawSettings.modules as Partial<DocIntelligenceConfig['modules']> | undefined) || {}),
      },
      paperlessBaseUrl:
        typeof rawSettings.paperlessBaseUrl === 'string' && rawSettings.paperlessBaseUrl.trim()
          ? rawSettings.paperlessBaseUrl.trim().replace(/\/$/, '')
          : process.env.PAPERLESS_BASE_URL?.replace(/\/$/, ''),
    };

    this.client = createDocumentClient({
      baseUrl: this.settings.baseUrl,
      apiKey: this.settings.apiKey || '',
    });
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const checks: Array<Promise<unknown>> = [];

      if (this.settings.modules.actionQueue) {
        checks.push(this.client!.fetchJson<DocAction[]>('/api/action-queue/actions', { status: 'pending' }));
      }
      if (this.settings.modules.statements) {
        checks.push(this.client!.fetchJson<MissingStatement[]>('/api/statements/missing'));
      }
      if (this.settings.modules.eobMatching) {
        checks.push(this.client!.fetchJson<UnmatchedEob[]>('/api/eob/unmatched'));
      }

      if (checks.length === 0) {
        return { success: false, message: 'No OWL modules enabled' };
      }

      await checks[0];
      return { success: true, message: 'Connected to OWL for Paperless-ngx' };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {
    this.config = null;
    this.client = null;
  }

  async *fetchTasks(since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    if (!this.settings.modules.actionQueue) {
      yield [];
      return;
    }

    const actions = await this.client!.fetchJson<DocAction[]>('/api/action-queue/actions', {
      status: 'pending',
    });

    yield actions
      .filter((action) => isTaskAction(action))
      .filter((action) => isSinceMatch(action.created_at, since))
      .map((action) => mapActionToTask(action, this.type, this.id, this.settings.baseUrl));
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    const notifications: InboundNotification[] = [];

    if (this.settings.modules.statements) {
      const missing = await this.client!.fetchJson<MissingStatement[]>('/api/statements/missing');
      for (const stmt of missing) {
        const receivedAt = new Date().toISOString();
        if (!isSinceMatch(receivedAt, since)) {
          continue;
        }
        notifications.push(mapMissingStatementToNotification(stmt, this.type, this.id, this.settings.paperlessBaseUrl, this.settings.baseUrl));
      }
    }

    if (this.settings.modules.eobMatching) {
      const unmatched = await this.client!.fetchJson<UnmatchedEob[]>('/api/eob/unmatched');
      for (const eob of unmatched) {
        const receivedAt = eob.created_at || new Date().toISOString();
        if (!isSinceMatch(receivedAt, since)) {
          continue;
        }
        notifications.push(mapUnmatchedEobToNotification(eob, this.type, this.id, this.settings.baseUrl));
      }
    }

    return notifications;
  }

  async fetchTriageItems(since?: Date): Promise<TriageItem[]> {
    if (!this.settings.modules.actionQueue) {
      return [];
    }

    const actions = await this.client!.fetchJson<DocAction[]>('/api/action-queue/actions', {
      status: 'pending',
    });

    return actions
      .filter((action) => isTaskAction(action))
      .filter((action) => isSinceMatch(action.created_at, since))
      .map((action) => mapActionToTriageItem(action, this.type, this.id, this.settings.paperlessBaseUrl, this.settings.baseUrl));
  }

  async completeTask(sourceId: string): Promise<void> {
    await this.client!.patchActionStatus(sourceId, 'done');
  }

  async reopenTask(sourceId: string): Promise<void> {
    await this.client!.patchActionStatus(sourceId, 'pending');
  }

  async dismissAlert(sourceId: string): Promise<void> {
    // Alert sourceIds are prefixed: "stmt-{id}" for statements, "eob-{id}" for EOBs.
    // Statement alerts have no dismiss endpoint; EOB/action alerts use patchActionStatus.
    if (sourceId.startsWith('eob-') || sourceId.startsWith('action-')) {
      const rawId = sourceId.replace(/^(eob-|action-)/, '');
      await this.client!.patchActionStatus(rawId, 'dismissed');
    }
    // Statement alerts ("stmt-*") are informational — no writeback needed
  }

  async updateTask(sourceId: string, updates: Partial<TaskItem>): Promise<TaskItem> {
    if (updates.status === 'done') {
      await this.client!.patchActionStatus(sourceId, 'done');
    } else if (updates.status === 'cancelled') {
      await this.client!.patchActionStatus(sourceId, 'dismissed');
    } else if (updates.status === 'todo' || updates.status === 'in_progress') {
      await this.client!.patchActionStatus(sourceId, 'pending');
    }

    return {
      id: `docintel-${sourceId}`,
      sourceId,
      connectorType: this.type,
      connectorInstanceId: this.id,
      title: updates.title || 'OWL task',
      description: updates.description,
      status: updates.status || 'todo',
      priority: updates.priority || 'none',
      dueDate: updates.dueDate,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      sourceListId: 'action-queue',
      sourceListName: 'Action Queue',
      hubProjectIds: [],
      tags: [],
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: new Date().toISOString(),
    };
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    const now = new Date().toISOString();
    const lists: SourceList[] = [];

    if (this.settings.modules.actionQueue) {
      lists.push({
        id: `${this.id}:action-queue`,
        connectorInstanceId: this.id,
        sourceId: 'action-queue',
        name: 'Action Queue',
        type: 'list',
        taskCount: 0,
        lastSyncedAt: now,
      });
    }

    if (this.settings.modules.statements) {
      lists.push({
        id: `${this.id}:statements`,
        connectorInstanceId: this.id,
        sourceId: 'statements',
        name: 'Statement Tracking',
        type: 'list',
        taskCount: 0,
        lastSyncedAt: now,
      });
    }

    if (this.settings.modules.eobMatching) {
      lists.push({
        id: `${this.id}:eob-matching`,
        connectorInstanceId: this.id,
        sourceId: 'eob-matching',
        name: 'EOB Matching',
        type: 'list',
        taskCount: 0,
        lastSyncedAt: now,
      });
    }

    return lists;
  }

  async fetchSourceTags(): Promise<{ id: string; name: string; color?: string }[]> {
    return [
      { id: 'docintel:action-queue', name: 'Action Queue', color: '#3b82f6' },
      { id: 'docintel:statements', name: 'Statement Tracking', color: '#8b5cf6' },
      { id: 'docintel:eob-matching', name: 'EOB Matching', color: '#ec4899' },
      { id: 'docintel:pay', name: 'Pay', color: '#ef4444' },
      { id: 'docintel:respond', name: 'Respond', color: '#f97316' },
      { id: 'docintel:sign', name: 'Sign', color: '#eab308' },
      { id: 'docintel:schedule', name: 'Schedule', color: '#22c55e' },
      { id: 'docintel:file', name: 'File', color: '#06b6d4' },
      { id: 'docintel:review', name: 'Review', color: '#6366f1' },
    ];
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  /**
   * "Clear and refresh": re-fetch current missing statements and unmatched EOBs.
   * If a document has been matched/uploaded since last sync, it won't appear
   * and the corresponding notification gets auto-resolved.
   */
  async getActiveAlertSourceIds(since?: Date): Promise<string[] | null> {
    try {
      const notifications = await this.fetchNotifications(since);
      return notifications.map((notification) => notification.id);
    } catch {
      return null; // Fail-open
    }
  }

  /** Module-level health check — used by the health API and test endpoint */
  async getModuleHealth(): Promise<{
    overall: 'healthy' | 'degraded' | 'unhealthy';
    modules: Array<{ name: string; enabled: boolean; status: string; detail?: string }>;
    stats?: DocStatsResponse;
    latencyMs: number;
  }> {
    const start = Date.now();
    const modules: Array<{ name: string; enabled: boolean; status: string; detail?: string }> = [];

    let overallHealthy = true;
    let healthResponse: DocHealthResponse | null = null;
    let statsResponse: DocStatsResponse | null = null;

    // Check /health endpoint
    try {
      healthResponse = await this.client!.fetchHealth();
    } catch (err) {
      return {
        overall: 'unhealthy',
        modules: [{ name: 'Hub', enabled: true, status: 'unreachable', detail: String(err) }],
        latencyMs: Date.now() - start,
      };
    }

    // Fetch stats (non-fatal)
    try {
      statsResponse = await this.client!.fetchStats();
    } catch {
      // Stats are optional
    }

    // Check each module
    const moduleChecks: Array<{ key: keyof DocIntelligenceConfig['modules']; name: string; testFn: () => Promise<string> }> = [
      {
        key: 'actionQueue',
        name: 'Action Queue',
        testFn: async () => {
          const actions = await this.client!.fetchJson<DocAction[]>('/api/action-queue/actions', { status: 'pending' });
          return `${actions.length} pending actions`;
        },
      },
      {
        key: 'statements',
        name: 'Statement Tracking',
        testFn: async () => {
          const missing = await this.client!.fetchJson<MissingStatement[]>('/api/statements/missing');
          return `${missing.length} missing statements`;
        },
      },
      {
        key: 'eobMatching',
        name: 'EOB Matching',
        testFn: async () => {
          const unmatched = await this.client!.fetchJson<UnmatchedEob[]>('/api/eob/unmatched');
          return `${unmatched.length} unmatched EOBs`;
        },
      },
    ];

    for (const check of moduleChecks) {
      const enabled = this.settings.modules[check.key];
      if (!enabled) {
        modules.push({ name: check.name, enabled: false, status: 'disabled' });
        continue;
      }
      try {
        const detail = await check.testFn();
        modules.push({ name: check.name, enabled: true, status: 'healthy', detail });
      } catch (err) {
        overallHealthy = false;
        modules.push({ name: check.name, enabled: true, status: 'error', detail: err instanceof Error ? err.message : String(err) });
      }
    }

    return {
      overall: overallHealthy ? (healthResponse?.status || 'healthy') : 'degraded',
      modules,
      stats: statsResponse || undefined,
      latencyMs: Date.now() - start,
    };
  }
}

export const documentIntelligenceFactory: ConnectorFactory = {
  create: () => new DocumentIntelligenceConnector(),
  notificationTypes: DOCUMENT_INTELLIGENCE_NOTIFICATION_TYPES,
};