import db from '@/db';
import { integrationConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';

export const N8N_CONFIG_ID = 'n8n';

export interface N8NSettings {
  workflowCount?: number;
  connected?: boolean;
  webhookSecret?: string;
  lastCheckedAt?: string;
  lastError?: string | null;
}

export async function getN8nConfig() {
  const [config] = await db
    .select()
    .from(integrationConfigs)
    .where(eq(integrationConfigs.id, N8N_CONFIG_ID))
    .limit(1);

  return config ?? null;
}

export function parseN8NSettings(value: unknown): N8NSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as N8NSettings;
}
