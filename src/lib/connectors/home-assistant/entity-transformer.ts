/**
 * Home Assistant entity-to-alert transformation logic.
 */

import type { InboundNotification, NotificationLevel } from '@/types';
import type { HomeAssistantState } from './ha-client';

export interface AlertRule {
  id: string;
  entityPattern: string;
  condition: 'equals' | 'above' | 'below' | 'changed';
  value?: string;
  level: NotificationLevel;
  category: string;
  title: string;
  cooldownMinutes?: number;
}

const PACKAGE_CATEGORY = 'shipment';
const PACKAGE_LEVEL: NotificationLevel = 'digest';

export function matchPattern(entityId: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
  return regex.test(entityId);
}

export function matchesPatterns(entityId: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchPattern(entityId, pattern));
}

export function evaluateCondition(entity: HomeAssistantState, rule: AlertRule, since?: Date): boolean {
  if (since && !hasChangedSince(entity, since)) {
    return false;
  }

  const state = entity.state.toLowerCase();
  const comparisonValue = (rule.value || '').toLowerCase();

  switch (rule.condition) {
    case 'equals':
      return state === comparisonValue;
    case 'above':
      return toNumber(entity.state) > toNumber(rule.value);
    case 'below':
      return toNumber(entity.state) < toNumber(rule.value);
    case 'changed':
      return hasChangedSince(entity, since ?? new Date(0));
    default:
      return false;
  }
}

export function buildRuleNotification(
  entity: HomeAssistantState,
  rule: AlertRule,
  connectorType: string,
  connectorInstanceId: string,
): InboundNotification {
  const changedAt = entity.last_changed || entity.last_updated || new Date().toISOString();
  const eventKey = buildRuleEventKey(rule, changedAt);
  return {
    id: buildAlertId('rule', rule.id, entity.entity_id, eventKey),
    sourceId: entity.entity_id,
    connectorType,
    connectorInstanceId,
    title: renderTemplate(rule.title, entity),
    body: buildRuleBody(entity, rule),
    level: rule.level,
    category: rule.category,
    isRead: false,
    isActionable: false,
    actionUrl: undefined,
    receivedAt: changedAt,
    expiresAt: undefined,
    relatedTaskId: undefined,
    hubProjectIds: [],
    tags: [],
    metadata: {
      entityId: entity.entity_id,
      state: entity.state,
      attributes: entity.attributes || {},
      ruleId: rule.id,
      cooldownMinutes: rule.cooldownMinutes ?? null,
      lastChanged: entity.last_changed,
      lastUpdated: entity.last_updated,
    },
  };
}

export function checkPackages(
  states: HomeAssistantState[],
  since: Date | undefined,
  connectorType: string,
  connectorInstanceId: string,
): InboundNotification[] {
  const notifications: InboundNotification[] = [];

  for (const entity of states) {
    const count = toNumber(entity.state);
    if (count <= 0) continue;
    if (since && !hasChangedSince(entity, since)) continue;

    const entityId = entity.entity_id.toLowerCase();
    const changedAt = entity.last_changed || entity.last_updated || new Date().toISOString();
    const carrier = extractCarrier(entity.entity_id);

    if (entityId.includes('packages_out_for_delivery') || entityId.includes('delivering')) {
      notifications.push(buildPackageNotification({
        id: buildAlertId('package-out', entity.entity_id, entity.state, changedAt),
        sourceId: entity.entity_id,
        title: `📦 ${count} package${count === 1 ? '' : 's'} out for delivery`,
        body: carrier ? `${carrier} reports ${count} package${count === 1 ? '' : 's'} out for delivery.` : undefined,
        receivedAt: changedAt,
        level: PACKAGE_LEVEL,
        category: PACKAGE_CATEGORY,
        metadata: { carrier, count, kind: 'out_for_delivery', entityId: entity.entity_id },
        connectorType,
        connectorInstanceId,
      }));
      continue;
    }

    if (entityId.includes('packages_delivered')) {
      notifications.push(buildPackageNotification({
        id: buildAlertId('package-delivered', entity.entity_id, entity.state, changedAt),
        sourceId: entity.entity_id,
        title: carrier ? `✅ Package delivered — ${carrier}` : `✅ ${count} package${count === 1 ? '' : 's'} delivered`,
        body: `Home Assistant reports ${count} delivered package${count === 1 ? '' : 's'}${carrier ? ` via ${carrier}` : ''}.`,
        receivedAt: changedAt,
        level: PACKAGE_LEVEL,
        category: PACKAGE_CATEGORY,
        expiresAt: new Date(Date.parse(changedAt) + 24 * 60 * 60 * 1000).toISOString(),
        metadata: { carrier, count, kind: 'delivered', entityId: entity.entity_id, autoDismissHours: 24 },
        connectorType,
        connectorInstanceId,
      }));
      continue;
    }

    if (entityId.includes('mail') && entityId.includes('packages_in_transit')) {
      notifications.push(buildPackageNotification({
        id: buildAlertId('package-transit', entity.entity_id, entity.state, changedAt),
        sourceId: entity.entity_id,
        title: `📦 ${count} package${count === 1 ? '' : 's'} in transit`,
        body: carrier ? `${carrier} has ${count} package${count === 1 ? '' : 's'} in transit.` : undefined,
        receivedAt: changedAt,
        level: PACKAGE_LEVEL,
        category: PACKAGE_CATEGORY,
        metadata: { carrier, count, kind: 'in_transit', entityId: entity.entity_id },
        connectorType,
        connectorInstanceId,
      }));
      continue;
    }

    if (entityId.endsWith('today_mail') || entityId.includes('mail_pieces')) {
      notifications.push(buildPackageNotification({
        id: buildAlertId('mail-arriving', entity.entity_id, entity.state, changedAt),
        sourceId: entity.entity_id,
        title: `📬 ${count} mail piece${count === 1 ? '' : 's'} arriving today`,
        body: `Home Assistant reports ${count} incoming mail piece${count === 1 ? '' : 's'} today.`,
        receivedAt: changedAt,
        level: 'fyi',
        category: PACKAGE_CATEGORY,
        metadata: { count, kind: 'mail', entityId: entity.entity_id },
        connectorType,
        connectorInstanceId,
      }));
    }
  }

  return notifications;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

export function hasChangedSince(entity: HomeAssistantState, since: Date): boolean {
  const timestamp = entity.last_changed || entity.last_updated;
  if (!timestamp) return true;
  const changedMs = Date.parse(timestamp);
  return Number.isFinite(changedMs) ? changedMs > since.getTime() : true;
}

function extractCarrier(entityId: string): string | undefined {
  const match = entityId.match(/^sensor\.mail_([a-z0-9]+)_packages_/i);
  return match?.[1] ? match[1].toUpperCase() : undefined;
}

function renderTemplate(template: string, entity: HomeAssistantState): string {
  const friendlyName = readString(entity.attributes?.friendly_name) || entity.entity_id;
  const context: Record<string, string> = {
    friendly_name: friendlyName,
    state: entity.state,
    entity_id: entity.entity_id,
    unit_of_measurement: readString(entity.attributes?.unit_of_measurement) || '',
  };

  return template.replace(/\{\{\s*([\w_]+)\s*\}\}/g, (_, key: string) => context[key] || '');
}

function buildAlertId(...parts: string[]): string {
  return parts
    .map((part) => part.replace(/[^a-zA-Z0-9:_-]+/g, '-'))
    .join(':');
}

function buildRuleEventKey(rule: AlertRule, changedAt: string): string {
  const changedMs = Date.parse(changedAt);
  if (!Number.isFinite(changedMs) || !rule.cooldownMinutes || rule.cooldownMinutes <= 0) {
    return changedAt;
  }
  const cooldownMs = rule.cooldownMinutes * 60 * 1000;
  return String(Math.floor(changedMs / cooldownMs));
}

function buildRuleBody(entity: HomeAssistantState, rule: AlertRule): string | undefined {
  const pieces = [
    `Entity: ${entity.entity_id}`,
    `State: ${entity.state}`,
    rule.value ? `Rule: ${rule.condition} ${rule.value}` : `Rule: ${rule.condition}`,
  ];
  return pieces.join(' • ');
}

function buildPackageNotification({
  id,
  sourceId,
  title,
  body,
  receivedAt,
  level,
  category,
  expiresAt,
  metadata,
  connectorType,
  connectorInstanceId,
}: {
  id: string;
  sourceId: string;
  title: string;
  body?: string;
  receivedAt: string;
  level: NotificationLevel;
  category: string;
  expiresAt?: string;
  metadata: Record<string, unknown>;
  connectorType: string;
  connectorInstanceId: string;
}): InboundNotification {
  return {
    id,
    sourceId,
    connectorType,
    connectorInstanceId,
    title,
    body,
    level,
    category,
    isRead: false,
    isActionable: false,
    actionUrl: undefined,
    receivedAt,
    expiresAt,
    relatedTaskId: undefined,
    hubProjectIds: [],
    tags: [],
    metadata,
  };
}

function toNumber(value: string | undefined): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
