import type {
  ConnectorConfig,
  HubProject,
  NotificationItem,
  TaskItem,
} from '@/types';
import type { PersistenceJson } from './contracts';

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

export interface ConnectorRepository {
  get(id: string): Promise<ConnectorConfig | null>;
  upsert(connector: ConnectorConfig): Promise<ConnectorConfig>;
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
}

export interface CorePersistenceRepositories {
  readonly tasks: TaskRepository;
  readonly projects: ProjectRepository;
  readonly connectors: ConnectorRepository;
  readonly notifications: NotificationRepository;
  readonly settings: SettingsRepository;
}
