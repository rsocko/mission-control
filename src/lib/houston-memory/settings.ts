import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import {
  HOUSTON_MEMORY_DEFAULT_RETENTION_DAYS,
  HOUSTON_MEMORY_MAX_RETENTION_DAYS,
  type HoustonMemorySettings,
} from './contracts';

function normalizeRetentionDays(value: unknown): number {
  if (!Number.isSafeInteger(value)) return HOUSTON_MEMORY_DEFAULT_RETENTION_DAYS;
  return Math.min(Math.max(value as number, 1), HOUSTON_MEMORY_MAX_RETENTION_DAYS);
}

export async function getHoustonMemorySettings(): Promise<HoustonMemorySettings> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  const stored = await repositories.settings.get('ai_provider_config');
  const config = stored && typeof stored === 'object' && !Array.isArray(stored)
    ? stored
    : {};
  const enabled = typeof config.houstonMemoryEnabled === 'boolean'
    ? config.houstonMemoryEnabled
    : /^(1|true|yes|on)$/i.test(process.env.AI_HOUSTON_MEMORY_ENABLED?.trim() ?? '');
  return {
    enabled,
    retentionDays: normalizeRetentionDays(
      config.houstonMemoryRetentionDays
        ?? Number(process.env.AI_HOUSTON_MEMORY_RETENTION_DAYS),
    ),
  };
}
