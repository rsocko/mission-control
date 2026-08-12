import type { NotificationLevel } from '@/types';
import { notificationMeetsMinimumLevel } from '@/lib/notifications/levels';
import type {
  ConnectorNotificationTypeDefinition,
  PushPreview,
} from './catalog';
import { isPreviewSafeForType } from './catalog';

export interface NotificationPushRuleValues {
  templateKey: string;
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: number | null;
}

export type NotificationPushPolicySource = 'user' | 'connector' | 'system';
export type NotificationPushPolicySourceDetail =
  | 'exact'
  | 'wildcard'
  | 'recommended'
  | 'system_off';
export type NotificationPushPolicyIneligibilityReason =
  | 'connector_deleted'
  | 'connector_disabled'
  | 'missing_template_key'
  | 'unknown_template_key'
  | 'catalog_ineligible';

export interface ResolvedNotificationPushPolicy {
  eligible: boolean;
  enabled: boolean;
  shouldPush: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: number | null;
  source: NotificationPushPolicySource;
  sourceDetail: NotificationPushPolicySourceDetail;
  ineligibilityReason: NotificationPushPolicyIneligibilityReason | null;
  definition: ConnectorNotificationTypeDefinition | null;
}

interface ResolveNotificationPushPolicyInput {
  templateKey?: string | null;
  level: NotificationLevel;
  catalog: readonly ConnectorNotificationTypeDefinition[];
  exactRule?: NotificationPushRuleValues | null;
  wildcardRule?: NotificationPushRuleValues | null;
  connectorDeleted?: boolean;
  connectorDisabled?: boolean;
}

const SYSTEM_OFF = {
  enabled: false,
  minLevel: 'urgent',
  preview: 'title_only',
  maxPerHour: null,
} as const;

function disabledSystemPolicy(
  ineligibilityReason: NotificationPushPolicyIneligibilityReason,
  definition: ConnectorNotificationTypeDefinition | null = null,
): ResolvedNotificationPushPolicy {
  return {
    eligible: false,
    shouldPush: false,
    source: 'system',
    sourceDetail: 'system_off',
    ineligibilityReason,
    definition,
    ...SYSTEM_OFF,
  };
}

function recommendationFor(
  definition: ConnectorNotificationTypeDefinition,
): Omit<NotificationPushRuleValues, 'templateKey'> {
  switch (definition.pushRecommendation) {
    case 'urgent_only':
      return {
        enabled: true,
        minLevel: 'urgent',
        preview: definition.defaultPreview,
        maxPerHour: null,
      };
    case 'action_needed_or_higher':
      return {
        enabled: true,
        minLevel: 'action_needed',
        preview: definition.defaultPreview,
        maxPerHour: null,
      };
    case 'off':
      return {
        enabled: false,
        minLevel: definition.defaultLevel,
        preview: definition.defaultPreview,
        maxPerHour: null,
      };
  }
}

export function resolveNotificationPushPolicy(
  input: ResolveNotificationPushPolicyInput,
): ResolvedNotificationPushPolicy {
  if (input.connectorDeleted) return disabledSystemPolicy('connector_deleted');
  if (input.connectorDisabled) return disabledSystemPolicy('connector_disabled');

  const templateKey = input.templateKey?.trim();
  if (!templateKey) return disabledSystemPolicy('missing_template_key');

  const definition = input.catalog.find(candidate => candidate.key === templateKey) ?? null;
  if (!definition) return disabledSystemPolicy('unknown_template_key');
  if (!definition.pushEligible) return disabledSystemPolicy('catalog_ineligible', definition);

  const rule = input.exactRule?.templateKey === templateKey
    ? input.exactRule
    : input.wildcardRule?.templateKey === '*'
      ? input.wildcardRule
      : null;
  const source: NotificationPushPolicySource = rule ? 'user' : 'connector';
  const sourceDetail: NotificationPushPolicySourceDetail = rule
    ? (rule.templateKey === '*' ? 'wildcard' : 'exact')
    : 'recommended';
  const values = rule ?? recommendationFor(definition);
  const preview = isPreviewSafeForType(definition, values.preview)
    ? values.preview
    : 'title_only';
  const shouldPush = values.enabled
    && notificationMeetsMinimumLevel(input.level, values.minLevel);

  return {
    eligible: true,
    enabled: values.enabled,
    shouldPush,
    minLevel: values.minLevel,
    preview,
    maxPerHour: values.maxPerHour,
    source,
    sourceDetail,
    ineligibilityReason: null,
    definition,
  };
}
