import 'server-only';

import { and, eq, inArray, isNull } from 'drizzle-orm';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import type { ConnectorCapabilities, ConnectorConfig } from '@/types';
import {
  normalizeTyrionBridgeUrl,
  TyrionBridgeUrlValidationError,
} from './bridge-url';
import { FINANCE_PROVIDER_ALIASES, normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import { currencySchema } from '@/lib/finance/currency';
import {
  createFinanceIdentityNamespace,
  FINANCE_IDENTITY_NAMESPACE_CREDENTIAL,
  financeIdentityNamespaceFromCredentials,
} from './identity';

type ConnectorConfigRow = typeof connectorConfigs.$inferSelect;
type ConnectorConfigLike = {
  type: string;
  credentials?: unknown;
  settings?: unknown;
};

export type FinanceConnectorConfigurationState =
  | { status: 'configured'; code: null }
  | { status: 'needs-configuration'; code: 'household_currency_unavailable' };

export class FinanceConnectorConfigurationError extends Error {
  constructor(
    readonly code: 'household_currency_required' | 'household_currency_invalid',
  ) {
    super(code);
    this.name = 'FinanceConnectorConfigurationError';
  }
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
  options: { requireHouseholdCurrency: boolean },
): Record<string, unknown> {
  const parsed = parseObject(settings);
  const hasCurrency = Object.prototype.hasOwnProperty.call(parsed, 'householdCurrency');
  if (!hasCurrency) {
    if (options.requireHouseholdCurrency) {
      throw new FinanceConnectorConfigurationError('household_currency_required');
    }
    return parsed;
  }
  if (!currencySchema.safeParse(parsed.householdCurrency).success) {
    throw new FinanceConnectorConfigurationError('household_currency_invalid');
  }
  return parsed;
}

export function getFinanceConnectorConfigurationState(
  settings: unknown,
): FinanceConnectorConfigurationState {
  return currencySchema.safeParse(parseObject(settings).householdCurrency).success
    ? { status: 'configured', code: null }
    : { status: 'needs-configuration', code: 'household_currency_unavailable' };
}

export function redactFinanceConnector<T extends ConnectorConfigLike>(config: T): T {
  if (!isFinanceConnectorType(config.type)) return config;
  const safeSettings = { ...parseObject(config.settings) };
  for (const key of ['serviceToken', 'bridgeToken', 'apiToken']) {
    delete safeSettings[key];
  }
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
  const rows = await db.select().from(connectorConfigs).where(and(
    connectorId ? eq(connectorConfigs.id, connectorId) : undefined,
    inArray(connectorConfigs.type, [...FINANCE_PROVIDER_ALIASES]),
    eq(connectorConfigs.enabled, true),
    isNull(connectorConfigs.deletedAt),
  )).limit(connectorId ? 1 : 2);
  if (rows.length === 0) throw new Error('Finance connector is not configured');
  if (!connectorId && rows.length > 1) {
    throw new Error('connectorId is required when multiple finance connectors are enabled');
  }
  return financeConnectorConfigFromRow(rows[0]);
}
