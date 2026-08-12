/**
 * Scout Connector — push-only connector for Microsoft Scout (AI agent).
 *
 * Scout pushes curated business M365 items into MC via the /api/scout/ingest
 * endpoint or the mc_scout_push_tasks MCP tool. This connector does NOT poll;
 * it exists primarily for registration, capability declaration, and type safety.
 */

import type {
  TaskItem,
  InboundNotification,
  ConnectorConfig,
  ConnectorCapabilities,
  SourceList,
  SyncResult,
} from '@/types';
import type { IConnector, ConnectorFactory } from '../index';
import { SCOUT_TASK_AUTHORITY } from '../task-source-profiles';

const SCOUT_CAPABILITIES: ConnectorCapabilities = {
  read: true,
  write: false,
  delete: false,
  sync: false,
  subtasks: false,
  lists: true,
  tags: true,
  tagWriteBack: false,
  listSelectionMode: 'not-applicable',
  ...SCOUT_TASK_AUTHORITY,
};

class ScoutConnector implements IConnector {
  readonly id = 'scout-primary';
  readonly type = 'scout';
  readonly displayName = 'Microsoft Scout';
  readonly icon = '🔭';
  readonly capabilities = SCOUT_CAPABILITIES;

  async initialize(_config: ConnectorConfig): Promise<void> {
    // Push-only — no initialization needed
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    return { success: true, message: 'Scout is a push-only connector; always reachable.' };
  }

  async dispose(): Promise<void> {
    // No resources to release
  }

  async *fetchTasks(_since?: Date): AsyncGenerator<TaskItem[], void, unknown> {
    // Scout does not poll — tasks arrive via /api/scout/ingest
    yield [];
  }

  async fetchNotifications(_since?: Date): Promise<InboundNotification[]> {
    return [];
  }

  async fetchSourceLists(): Promise<SourceList[]> {
    // Source lists are auto-created on first push per source type
    return [];
  }

  async getLastSyncToken(): Promise<string | null> {
    return null;
  }
}

export const scoutFactory: ConnectorFactory = {
  create(): IConnector {
    return new ScoutConnector();
  },
};
