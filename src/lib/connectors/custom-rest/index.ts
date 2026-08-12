import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  SyncResult,
} from '@/types';
import type { ConnectorFactory, IConnector } from '../index';
import { resolveConnectorCapabilities } from '../task-source-profiles';
import {
  extractNotificationTemplateKey,
  parseLocalNotificationTypeCatalog,
  type ConnectorNotificationTypeDefinition,
} from '@/lib/notifications/push-policy/catalog';

/**
 * Custom REST Connector
 * 
 * A generic connector that can talk to any REST API that returns tasks/alerts
 * in a configurable JSON format. Users configure:
 * 
 * - baseUrl: The API base URL
 * - tasksEndpoint: Path to GET tasks (default: /tasks)
 * - alertsEndpoint: Path to GET alerts (default: /alerts)
 * - headers: Custom headers (auth tokens, etc.)
 * - mapping: Field mapping from source fields to Mission Control fields
 * 
 * Example config.settings:
 * {
 *   baseUrl: "https://myapi.example.com/v1",
 *   tasksEndpoint: "/tasks",
 *   alertsEndpoint: "/alerts",
 *   headers: { "Authorization": "Bearer xxx" },
 *   taskMapping: {
 *     id: "id",
 *     title: "name",
 *     description: "notes",
 *     status: "state",           // source field → we map values
 *     priority: "urgency",
 *     dueDate: "deadline",
 *     createdAt: "created_at"
 *   },
 *   statusMap: { "open": "todo", "active": "in_progress", "closed": "done" },
 *   priorityMap: { "P1": "critical", "P2": "high", "P3": "medium", "P4": "low" },
 *   listField: "project",        // Which field indicates the list/group
 *   createEndpoint: "POST /tasks",
 *   updateEndpoint: "PUT /tasks/:id",
 *   deleteEndpoint: "DELETE /tasks/:id"
 * }
 */

interface CustomRestSettings {
  baseUrl: string;
  tasksEndpoint: string;
  alertsEndpoint?: string;
  headers: Record<string, string>;
  taskMapping: Record<string, string>;
  statusMap?: Record<string, string>;
  priorityMap?: Record<string, string>;
  listField?: string;
  createEndpoint?: string;
  updateEndpoint?: string;
  deleteEndpoint?: string;
  responseTasksPath?: string; // JSONPath-like: "data.items" or "tasks"
  notificationTemplateKeyField?: string;
  notificationTypeCatalog?: readonly ConnectorNotificationTypeDefinition[];
}

export class CustomRestConnector implements IConnector {
  readonly id: string = '';
  readonly type = 'custom-rest';
  readonly displayName = 'Custom REST API';
  readonly icon = '🔌';
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: false,
    delete: false,
    sync: true,
    lists: false,
    subtasks: false,
    tags: false,
    tagWriteBack: false,
    listSelectionMode: 'not-applicable',
  };

  private config!: ConnectorConfig;
  private settings!: CustomRestSettings;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    this.settings = config.settings as unknown as CustomRestSettings;
    (this as { id: string }).id = config.id;

    Object.assign(
      this.capabilities,
      resolveConnectorCapabilities(this.type, this.capabilities, config.settings),
    );
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const res = await fetch(`${this.settings.baseUrl}${this.settings.tasksEndpoint}`, {
        headers: this.settings.headers,
      });
      if (res.ok) {
        return { success: true, message: `Connected (${res.status})` };
      }
      return { success: false, message: `HTTP ${res.status}: ${res.statusText}` };
    } catch (err) {
      return { success: false, message: `Connection failed: ${err}` };
    }
  }

  async dispose(): Promise<void> {}

  async *fetchTasks(since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    const url = new URL(`${this.settings.baseUrl}${this.settings.tasksEndpoint}`);
    if (since) {
      url.searchParams.set('since', since.toISOString());
    }

    const res = await fetch(url.toString(), { headers: this.settings.headers });
    if (!res.ok) throw new Error(`Failed to fetch tasks: ${res.status}`);

    const data = await res.json();

    // Navigate to the tasks array using responsePath
    let items = data;
    if (this.settings.responseTasksPath) {
      for (const key of this.settings.responseTasksPath.split('.')) {
        items = items?.[key];
      }
    }
    if (!Array.isArray(items)) items = [];

    const mapping = this.settings.taskMapping;
    const statusMap = this.settings.statusMap || {};
    const priorityMap = this.settings.priorityMap || {};

    yield items.map((item: Record<string, unknown>) => {
      const rawStatus = String(item[mapping.status || 'status'] || 'todo');
      const rawPriority = String(item[mapping.priority || 'priority'] || 'none');

      return {
        id: String(item[mapping.id || 'id']),
        sourceId: String(item[mapping.id || 'id']),
        connectorType: this.type,
        connectorInstanceId: this.config.id,
        title: String(item[mapping.title || 'title'] || 'Untitled'),
        description: item[mapping.description || 'description'] as string | undefined,
        status: statusMap[rawStatus] || rawStatus,
        priority: priorityMap[rawPriority] || rawPriority,
        dueDate: item[mapping.dueDate || 'dueDate'] as string | undefined,
        createdAt: String(item[mapping.createdAt || 'createdAt'] || new Date().toISOString()),
        updatedAt: String(item[mapping.updatedAt || 'updatedAt'] || new Date().toISOString()),
        sourceListName: this.settings.listField ? String(item[this.settings.listField] || '') : undefined,
        depth: 0,
        isChecklistItem: false,
      } as TaskItem;
    });
  }

  async fetchNotifications(since?: Date): Promise<InboundNotification[]> {
    if (!this.settings.alertsEndpoint) return [];

    const url = new URL(`${this.settings.baseUrl}${this.settings.alertsEndpoint}`);
    if (since) url.searchParams.set('since', since.toISOString());

    const res = await fetch(url.toString(), { headers: this.settings.headers });
    if (!res.ok) return [];

    const data = await res.json();
    const items = Array.isArray(data) ? data : data.alerts || data.items || [];

    return items.map((item: Record<string, unknown>) => ({
      id: String(item.id || crypto.randomUUID()),
      sourceId: String(item.id || ''),
      connectorType: this.type,
      connectorInstanceId: this.config.id,
      title: String(item.title || item.message || 'Alert'),
      body: item.body as string | undefined,
      level: String(item.severity || item.level || 'digest'),
      category: String(item.category || item.type || 'general'),
      templateKey: extractNotificationTemplateKey(
        item,
        this.settings.notificationTemplateKeyField,
      ),
      isRead: Boolean(item.read || item.isRead),
      isActionable: Boolean(item.actionUrl || item.action_url),
      actionUrl: (item.actionUrl || item.action_url) as string | undefined,
      receivedAt: String(item.receivedAt || item.created_at || new Date().toISOString()),
    } as InboundNotification));
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    // Custom REST connectors typically don't have enumerable lists
    return [{
      id: 'default',
      sourceId: 'default',
      connectorInstanceId: this.config.id,
      name: this.settings.baseUrl,
      type: 'list',
      taskCount: 0,
      lastSyncedAt: new Date().toISOString(),
    }];
  }

  async createTask(task: Partial<TaskItem>): Promise<TaskItem> {
    if (!this.settings.createEndpoint) {
      throw new Error('Create not supported — no createEndpoint configured');
    }

    const { method, path } = parseConfiguredEndpoint(
      this.settings.createEndpoint,
      'POST',
    );
    const url = `${this.settings.baseUrl}${path}`;

    // Reverse-map fields
    const mapping = this.settings.taskMapping;
    const body: Record<string, unknown> = {};
    if (mapping.title) body[mapping.title] = task.title;
    if (mapping.description && task.description) body[mapping.description] = task.description;
    if (mapping.priority && task.priority) body[mapping.priority] = task.priority;
    if (mapping.dueDate && task.dueDate) body[mapping.dueDate] = task.dueDate;

    const res = await fetch(url, {
      method: method || 'POST',
      headers: { ...this.settings.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) throw new Error(`Create failed: ${res.status}`);
    const created = await res.json();
    const sourceId = String(created[this.settings.taskMapping.id || 'id'] ?? '').trim();
    if (!sourceId) {
      throw new Error('Create failed: response did not include the configured task ID');
    }

    return {
      id: sourceId,
      sourceId,
      connectorType: this.type,
      connectorInstanceId: this.config.id,
      title: task.title || 'Untitled',
      status: 'todo',
      priority: task.priority || 'none',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      depth: 0,
      isChecklistItem: false,
    } as TaskItem;
  }

  async updateTask(sourceId: string, updates: Partial<TaskItem>): Promise<TaskItem> {
    if (!this.settings.updateEndpoint) {
      throw new Error('Update not supported - no updateEndpoint configured');
    }

    const { method, path } = parseConfiguredEndpoint(
      this.settings.updateEndpoint,
      'PUT',
      sourceId,
    );
    const mapping = this.settings.taskMapping;
    const body: Record<string, unknown> = {};
    const assign = (field: keyof TaskItem, value: unknown) => {
      if (value !== undefined) body[mapping[field] || field] = value;
    };
    assign('title', updates.title);
    assign('description', updates.description);
    assign('status', reverseMap(this.settings.statusMap, updates.status));
    assign('statusReason', updates.statusReason);
    assign('priority', reverseMap(this.settings.priorityMap, updates.priority));
    assign('dueDate', updates.dueDate);

    const res = await fetch(`${this.settings.baseUrl}${path}`, {
      method,
      headers: { ...this.settings.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Update failed: ${res.status}`);

    const now = new Date().toISOString();
    return {
      id: sourceId,
      sourceId,
      connectorType: this.type,
      connectorInstanceId: this.config.id,
      title: updates.title || 'Updated task',
      description: updates.description || undefined,
      status: updates.status || 'todo',
      priority: updates.priority || 'none',
      dueDate: updates.dueDate || undefined,
      createdAt: now,
      updatedAt: now,
      childIds: [],
      depth: 0,
      isChecklistItem: false,
      hubProjectIds: [],
      tags: [],
      metadata: {},
      syncStatus: 'synced',
      lastSyncedAt: now,
    };
  }

  async deleteTask(sourceId: string): Promise<void> {
    if (!this.settings.deleteEndpoint) {
      throw new Error('Delete not supported - no deleteEndpoint configured');
    }
    const { method, path } = parseConfiguredEndpoint(
      this.settings.deleteEndpoint,
      'DELETE',
      sourceId,
    );
    const res = await fetch(`${this.settings.baseUrl}${path}`, {
      method,
      headers: this.settings.headers,
    });
    if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }

  async handleWebhook(): Promise<SyncResult> {
    // Re-fetch all tasks on webhook
    let taskCount = 0;
    for await (const page of this.fetchTasks()) {
      taskCount += page.length;
    }
    return {
      connectorId: this.config.id,
      success: true,
      tasksAdded: taskCount,
      tasksUpdated: 0,
      tasksRemoved: 0,
      notificationsAdded: 0,
      errors: [],
      syncedAt: new Date().toISOString(),
    };
  }
}

export const customRestFactory: ConnectorFactory = {
  create: () => new CustomRestConnector(),
  getNotificationTypes: config => parseLocalNotificationTypeCatalog('custom-rest', config.settings),
};

function reverseMap<T extends string>(
  mapping: Record<string, string> | undefined,
  value: T | undefined,
): T | string | undefined {
  if (value === undefined || !mapping) return value;
  return Object.entries(mapping).find(([, mapped]) => mapped === value)?.[0] ?? value;
}

function parseConfiguredEndpoint(
  endpoint: string,
  defaultMethod: string,
  sourceId?: string,
): { method: string; path: string } {
  const parts = endpoint.trim().split(/\s+/, 2);
  const method = (parts.length === 2 ? parts[0] : defaultMethod).toUpperCase();
  const configuredPath = parts.length === 2 ? parts[1] : parts[0];
  const path = sourceId === undefined
    ? configuredPath
    : configuredPath.replace(':id', encodeURIComponent(sourceId));
  return { method, path };
}
