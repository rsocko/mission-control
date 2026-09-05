import type {
  ConnectorConfig,
  HubProject,
  NotificationItem,
  TaskItem,
} from '@/types';
import type { PersistenceJson } from './contracts';
import type { HoustonMemoryRepository } from '@/lib/houston-memory/contracts';

export interface ConnectorSettingsStatePatchResult<TState> {
  settings: Record<string, unknown>;
  state: TState;
}

export interface TaskRepository {
  get(id: string): Promise<TaskItem | null>;
  upsert(task: TaskItem): Promise<TaskItem>;
  delete(id: string): Promise<boolean>;
}

export interface ProjectRepository {
  get(id: string): Promise<HubProject | null>;
  upsert(project: HubProject): Promise<HubProject>;
  delete(id: string): Promise<boolean>;
}

export type ConnectorTestStatus = 'success' | 'failed';

export interface ConnectorTestResultCommand {
  connectorId: string;
  status: ConnectorTestStatus;
  /** Redacted, caller-facing failure summary. `null` on success. */
  error: string | null;
  testedAt: string;
}

export interface ConnectorRepository {
  get(id: string): Promise<ConnectorConfig | null>;
  listEnabled(): Promise<ConnectorConfig[]>;
  /**
   * Returns every soft-deleted connector ID in deterministic binary order.
   * Optional only for legacy test compositions; route consumers must fail closed
   * unless the selected backend implements `ConnectorDeletedIdsRepository`.
   */
  listDeletedIds?(): Promise<string[]>;
  upsert(connector: ConnectorConfig): Promise<ConnectorConfig>;
  /**
   * Records the outcome of a manual connection test so the settings connection
   * badge reflects real, current status instead of only "credentials are
   * stored". The write is a single bounded statement and never throws for an
   * unknown or soft-deleted connector: it resolves `{ recorded: false }` so the
   * caller's non-fatal badge semantics hold. Only the redacted `error` summary
   * is stored — never credentials or a raw provider body.
   */
  recordTestResult(
    command: ConnectorTestResultCommand,
  ): Promise<{ recorded: boolean }>;
  /** Updates credentials and atomically merges an optional authentication settings patch. */
  updateCredentials(
    id: string,
    credentials: ConnectorConfig['credentials'],
    settingsPatch?: Record<string, unknown>,
  ): Promise<void>;
  /** Removes the connector from the active configuration set. */
  delete(id: string): Promise<boolean>;
  mergeSettings(
    id: string,
    currentSettings: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  patchSettingsState<T extends object>(
    id: string,
    key: string,
    patch: Partial<T>,
  ): Promise<ConnectorSettingsStatePatchResult<T>>;
}

export interface ConnectorDeletedIdsRepository extends ConnectorRepository {
  listDeletedIds(): Promise<string[]>;
}

export interface NotificationRepository {
  get(id: string): Promise<NotificationItem | null>;
  /**
   * Persists supplied pending actions without deleting unmentioned action
   * history owned by notification execution.
   */
  upsert(notification: NotificationItem): Promise<NotificationItem>;
  delete(id: string): Promise<boolean>;
}

export interface SettingsRepository {
  get(key: string): Promise<PersistenceJson | null>;
  set(key: string, value: PersistenceJson): Promise<void>;
  delete(key: string): Promise<boolean>;
  getMany?(keys: readonly string[]): Promise<Record<string, PersistenceJson | null>>;
  setMany?(entries: ReadonlyArray<readonly [string, PersistenceJson]>): Promise<void>;
  getActiveEmbeddingIdentity?(): Promise<ActiveEmbeddingIdentity | null>;
}

export interface AtomicSettingsRepository extends SettingsRepository {
  getMany(keys: readonly string[]): Promise<Record<string, PersistenceJson | null>>;
  setMany(entries: ReadonlyArray<readonly [string, PersistenceJson]>): Promise<void>;
  getActiveEmbeddingIdentity(): Promise<ActiveEmbeddingIdentity | null>;
}

export interface ActiveEmbeddingIdentity {
  provider: string;
  model: string;
  dimensions: number;
  vectorCount: number;
}

export interface CorePersistenceRepositories {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly connectors: ConnectorRepository;
  readonly notifications: NotificationRepository;
  readonly settings: SettingsRepository;
  readonly houstonMemories: HoustonMemoryRepository;
}
