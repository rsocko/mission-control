import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
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
  const config = getResolvedAIConfig();
  return {
    enabled: config.houstonMemoryEnabled,
    retentionDays: normalizeRetentionDays(config.houstonMemoryRetentionDays),
  };
}
