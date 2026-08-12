import type {
  ConnectorCapabilities,
  ConnectorConfig,
  InboundNotification,
  SourceList,
  TaskItem,
} from '@/types';
import type { ConnectorFactory, IConnector } from '../index';

export class WorkTodoBridgeConnector implements IConnector {
  readonly id = '';
  readonly type = 'microsoft-todo-work';
  readonly displayName = 'Microsoft To Do - Work';
  readonly icon = '✅';
  readonly writeDelivery = 'deferred' as const;
  readonly capabilities: ConnectorCapabilities = {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: true,
    tagWriteBack: false,
    priority: true,
    priorityWriteBack: true,
    dueDate: true,
    taskCreate: false,
    listSelectionMode: 'optional',
    tagScope: 'global',
    tagCreationMode: 'predefined',
  };

  private config: ConnectorConfig | null = null;

  async initialize(config: ConnectorConfig): Promise<void> {
    this.config = config;
    (this as { id: string }).id = config.id;
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.config) return { success: false, message: 'Connector is not initialized.' };
    const { getWorkTodoBridgeStatus } = await import('./service');
    const status = await getWorkTodoBridgeStatus(this.config.id);
    if (!status.initialized) {
      return {
        success: false,
        message: 'Waiting for the first Power Automate baseline.',
      };
    }
    return {
      success: !status.resetRequired,
      message: status.resetRequired
        ? 'Delta reset required before the next extended pull.'
        : `Bridge initialized; last ${status.lastIngestMode} accepted at ${status.lastIngestAt}.`,
    };
  }

  async dispose(): Promise<void> {
    this.config = null;
  }

  async *fetchTasks(): AsyncGenerator<TaskItem[], void, unknown> {
    // Power Automate pushes authoritative batches through the bridge ingest tool.
  }

  async fetchNotifications(): Promise<InboundNotification[]> {
    return [];
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    return [];
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }
}

export const workTodoBridgeFactory: ConnectorFactory = {
  create: () => new WorkTodoBridgeConnector(),
};
