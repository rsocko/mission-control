import {
  DEFAULT_AI_ROUTING_POLICY,
  resolveSourceSensitivity,
} from '@/lib/ai/sensitivity-policy';
import type {
  AIRoutingPolicyConfig,
  SensitivityClass,
} from '@/lib/ai/types';

export type ConnectorDataClassification = SensitivityClass;

export const CONNECTOR_CLASSIFICATION_SETTING = 'dataClassificationOverride';

export const DATA_CLASSIFICATION_LABELS: Record<ConnectorDataClassification, string> = {
  standard: 'Standard',
  restricted: 'Restricted',
  'local-only': 'Local only',
};

export const DATA_CLASSIFICATION_DESCRIPTIONS: Record<ConnectorDataClassification, string> = {
  standard: 'May use any route allowed by the active AI policy and eligible execution destinations.',
  restricted: 'Stays on private AI routes and only goes to destinations that explicitly allow restricted data.',
  'local-only': 'Stays inside the Mission Control-hosted environment and cannot be sent to external destinations.',
};

const CLASSIFICATION_RANK: Record<ConnectorDataClassification, number> = {
  standard: 0,
  restricted: 1,
  'local-only': 2,
};

function settingsRecord(settings: unknown): Record<string, unknown> {
  if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
    return settings as Record<string, unknown>;
  }
  if (typeof settings === 'string') {
    try {
      const parsed = JSON.parse(settings);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

export function isConnectorDataClassification(
  value: unknown,
): value is ConnectorDataClassification {
  return value === 'standard' || value === 'restricted' || value === 'local-only';
}

export function connectorClassificationOverride(
  settings: unknown,
): ConnectorDataClassification | null {
  const value = settingsRecord(settings)[CONNECTOR_CLASSIFICATION_SETTING];
  return isConnectorDataClassification(value) ? value : null;
}

export function connectorBaselineClassification(
  connectorType: string,
  policy: AIRoutingPolicyConfig = DEFAULT_AI_ROUTING_POLICY,
): ConnectorDataClassification {
  return resolveSourceSensitivity(connectorType, policy);
}

export function resolveConnectorDataClassification(
  connectorType: string,
  settings: unknown,
  policy: AIRoutingPolicyConfig = DEFAULT_AI_ROUTING_POLICY,
): ConnectorDataClassification {
  const baseline = connectorBaselineClassification(connectorType, policy);
  const override = connectorClassificationOverride(settings);
  if (!override || CLASSIFICATION_RANK[override] < CLASSIFICATION_RANK[baseline]) {
    return baseline;
  }
  return override;
}

export function connectorClassificationOptions(
  baseline: ConnectorDataClassification,
): ConnectorDataClassification[] {
  return (['standard', 'restricted', 'local-only'] as const)
    .filter((classification) =>
      CLASSIFICATION_RANK[classification] >= CLASSIFICATION_RANK[baseline]);
}

export function validateConnectorClassificationOverride(
  connectorType: string,
  value: unknown,
  policy: AIRoutingPolicyConfig = DEFAULT_AI_ROUTING_POLICY,
): ConnectorDataClassification | null {
  if (value === undefined || value === null || value === '') return null;
  if (!isConnectorDataClassification(value)) {
    throw new Error('Data classification must be standard, restricted, or local-only');
  }
  const baseline = connectorBaselineClassification(connectorType, policy);
  if (CLASSIFICATION_RANK[value] < CLASSIFICATION_RANK[baseline]) {
    throw new Error(
      `${DATA_CLASSIFICATION_LABELS[baseline]} is the minimum classification for ${connectorType}`,
    );
  }
  return value === baseline ? null : value;
}

export function withConnectorClassificationOverride(
  settings: unknown,
  override: ConnectorDataClassification | null,
): Record<string, unknown> {
  const next = { ...settingsRecord(settings) };
  if (override) next[CONNECTOR_CLASSIFICATION_SETTING] = override;
  else delete next[CONNECTOR_CLASSIFICATION_SETTING];
  return next;
}

export function connectorClassificationSummary(
  connectorType: string,
  settings: unknown,
  policy: AIRoutingPolicyConfig = DEFAULT_AI_ROUTING_POLICY,
) {
  const baseline = connectorBaselineClassification(connectorType, policy);
  const override = connectorClassificationOverride(settings);
  const effective = resolveConnectorDataClassification(connectorType, settings, policy);
  return {
    baseline,
    effective,
    override: override && CLASSIFICATION_RANK[override] >= CLASSIFICATION_RANK[baseline]
      ? override
      : null,
  };
}
