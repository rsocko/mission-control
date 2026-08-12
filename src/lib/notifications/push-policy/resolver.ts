import 'server-only';

import { eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import db from '@/db';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  inboundWebhooks,
  notificationPushRules,
} from '@/db/schema';
import type { ConnectorConfig, NotificationLevel } from '@/types';
import { connectorRegistry } from '@/lib/connectors';
import { connectorLogger } from '@/lib/logger';
import { isNotificationLevel } from '@/lib/notifications/levels';
import {
  isPushPreview,
  NotificationCatalogValidationError,
  parseLocalNotificationTypeCatalog,
  type ConnectorNotificationTypeDefinition,
} from './catalog';
import {
  resolveNotificationPushPolicy,
  type NotificationPushRuleValues,
} from './policy';
import {
  MAX_NOTIFICATION_PUSHES_PER_HOUR,
  type NotificationPushRule,
} from './rules';
import {
  financeNotificationCatalogKey,
  SYSTEM_NOTIFICATION_TYPES,
} from './catalogs';

interface ResolveStoredNotificationPushPolicyInput {
  connectorInstanceId: string;
  connectorType: string;
  templateKey?: string | null;
  level: NotificationLevel;
}

type NotificationPolicyDatabase = BetterSQLite3Database<typeof schema>;

interface StoredNotificationPushPolicyResolver {
  resolve: (
    input: ResolveStoredNotificationPushPolicyInput,
  ) => ReturnType<typeof resolveNotificationPushPolicy>;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseJsonArray(value: unknown): string[] {
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(item => typeof item === 'string') : [];
  }
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function toPolicyRule(rule: NotificationPushRule | null): NotificationPushRuleValues | null {
  if (!rule) return null;
  if (!isNotificationLevel(rule.minLevel) || !isPushPreview(rule.preview)) {
    throw new Error(`Stored notification push rule "${rule.id}" is invalid`);
  }
  if (
    rule.maxPerHour !== null
    && (
      !Number.isInteger(rule.maxPerHour)
      || rule.maxPerHour < 1
      || rule.maxPerHour > MAX_NOTIFICATION_PUSHES_PER_HOUR
    )
  ) {
    throw new Error(`Stored notification push rule "${rule.id}" has an invalid rate limit`);
  }
  return {
    templateKey: rule.templateKey,
    enabled: rule.enabled,
    minLevel: rule.minLevel,
    preview: rule.preview,
    maxPerHour: rule.maxPerHour,
  };
}

function safeCatalog(
  connectorInstanceId: string,
  load: () => readonly ConnectorNotificationTypeDefinition[],
): readonly ConnectorNotificationTypeDefinition[] {
  try {
    return load();
  } catch (error) {
    if (!(error instanceof NotificationCatalogValidationError)) throw error;
    connectorLogger.warn(
      { connectorInstanceId, err: error },
      'Ignoring invalid local notification catalog during push policy resolution',
    );
    return [];
  }
}

export async function resolveStoredNotificationPushPolicy(
  input: ResolveStoredNotificationPushPolicyInput,
) {
  return createStoredNotificationPushPolicyResolver(db).resolve(input);
}

export function createStoredNotificationPushPolicyResolver(
  database: NotificationPolicyDatabase = db,
): StoredNotificationPushPolicyResolver {
  const rulesByConnector = new Map<string, NotificationPushRule[]>();
  const connectorById = new Map<string, typeof connectorConfigs.$inferSelect | null>();
  const webhookById = new Map<string, typeof inboundWebhooks.$inferSelect | null>();

  return {
    resolve(input) {
      if (!input.templateKey?.trim()) {
        return resolveNotificationPushPolicy({
          ...input,
          catalog: [],
        });
      }

      let rules = rulesByConnector.get(input.connectorInstanceId);
      if (!rules) {
        rules = database.select().from(notificationPushRules).where(
          eq(notificationPushRules.connectorInstanceId, input.connectorInstanceId),
        ).all();
        rulesByConnector.set(input.connectorInstanceId, rules);
      }
      const policyTemplateKey = financeNotificationCatalogKey(input.templateKey);
      const exactRule = toPolicyRule(
        rules.find(rule => (
          rule.templateKey === input.templateKey
          || rule.templateKey === policyTemplateKey
        )) ?? null,
      );
      const wildcardRule = toPolicyRule(
        rules.find(rule => rule.templateKey === '*') ?? null,
      );

      if (input.connectorType === 'system' && input.connectorInstanceId === 'push-triggers') {
        const definition = SYSTEM_NOTIFICATION_TYPES.find(
          candidate => candidate.key === input.templateKey,
        );
        const systemDefault = definition
          ? {
              templateKey: definition.key,
              enabled: true,
              minLevel: definition.defaultLevel,
              preview: definition.defaultPreview,
              maxPerHour: null,
            } satisfies NotificationPushRuleValues
          : null;
        const resolved = resolveNotificationPushPolicy({
          ...input,
          catalog: SYSTEM_NOTIFICATION_TYPES,
          exactRule: exactRule ?? (wildcardRule ? null : systemDefault),
          wildcardRule,
        });
        return exactRule || wildcardRule || !resolved.eligible
          ? resolved
          : {
              ...resolved,
              source: 'connector' as const,
              sourceDetail: 'recommended' as const,
            };
      }

      if (input.connectorType === 'inbound-webhook') {
        let webhook = webhookById.get(input.connectorInstanceId);
        if (webhook === undefined) {
          webhook = database.select().from(inboundWebhooks).where(
            eq(inboundWebhooks.id, input.connectorInstanceId),
          ).get() ?? null;
          webhookById.set(input.connectorInstanceId, webhook);
        }
        const catalog = webhook
          ? safeCatalog(input.connectorInstanceId, () => (
              parseLocalNotificationTypeCatalog('inbound-webhook', webhook.fieldMappings)
            ))
          : [];
        return resolveNotificationPushPolicy({
          ...input,
          catalog,
          exactRule,
          wildcardRule,
          connectorDeleted: !webhook,
          connectorDisabled: webhook ? !webhook.enabled : false,
        });
      }

      let connector = connectorById.get(input.connectorInstanceId);
      if (connector === undefined) {
        connector = database.select().from(connectorConfigs).where(
          eq(connectorConfigs.id, input.connectorInstanceId),
        ).get() ?? null;
        connectorById.set(input.connectorInstanceId, connector);
      }
      if (!connector) {
        return resolveNotificationPushPolicy({
          ...input,
          catalog: [],
          exactRule,
          wildcardRule,
          connectorDeleted: true,
        });
      }

      const config: ConnectorConfig = {
        id: connector.id,
        type: connector.type,
        name: connector.name,
        enabled: connector.enabled,
        syncMode: connector.syncMode as ConnectorConfig['syncMode'],
        pollIntervalMinutes: connector.pollIntervalMinutes ?? undefined,
        capabilities: parseJsonObject(connector.capabilities) as unknown as ConnectorConfig['capabilities'],
        credentials: parseJsonObject(connector.credentials) as Record<string, string>,
        settings: parseJsonObject(connector.settings),
        syncedLists: parseJsonArray(connector.syncedLists),
      };
      const catalog = safeCatalog(input.connectorInstanceId, () => (
        connectorRegistry.getNotificationTypeCatalog(connector.type, config)
      ));

      return resolveNotificationPushPolicy({
        ...input,
        templateKey: policyTemplateKey,
        catalog,
        exactRule: exactRule ? { ...exactRule, templateKey: policyTemplateKey } : null,
        wildcardRule,
        connectorDeleted: connector.deletedAt !== null,
        connectorDisabled: !connector.enabled,
      });
    },
  };
}
