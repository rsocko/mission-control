import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  SyncResult,
  DomainSyncContext,
  DomainSyncResult,
  FetchTaskOptions,
  SourceTaskDependencySnapshot,
  TriageItem,
} from '@/types';
import type { ConnectorNotificationTypeDefinition } from '@/lib/notifications/push-policy/catalog';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import { validateNotificationTypeCatalog } from '@/lib/notifications/push-policy/catalog';
import { customRestFactory } from './custom-rest';
import { documentIntelligenceFactory } from './document-intelligence';
import { githubIssuesFactory } from './github-issues';
import { homeAssistantFactory } from './home-assistant';
import { microsoftTodoFactory } from './microsoft-todo';
import { financeManagerFactory } from './monarch-money';
import { outlookCalendarFactory } from './outlook-calendar';
import { outlookEmailFactory } from './outlook-email';
import { ryMessageFactory } from './rymessage';
import { scoutFactory } from './scout';
import { workTodoBridgeFactory } from './work-todo';
import type { NotificationWritebackAction } from './notification-writeback-contract';
import {
  assertCanRegisterConnectorRegistry,
  registerConnectorRegistry,
} from './registry-runtime';
export {
  ConnectorWritebackError,
  type NotificationWritebackAction,
} from './notification-writeback-contract';

/**
 * Result of reconciling a single notification against its upstream source.
 */
export interface AlertReconciliation {
  sourceId: string;
  resolved: boolean;
  reason?: string;       // e.g. "PR merged", "condition cleared", "email replied"
  resolvedAt?: string;   // ISO timestamp of upstream resolution
}

export interface TransferIdentityRefresh {
  task: TaskItem;
  sourceLists: Array<{
    sourceId: string;
    evidence: ExternalIdentityEvidence;
  }>;
}

/**
 * Interface that all connectors must implement.
 * Each connector is a self-contained adapter for a single data source.
 */
export interface IConnector {
  // 📋 Metadata ─────────────────────────────────────────────────────────
  readonly id: string;
  readonly type: string;
  readonly displayName: string;
  readonly icon: string;
  readonly capabilities: ConnectorCapabilities;
  /** Deferred connectors queue mutations for an external courier instead of writing inline. */
  readonly writeDelivery?: 'immediate' | 'deferred';
  readonly notificationTypes?: readonly ConnectorNotificationTypeDefinition[];
  /** Dependency edges are emitted into a durable generation while task pages stream. */
  readonly dependencySnapshotStrategy?: 'task-stream';

  // 🔄 Lifecycle ────────────────────────────────────────────────────────
  initialize(config: ConnectorConfig): Promise<void>;
  testConnection(): Promise<{ success: boolean; message: string }>;
  dispose(): Promise<void>;

  // 📖 Read Operations ──────────────────────────────────────────────────

  /** Stream task pages (with sub-tasks as nested items via parentId). */
  fetchTasks(since?: Date, options?: FetchTaskOptions): AsyncGenerator<TaskItem[], void, unknown>;

  /** Fetch notifications */
  fetchNotifications(since?: Date): Promise<InboundNotification[]>;
  /** Commit a connector-owned notification cursor after fetched notifications are durable. */
  commitNotificationFetch?(): Promise<void>;

  /** Enumerate available lists/projects/repos from this source */
  fetchSourceLists(): Promise<SourceList[]>;

  /** Fetch available tags/labels/categories from the source */
  fetchSourceTags?(): Promise<{ id: string; name: string; color?: string }[]>;

  /** Fetch triage items from this connector (for gallery/inbox integration) */
  fetchTriageItems?(since?: Date): Promise<TriageItem[]>;

  /** Fetch native blocker -> blocked task dependency edges for the supplied tasks */
  fetchTaskDependencies?(
    sourceIds: string[],
    options?: { signal?: AbortSignal },
  ): Promise<SourceTaskDependencySnapshot>;

  // ✏️ Write Operations (optional based on capabilities) ────────────────

  /** Create a new task in the source */
  createTask?(task: Partial<TaskItem>): Promise<TaskItem>;

  /** Add a native blocker -> blocked task dependency edge */
  addTaskDependency?(blockerSourceId: string, blockedSourceId: string): Promise<void>;

  /** Remove a native blocker -> blocked task dependency edge */
  removeTaskDependency?(blockerSourceId: string, blockedSourceId: string): Promise<void>;

  /** Update an existing task */
  updateTask?(sourceId: string, updates: Partial<TaskItem>): Promise<TaskItem>;

  /** Mark a task as complete */
  completeTask?(sourceId: string): Promise<void>;

  /** Close a task with a specific reason (e.g. not_planned, duplicate) */
  closeTaskWithReason?(sourceId: string, reason: 'completed' | 'not_planned' | 'duplicate'): Promise<void>;

  /** Delete a task */
  /** Delete a task */
  deleteTask?(sourceId: string): Promise<void>;

  /** Move a task to a different list within the same connector */
  moveTaskToList?(sourceId: string, targetListSourceId: string): Promise<string | void>;

  /** Rename a source list in the remote system */
  renameList?(sourceId: string, newName: string): Promise<void>;

  /** Create a new list in the remote system */
  createList?(name: string): Promise<{ id: string; displayName: string }>;

  /** Delete a list from the remote system */
  deleteList?(sourceId: string): Promise<void>;

  /** Create a sub-task under a parent */
  createSubTask?(parentSourceId: string, task: Partial<TaskItem>): Promise<TaskItem>;

  /** Mark a sub-task/checklist item as complete */
  completeSubTask?(parentSourceId: string, subTaskSourceId: string): Promise<void>;

  /** Update a sub-task/checklist item */
  updateSubTask?(parentSourceId: string, subTaskSourceId: string, updates: Partial<TaskItem>): Promise<void>;

  /** Add a tag/label to a task in the source system */
  addTagToTask?(sourceId: string, tagName: string): Promise<void>;

  /** Remove a tag/label from a task in the source system */
  removeTagFromTask?(sourceId: string, tagName: string): Promise<void>;

  /** Create a tag/label in a source list (e.g. create a GitHub label on a repo) */
  createTagInSource?(sourceListId: string, tagName: string, color?: string): Promise<void>;

  /** Dismiss/acknowledge an alert in the source system */
  dismissAlert?(sourceId: string): Promise<void>;
  /** Dismiss/acknowledge alerts in one connector request when supported. */
  dismissAlerts?(sourceIds: string[]): Promise<void>;
  /** Apply an explicit notification lifecycle operation at the provider. */
  writeNotificationAction?(
    sourceId: string,
    action: NotificationWritebackAction,
    signal?: AbortSignal,
  ): Promise<void>;

  /**
   * Add a comment/note to a task in the source system.
   * Used to attach cross-reference breadcrumbs when copying a task.
   */
  addComment?(sourceId: string, body: string): Promise<void>;

  /**
   * Native transfer of a task to another list/repo within the same connector.
   * Only available for connectors that support true server-side transfer
   * (e.g. GitHub repo-to-repo via the Transfer Issue API).
   * Returns the identity-verified sourceId in the target list.
   */
  transferTask?(
    sourceId: string,
    targetSourceListId: string,
  ): Promise<{ newSourceId: string; identityVerified: true }>;

  /** Check whether a server-side transfer can satisfy its safety preconditions. */
  canTransferTask?(sourceId: string, targetSourceListId: string): boolean | Promise<boolean>;

  /** Refresh only the remote entities needed to safely transfer one task. */
  refreshTransferIdentity?(
    sourceId: string,
    targetSourceListId: string,
  ): Promise<TransferIdentityRefresh>;

  // 📎 Attachments (optional based on capabilities.attachments) ────────

  /** Upload a file attachment to a task in the source */
  uploadAttachment?(sourceId: string, file: { name: string; contentType: string; contentBase64: string }): Promise<{ id: string; name: string; size: number }>;

  /** List all attachments on a task */
  listAttachments?(sourceId: string): Promise<Array<{ id: string; name: string; contentType: string; size: number }>>;

  /** Delete an attachment from a task */
  deleteAttachment?(sourceId: string, attachmentId: string): Promise<void>;

  /** Download attachment content (returns base64) */
  getAttachmentContent?(sourceId: string, attachmentId: string): Promise<{ contentBase64: string; contentType: string }>;

  // 🔄 Sync ─────────────────────────────────────────────────────────────

  /** Get a delta sync token for incremental fetching */
  getLastSyncToken(): Promise<string | null>;

  /** Synchronize connector-owned domain data that is neither tasks nor notifications. */
  syncDomainData?(context: DomainSyncContext): Promise<DomainSyncResult>;

  /** Handle incoming webhook payload (if connector supports webhooks) */
  handleWebhook?(payload: unknown): Promise<SyncResult>;

  // 🔄 Notification Reconciliation ────────────────────────────────────────

  /**
   * "Clear and refresh" approach: return all currently-active alert sourceIds
   * from this connector. Any MC notification NOT in this set will be auto-resolved.
   *
   * Preferred when the source gives you a complete picture cheaply (e.g., GitHub
   * notification list, Home Assistant state evaluation, DI missing docs list).
   *
   * Return null to skip full-refresh and fall through to reconcileAlerts().
   */
  getActiveAlertSourceIds?(since?: Date): Promise<string[] | null>;

  /**
   * Per-ID reconciliation: given specific sourceIds that MC holds as active,
   * return which ones are resolved upstream.
   *
   * Used when full-refresh is expensive but per-item checks are cheap.
   * Only called for sourceIds NOT already resolved by getActiveAlertSourceIds().
   */
  reconcileAlerts?(activeSourceIds: string[]): Promise<AlertReconciliation[]>;
}

/**
 * Registry for managing connector instances.
 */
export class ConnectorRegistry {
  private connectors = new Map<string, IConnector>();
  private factories = new Map<string, ConnectorFactory>();

  registerFactory(type: string, factory: ConnectorFactory): void {
    if (!type.trim()) throw new Error('Connector factory type is required');
    if (factory.notificationTypes) {
      validateNotificationTypeCatalog(type, factory.notificationTypes);
    }
    this.factories.set(type, factory);
  }

  getNotificationTypeCatalog(
    type: string,
    config?: ConnectorConfig,
  ): readonly ConnectorNotificationTypeDefinition[] {
    const factory = this.factories.get(type);
    if (!factory) return Object.freeze([]);
    const catalog = config && factory.getNotificationTypes
      ? factory.getNotificationTypes(config)
      : factory.notificationTypes ?? [];
    return validateNotificationTypeCatalog(type, catalog);
  }

  async createConnector(config: ConnectorConfig): Promise<IConnector> {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(`No factory registered for connector type: ${config.type}`);
    }
    this.getNotificationTypeCatalog(config.type, config);
    const connector = factory.create();
    await connector.initialize(config);
    this.connectors.set(config.id, connector);
    return connector;
  }

  async replaceConnector(config: ConnectorConfig): Promise<IConnector> {
    // Do not dispose the previous instance here: an API operation may still
    // hold it after reading from the registry. Dropping the map reference lets
    // that operation finish while the refreshed instance serves new work.
    return this.createConnector(config);
  }

  getConnector(id: string): IConnector | undefined {
    return this.connectors.get(id);
  }

  getAllConnectors(): IConnector[] {
    return Array.from(this.connectors.values());
  }

  async removeConnector(id: string): Promise<void> {
    const connector = this.connectors.get(id);
    if (connector) {
      await connector.dispose();
      this.connectors.delete(id);
    }
  }
}

export interface ConnectorFactory {
  create(): IConnector;
  readonly notificationTypes?: readonly ConnectorNotificationTypeDefinition[];
  getNotificationTypes?(config: ConnectorConfig): readonly ConnectorNotificationTypeDefinition[];
}

// Singleton registry
export const connectorRegistry = new ConnectorRegistry();

export function assertCanRegisterConnectorRuntimeRegistry(): void {
  assertCanRegisterConnectorRegistry(connectorRegistry);
}

export function registerConnectorRuntimeRegistry(): void {
  registerConnectorRegistry(connectorRegistry);
}

let defaultFactoriesRegistered = false;

export function registerDefaultConnectorFactories(): void {
  if (defaultFactoriesRegistered) {
    return;
  }

  connectorRegistry.registerFactory('microsoft-todo', microsoftTodoFactory);
  connectorRegistry.registerFactory('microsoft-todo-work', workTodoBridgeFactory);
  connectorRegistry.registerFactory('github-issues', githubIssuesFactory);
  connectorRegistry.registerFactory('outlook-calendar', outlookCalendarFactory);
  connectorRegistry.registerFactory('outlook-email', outlookEmailFactory);
  connectorRegistry.registerFactory('rymessage', ryMessageFactory);
  connectorRegistry.registerFactory('finance-manager', financeManagerFactory);
  connectorRegistry.registerFactory('monarch-money', financeManagerFactory);
  connectorRegistry.registerFactory('finance', financeManagerFactory);
  connectorRegistry.registerFactory('custom-rest', customRestFactory);
  connectorRegistry.registerFactory('home-assistant', homeAssistantFactory);
  connectorRegistry.registerFactory('document-intelligence', documentIntelligenceFactory);
  connectorRegistry.registerFactory('scout', scoutFactory);

  defaultFactoriesRegistered = true;
}

registerDefaultConnectorFactories();
