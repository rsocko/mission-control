import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { connectorRegistry } from '@/lib/connectors';
import {
  resetNotificationPushRule,
  saveNotificationPushRule,
  validateNotificationPushRule,
} from '@/lib/notifications/push-policy/rules';
import {
  resolveNotificationPushPolicy,
} from '@/lib/notifications/push-policy/policy';
import type {
  ConnectorNotificationTypeDefinition,
} from '@/lib/notifications/push-policy/catalog';
import {
  isPushPreview,
  isPreviewSafeForType,
} from '@/lib/notifications/push-policy/catalog';
import { isNotificationLevel } from '@/lib/notifications/levels';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  ConnectorOperationBusyError,
  runWithConnectorOperationLease,
} from '@/lib/sync/connector-lock';
import type {
  ManagedConnectorRecord,
} from '@/db/persistence/connector-management';
import type {
  NotificationPushRule,
  SaveNotificationPushRuleInput,
} from '@/db/persistence/notification-delivery';
import type {
  ConnectorPushRuleGroup,
  PushRulesResponse,
} from '@/lib/notifications/push-rules-contract';

class PushRuleRequestError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 = 400,
  ) {
    super(message);
  }
}

function catalogFor(
  connector: ManagedConnectorRecord,
): readonly ConnectorNotificationTypeDefinition[] {
  return connectorRegistry.getNotificationTypeCatalog(connector.type, {
    settings: connector.settings,
  });
}

function eligibleCatalogFor(
  connector: ManagedConnectorRecord,
): readonly ConnectorNotificationTypeDefinition[] {
  return catalogFor(connector).filter(definition => definition.pushEligible);
}

function findConnector(
  connectors: readonly ManagedConnectorRecord[],
  connectorInstanceId: string,
): ManagedConnectorRecord | null {
  return connectors.find(connector => connector.id === connectorInstanceId) ?? null;
}

function requireEditableConnector(
  connectors: readonly ManagedConnectorRecord[],
  connectorInstanceId: unknown,
): ManagedConnectorRecord {
  if (typeof connectorInstanceId !== 'string' || !connectorInstanceId.trim()) {
    throw new PushRuleRequestError('connectorInstanceId is required');
  }
  const connector = findConnector(connectors, connectorInstanceId);
  if (!connector || connector.deletedAt) {
    throw new PushRuleRequestError('Connector not found', 404);
  }
  return connector;
}

function parseSaveInput(
  value: unknown,
  connectors: readonly ManagedConnectorRecord[],
): {
  input: SaveNotificationPushRuleInput;
  definition?: ConnectorNotificationTypeDefinition;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PushRuleRequestError('Request body must be an object');
  }
  const body = value as Record<string, unknown>;
  const expectedKeys = new Set([
    'connectorInstanceId',
    'templateKey',
    'enabled',
    'minLevel',
    'preview',
    'maxPerHour',
  ]);
  const unknownKey = Object.keys(body).find(key => !expectedKeys.has(key));
  if (unknownKey) {
    throw new PushRuleRequestError(`Unknown field "${unknownKey}"`);
  }
  const missingKey = [...expectedKeys].find(key => !(key in body));
  if (missingKey) {
    throw new PushRuleRequestError(`${missingKey} is required`);
  }
  const connector = requireEditableConnector(connectors, body.connectorInstanceId);
  if (typeof body.templateKey !== 'string' || !body.templateKey.trim()) {
    throw new PushRuleRequestError('templateKey is required');
  }
  if (typeof body.enabled !== 'boolean') {
    throw new PushRuleRequestError('enabled must be a boolean');
  }
  if (!isNotificationLevel(body.minLevel)) {
    throw new PushRuleRequestError('minLevel is invalid');
  }
  if (!isPushPreview(body.preview)) {
    throw new PushRuleRequestError('preview is invalid');
  }
  const preview = body.preview;
  if (
    body.maxPerHour !== null
    && typeof body.maxPerHour !== 'number'
  ) {
    throw new PushRuleRequestError('maxPerHour must be null or a number');
  }

  const catalog = eligibleCatalogFor(connector);
  if (catalog.length === 0) {
    throw new PushRuleRequestError('Connector has no push-eligible notification types');
  }
  const definition = body.templateKey === '*'
    ? undefined
    : catalog.find(candidate => candidate.key === body.templateKey);
  if (body.templateKey !== '*' && !definition) {
    throw new PushRuleRequestError(
      `Notification type "${body.templateKey}" is not declared push-eligible`,
    );
  }
  if (
    body.templateKey === '*'
    && preview === 'title_and_body'
    && catalog.some(candidate => !isPreviewSafeForType(candidate, preview))
  ) {
    throw new PushRuleRequestError(
      'Wildcard rules cannot enable body previews for sensitive notification types',
    );
  }

  const input: SaveNotificationPushRuleInput = {
    connectorInstanceId: connector.id,
    templateKey: body.templateKey,
    enabled: body.enabled,
    minLevel: body.minLevel,
    preview,
    maxPerHour: body.maxPerHour ?? null,
  };
  try {
    validateNotificationPushRule(input, definition);
  } catch (error) {
    throw new PushRuleRequestError(
      error instanceof Error ? error.message : 'Invalid push rule',
    );
  }
  return { input, definition };
}

function toConnectorGroup(
  connector: ManagedConnectorRecord,
  overrides: readonly NotificationPushRule[],
): ConnectorPushRuleGroup | null {
  const catalog = eligibleCatalogFor(connector);
  if (catalog.length === 0) return null;

  const wildcardOverride = overrides.find(rule => rule.templateKey === '*') ?? null;
  return {
    connectorInstanceId: connector.id,
    connectorType: connector.type,
    connectorName: connector.name,
    enabled: connector.enabled,
    deletedAt: connector.deletedAt,
    wildcardOverride,
    notificationTypes: catalog.map(definition => {
      const override = overrides.find(rule => rule.templateKey === definition.key) ?? null;
      const effective = resolveNotificationPushPolicy({
        templateKey: definition.key,
        level: definition.defaultLevel,
        catalog,
        exactRule: override,
        wildcardRule: wildcardOverride,
        connectorDeleted: connector.deletedAt !== null,
        connectorDisabled: !connector.enabled,
      });
      return {
        definition,
        override,
        effective: {
          enabled: effective.enabled,
          minLevel: effective.minLevel,
          preview: effective.preview,
          maxPerHour: effective.maxPerHour,
          source: effective.source,
          sourceDetail: effective.sourceDetail,
        },
      };
    }),
  };
}

async function listConnectors(includeDeleted: boolean): Promise<ManagedConnectorRecord[]> {
  return (await getConnectorManagementPersistence()).getOverview(includeDeleted)
    .then(overview => overview.connectors);
}

export async function GET() {
  try {
    const [connectors, repositories] = await Promise.all([
      listConnectors(false),
      getWorkerPersistenceRepositories(),
    ]);
    const [preferences, pushDeliveryEnabled, subscriptions, overrideGroups] = await Promise.all([
      repositories.notificationDelivery.push.getPreferences(),
      repositories.notificationDelivery.push.getPushDeliveryEnabled(),
      repositories.notificationDelivery.listWebPushSubscriptions(),
      Promise.all(connectors.map(connector => (
        repositories.notificationDelivery.pushRules.listOverrides(connector.id)
      ))),
    ]);
    const response: PushRulesResponse = {
      global: {
        pushDeliveryEnabled,
        doNotDisturb: preferences.doNotDisturb,
        quietStart: preferences.quietStart,
        quietEnd: preferences.quietEnd,
        channelConfigured: Boolean(
          process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY,
        ),
        subscriptionCount: subscriptions.length,
      },
      connectors: connectors
        .map((connector, index) => toConnectorGroup(connector, overrideGroups[index] ?? []))
        .filter((group): group is ConnectorPushRuleGroup => group !== null),
    };
    return NextResponse.json(response);
  } catch (error) {
    return ApiErrors.internal('Failed to load connector push rules', error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as unknown;
    const bodyRecord = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : null;
    if (
      !bodyRecord
      || typeof bodyRecord.connectorInstanceId !== 'string'
    ) {
      throw new PushRuleRequestError('connectorInstanceId is required');
    }
    const connectorInstanceId = bodyRecord.connectorInstanceId;
    const rule = await runWithConnectorOperationLease(
      connectorInstanceId,
      'retention',
      async () => {
        const parsed = parseSaveInput(body, await listConnectors(true));
        return saveNotificationPushRule(parsed.input, parsed.definition);
      },
    );
    return NextResponse.json({ rule });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return ApiErrors.badRequest('Request body must be valid JSON');
    }
    if (error instanceof PushRuleRequestError) {
      return error.status === 404
        ? ApiErrors.notFound('Connector')
        : ApiErrors.badRequest(error.message);
    }
    if (error instanceof ConnectorOperationBusyError) {
      return ApiErrors.conflict('Connector has an active operation');
    }
    return ApiErrors.internal('Failed to save connector push rule', error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const connectorInstanceId = searchParams.get('connectorInstanceId');
    if (!connectorInstanceId?.trim()) {
      throw new PushRuleRequestError('connectorInstanceId is required');
    }
    const templateKey = searchParams.get('templateKey');
    if (!templateKey?.trim()) {
      throw new PushRuleRequestError('templateKey is required');
    }
    await runWithConnectorOperationLease(connectorInstanceId, 'retention', async () => {
      const currentConnector = requireEditableConnector(
        await listConnectors(true),
        connectorInstanceId,
      );
      const currentEligibleKeys = new Set(
        eligibleCatalogFor(currentConnector).map(definition => definition.key),
      );
      if (currentEligibleKeys.size === 0) {
        throw new PushRuleRequestError('Connector has no push-eligible notification types');
      }
      if (templateKey !== '*' && !currentEligibleKeys.has(templateKey)) {
        throw new PushRuleRequestError(
          `Notification type "${templateKey}" is not declared push-eligible`,
        );
      }
      await resetNotificationPushRule(currentConnector.id, templateKey);
    });
    return NextResponse.json({ status: 'reset' });
  } catch (error) {
    if (error instanceof PushRuleRequestError) {
      return error.status === 404
        ? ApiErrors.notFound('Connector')
        : ApiErrors.badRequest(error.message);
    }
    if (error instanceof ConnectorOperationBusyError) {
      return ApiErrors.conflict('Connector has an active operation');
    }
    return ApiErrors.internal('Failed to reset connector push rule', error);
  }
}
