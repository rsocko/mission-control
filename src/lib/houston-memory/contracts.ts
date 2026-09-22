import type { SemanticSensitivity } from '@/lib/semantic-index/contracts';

export const HOUSTON_MEMORY_SCOPE = 'installation' as const;
export const HOUSTON_MEMORY_DEFAULT_RETENTION_DAYS = 90;
export const HOUSTON_MEMORY_MAX_RETENTION_DAYS = 365;
export const HOUSTON_MEMORY_MAX_LIST_LIMIT = 100;

export type HoustonMemoryEntityType = 'task' | 'project' | 'tag';

export interface HoustonMemoryEntityLink {
  type: HoustonMemoryEntityType;
  id: string;
  label: string;
}

export interface HoustonConversationMemory {
  id: string;
  authorizationScope: string;
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  linkedEntities: HoustonMemoryEntityLink[];
  sensitivity: SemanticSensitivity;
  retainUntil: string;
  excludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HoustonConversationMemoryWrite {
  id: string;
  authorizationScope: string;
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  linkedEntities: HoustonMemoryEntityLink[];
  sensitivity: SemanticSensitivity;
  retainUntil: string;
  now: string;
}

export interface HoustonMemoryListRequest {
  authorizationScope: string;
  limit: number;
  beforeUpdatedAt?: string | null;
  now: string;
}

export interface HoustonMemorySettings {
  enabled: boolean;
  retentionDays: number;
}

export interface HoustonMemoryRepository {
  get(id: string, authorizationScope: string): Promise<HoustonConversationMemory | null>;
  list(input: HoustonMemoryListRequest): Promise<HoustonConversationMemory[]>;
  upsert(input: HoustonConversationMemoryWrite): Promise<HoustonConversationMemory>;
  exclude(id: string, authorizationScope: string, now: string): Promise<boolean>;
  delete(id: string, authorizationScope: string): Promise<boolean>;
  deleteExpired(now: string, limit: number): Promise<string[]>;
}
