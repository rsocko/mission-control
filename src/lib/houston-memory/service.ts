import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import {
  HOUSTON_MEMORY_MAX_LIST_LIMIT,
  HOUSTON_MEMORY_SCOPE,
  type HoustonConversationMemory,
  type HoustonConversationMemoryWrite,
} from './contracts';

async function publish(kind: 'upsert' | 'delete', id: string): Promise<void> {
  const { publishSemanticDelete, publishSemanticUpsert } = await import(
    '@/lib/semantic-index/runtime'
  );
  if (kind === 'upsert') await publishSemanticUpsert('houston-summary', id);
  else await publishSemanticDelete('houston-summary', id);
}

export async function getHoustonMemory(
  id: string,
  now = new Date().toISOString(),
): Promise<HoustonConversationMemory | null> {
  const memory = await getCorePersistenceRepositories().houstonMemories.get(
    id,
    HOUSTON_MEMORY_SCOPE,
  );
  if (!memory || memory.excludedAt || memory.retainUntil <= now) return null;
  return memory;
}

export function inspectHoustonMemory(
  id: string,
): Promise<HoustonConversationMemory | null> {
  return getCorePersistenceRepositories().houstonMemories.get(id, HOUSTON_MEMORY_SCOPE);
}

export function listHoustonMemories(input: {
  limit?: number;
  beforeUpdatedAt?: string | null;
  now?: string;
} = {}): Promise<HoustonConversationMemory[]> {
  return getCorePersistenceRepositories().houstonMemories.list({
    authorizationScope: HOUSTON_MEMORY_SCOPE,
    limit: Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), HOUSTON_MEMORY_MAX_LIST_LIMIT),
    beforeUpdatedAt: input.beforeUpdatedAt,
    now: input.now ?? new Date().toISOString(),
  });
}

export async function upsertHoustonMemory(
  input: Omit<HoustonConversationMemoryWrite, 'authorizationScope'>,
): Promise<HoustonConversationMemory> {
  const memory = await getCorePersistenceRepositories().houstonMemories.upsert({
    ...input,
    authorizationScope: HOUSTON_MEMORY_SCOPE,
  });
  await publish('upsert', memory.id);
  return memory;
}

export async function excludeHoustonMemory(id: string): Promise<boolean> {
  const now = new Date().toISOString();
  const excluded = await getCorePersistenceRepositories().houstonMemories.exclude(
    id,
    HOUSTON_MEMORY_SCOPE,
    now,
  );
  await publish('delete', id);
  return excluded;
}

export async function deleteHoustonMemory(id: string): Promise<boolean> {
  const deleted = await getCorePersistenceRepositories().houstonMemories.delete(
    id,
    HOUSTON_MEMORY_SCOPE,
  );
  await publish('delete', id);
  return deleted;
}

export async function deleteExpiredHoustonMemories(
  now = new Date().toISOString(),
  limit = HOUSTON_MEMORY_MAX_LIST_LIMIT,
): Promise<number> {
  const ids = await getCorePersistenceRepositories().houstonMemories.deleteExpired(
    now,
    Math.min(Math.max(Math.trunc(limit), 1), HOUSTON_MEMORY_MAX_LIST_LIMIT),
  );
  await Promise.all(ids.map((id) => publish('delete', id)));
  return ids.length;
}
