import 'server-only';

import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import type { ConnectorCapabilities, ConnectorConfig } from '@/types';
import {
  normalizeTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from './bridge-url';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import {
  AttributionAttentionPolicyError,
  parseAttributionAttentionPolicy,
} from '@/lib/finance/attribution-attention-policy';
import {
  createFinanceIdentityNamespace,
  FINANCE_IDENTITY_NAMESPACE_CREDENTIAL,
  financeIdentityNamespaceFromCredentials,
} from './identity';

type ConnectorConfigRow = {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  syncMode: string;
  pollIntervalMinutes: number | null;
  capabilities: unknown;
  credentials: unknown;
  settings: unknown;
  syncedLists: unknown;
};
type ConnectorConfigLike = {
  type: string;
  credentials?: unknown;
  settings?: unknown;
};

export class FinanceConnectorConfigurationError extends Error {
  constructor(
    readonly code:
      | 'attribution_policy_pin_invalid'
      | 'attribution_attention_policy_invalid',
  ) {
    super(code);
    this.name = 'FinanceConnectorConfigurationError';
  }
}

export const TYRION_ATTRIBUTION_POLICY_SETTING = 'tyrionAttributionPolicy';

export type TyrionAttributionPolicySelection =
  | { mode: 'follow-current'; pinnedPolicyVersion: null }
  | { mode: 'pinned'; pinnedPolicyVersion: number };

export function getTyrionAttributionPolicySelection(
  settings: unknown,
): TyrionAttributionPolicySelection {
  const state = parseObject(settings)[TYRION_ATTRIBUTION_POLICY_SETTING];
  if (state === undefined) {
    return { mode: 'follow-current', pinnedPolicyVersion: null };
  }
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new FinanceConnectorConfigurationError('attribution_policy_pin_invalid');
  }
  const pinnedPolicyVersion = (state as Record<string, unknown>).pinnedPolicyVersion;
  if (pinnedPolicyVersion === undefined || pinnedPolicyVersion === null) {
    return { mode: 'follow-current', pinnedPolicyVersion: null };
  }
  if (!Number.isSafeInteger(pinnedPolicyVersion) || Number(pinnedPolicyVersion) < 1) {
    throw new FinanceConnectorConfigurationError('attribution_policy_pin_invalid');
  }
  return { mode: 'pinned', pinnedPolicyVersion: Number(pinnedPolicyVersion) };
}

export function isFinanceConnectorType(type: string): boolean {
  return normalizeFinanceProviderAlias(type) !== null;
}

export function sanitizeFinanceConnectorWrite<T extends ConnectorConfigLike>(config: T): T {
  if (!isFinanceConnectorType(config.type)) return config;
  const credentials = parseObject(config.credentials);
  const serviceToken = typeof credentials.serviceToken === 'string'
    ? credentials.serviceToken.trim()
    : '';
  const safeSettings = { ...parseObject(config.settings) };
  for (const key of ['serviceToken', 'bridgeToken', 'apiToken']) {
    delete safeSettings[key];
  }
  delete safeSettings.householdCurrency;
  delete safeSettings.cardRuleFingerprintParityProven;
  delete safeSettings.cardRuleFingerprintParityProvenAt;
  if (safeSettings.bridgeUrl !== undefined) {
    safeSettings.bridgeUrl = normalizeTyrionBridgeUrl(safeSettings.bridgeUrl);
  }

  return {
    ...config,
    credentials: serviceToken ? { serviceToken } : {},
    settings: safeSettings,
  };
}

export function protectNewFinanceConnectorCredentials(
  credentials: unknown,
): Record<string, string> {
  return {
    ...(parseObject(credentials) as Record<string, string>),
    [FINANCE_IDENTITY_NAMESPACE_CREDENTIAL]: createFinanceIdentityNamespace(),
  };
}

export function preserveFinanceConnectorIdentityCredentials(
  credentials: unknown,
  existingCredentials: unknown,
): Record<string, string> {
  const identityNamespace = financeIdentityNamespaceFromCredentials(existingCredentials)
    ?? createFinanceIdentityNamespace();
  return {
    ...(parseObject(credentials) as Record<string, string>),
    [FINANCE_IDENTITY_NAMESPACE_CREDENTIAL]: identityNamespace,
  };
}

export function validateFinanceConnectorSettings(
  settings: unknown,
): Record<string, unknown> {
  const parsed = parseObject(settings);
  getTyrionAttributionPolicySelection(parsed);
  delete parsed.householdCurrency;
  try {
    parseAttributionAttentionPolicy(parsed, 'USD');
  } catch (error) {
    if (!(error instanceof AttributionAttentionPolicyError)) throw error;
    throw new FinanceConnectorConfigurationError('attribution_attention_policy_invalid');
  }
  return parsed;
}

export function redactFinanceConnector<T extends ConnectorConfigLike>(config: T): T {
  if (!isFinanceConnectorType(config.type)) return config;
  const safeSettings = { ...parseObject(config.settings) };
  for (const key of ['serviceToken', 'bridgeToken', 'apiToken']) {
    delete safeSettings[key];
  }
  delete safeSettings.householdCurrency;
  if (safeSettings.bridgeUrl !== undefined) {
    try {
      safeSettings.bridgeUrl = normalizeTyrionBridgeUrl(safeSettings.bridgeUrl);
    } catch (error) {
      if (!(error instanceof TyrionBridgeUrlValidationError)) throw error;
      delete safeSettings.bridgeUrl;
    }
  }
  return {
    ...config,
    settings: safeSettings,
    credentials: {},
  };
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

function parseArray(value: unknown): string[] {
  if (typeof value === 'string') return JSON.parse(value) as string[];
  return (value as string[] | null) ?? [];
}

function parseCapabilities(value: unknown): ConnectorCapabilities {
  const parsed = parseObject(value);
  const flag = (key: keyof ConnectorCapabilities): boolean => parsed[key] === true;
  return {
    read: flag('read'),
    write: flag('write'),
    delete: flag('delete'),
    sync: flag('sync'),
    subtasks: flag('subtasks'),
    lists: flag('lists'),
    tags: flag('tags'),
    tagWriteBack: flag('tagWriteBack'),
    ...(typeof parsed.close === 'boolean' ? { close: parsed.close } : {}),
    ...(typeof parsed.dueDate === 'boolean' ? { dueDate: parsed.dueDate } : {}),
    ...(typeof parsed.priority === 'boolean' ? { priority: parsed.priority } : {}),
    ...(typeof parsed.priorityWriteBack === 'boolean'
      ? { priorityWriteBack: parsed.priorityWriteBack }
      : {}),
  };
}

export function financeConnectorConfigFromRow(row: ConnectorConfigRow): ConnectorConfig {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    enabled: row.enabled,
    syncMode: row.syncMode as ConnectorConfig['syncMode'],
    pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
    capabilities: parseCapabilities(row.capabilities),
    credentials: parseObject(row.credentials) as Record<string, string>,
    settings: parseObject(row.settings),
    syncedLists: parseArray(row.syncedLists),
  };
}

export async function getPersistedFinanceConnectorConfig(
  connectorId?: string | null,
): Promise<ConnectorConfig> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  const configs = (await repositories.connectors.listEnabled())
    .filter((config) => isFinanceConnectorType(config.type))
    .filter((config) => !connectorId || config.id === connectorId);
  if (configs.length === 0) throw new Error('Finance connector is not configured');
  if (!connectorId && configs.length > 1) {
    throw new Error('connectorId is required when multiple finance connectors are enabled');
  }
  return configs[0];
}

export async function getPersistedFinanceConnectorConfigById(
  connectorId: string,
): Promise<ConnectorConfig> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  const config = await repositories.connectors.get(connectorId);
  if (!config || !isFinanceConnectorType(config.type)) {
    throw new Error('Finance connector is not configured');
  }
  return config;
}
