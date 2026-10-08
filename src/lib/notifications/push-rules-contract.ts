import type { NotificationPushRule } from '@/db/persistence/notification-delivery';
import type {
  ConnectorNotificationTypeDefinition,
  PushPreview,
} from '@/lib/notifications/push-policy/catalog';
import type {
  NotificationPushPolicySource,
  NotificationPushPolicySourceDetail,
} from '@/lib/notifications/push-policy/policy';
import type { NotificationLevel } from '@/types';

export interface PushRulesGlobalStatus {
  pushDeliveryEnabled: boolean;
  doNotDisturb: boolean;
  quietStart: number | null;
  quietEnd: number | null;
  channelConfigured: boolean;
  subscriptionCount: number;
}

export interface EffectivePushRule {
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: number | null;
  source: NotificationPushPolicySource;
  sourceDetail: NotificationPushPolicySourceDetail;
}

export interface ConnectorPushRuleType {
  definition: ConnectorNotificationTypeDefinition;
  override: NotificationPushRule | null;
  effective: EffectivePushRule;
}

export interface ConnectorPushRuleGroup {
  connectorInstanceId: string;
  connectorType: string;
  connectorName: string;
  enabled: boolean;
  deletedAt: string | null;
  wildcardOverride: NotificationPushRule | null;
  notificationTypes: ConnectorPushRuleType[];
}

export interface PushRulesResponse {
  global: PushRulesGlobalStatus;
  connectors: ConnectorPushRuleGroup[];
}

export interface SavePushRuleRequest {
  connectorInstanceId: string;
  templateKey: string;
  enabled: boolean;
  minLevel: NotificationLevel;
  preview: PushPreview;
  maxPerHour: number | null;
}
