export type SearchScope = 'tasks' | 'notifications' | 'all';

export interface SearchFilters {
  source?: string;
  status?: string;
  excludeDone?: boolean;
}

export interface SearchOptions extends SearchFilters {
  type?: SearchScope;
  limit?: number;
}

export interface SearchResult {
  type: 'task' | 'notification';
  id: string;
  title: string;
  snippet: string;
  score: number;
  source: 'fts' | 'semantic' | 'hybrid';
  href: string;
  highlights?: {
    title?: string;
    snippet?: string;
  };
  metadata: Record<string, unknown>;
}

export interface SearchableTaskRecord {
  id: string;
  title: string;
  description?: string | null;
  sourceListName?: string | null;
  connectorType?: string | null;
  status?: string | null;
  priority?: string | null;
  updatedAt?: string | null;
}

export interface SearchableNotificationRecord {
  id: string;
  title: string;
  body?: string | null;
  category?: string | null;
  severity?: string | null;
  isRead?: boolean | null;
  isActionable?: boolean | null;
  connectorType?: string | null;
  receivedAt?: string | null;
}

export interface KeywordSearchRepository {
  rebuild(): Promise<void>;
  indexTask(task: SearchableTaskRecord): Promise<void>;
  removeTask(taskId: string): Promise<void>;
  indexNotification(notification: SearchableNotificationRecord): Promise<void>;
  removeNotification(notificationId: string): Promise<void>;
  warmUp(): Promise<void>;
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
}
