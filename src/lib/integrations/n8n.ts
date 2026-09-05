import type { IntegrationConfigRecord } from '@/db/persistence/webhook-integrations';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export const N8N_CONFIG_ID = 'n8n';

export interface N8NSettings extends Record<string, unknown> {
  workflowCount?: number;
  connected?: boolean;
  webhookSecret?: string;
  lastCheckedAt?: string;
  lastError?: string | null;
}

export async function getN8nConfig(): Promise<IntegrationConfigRecord | null> {
  return (await getWorkerPersistenceRepositories())
    .webhookIntegrations
    .integrations
    .find(N8N_CONFIG_ID);
}

export function parseN8NSettings(value: unknown): N8NSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as N8NSettings;
}
