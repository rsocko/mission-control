import type { NotificationLevel } from '@/types';
import { isNotificationLevel } from '@/lib/notifications/levels';

export type PushRecommendation = 'off' | 'urgent_only' | 'action_needed_or_higher';
export type PushPreview = 'title_only' | 'title_and_body';
export type NotificationSensitivity = 'standard' | 'sensitive';

export interface ConnectorNotificationTypeDefinition {
  key: string;
  label: string;
  description: string;
  defaultLevel: NotificationLevel;
  pushEligible: boolean;
  pushRecommendation: PushRecommendation;
  sensitivity: NotificationSensitivity;
  defaultPreview: PushPreview;
  cooldownSeconds?: number;
}

const KEY_PATTERN = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
const RECOMMENDATIONS = new Set<PushRecommendation>([
  'off',
  'urgent_only',
  'action_needed_or_higher',
]);
const SENSITIVITIES = new Set<NotificationSensitivity>(['standard', 'sensitive']);
const PREVIEWS = new Set<PushPreview>(['title_only', 'title_and_body']);

export class NotificationCatalogValidationError extends Error {
  constructor(connectorType: string, issues: readonly string[]) {
    super(`Invalid notification catalog for "${connectorType}": ${issues.join('; ')}`);
    this.name = 'NotificationCatalogValidationError';
  }
}

export function validateNotificationTypeCatalog(
  connectorType: string,
  catalog: readonly ConnectorNotificationTypeDefinition[],
): readonly ConnectorNotificationTypeDefinition[] {
  if (!Array.isArray(catalog)) {
    throw new NotificationCatalogValidationError(connectorType, ['catalog must be an array']);
  }
  const issues: string[] = [];
  const keys = new Set<string>();

  catalog.forEach((candidate, index) => {
    const prefix = `entry ${index + 1}`;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      issues.push(`${prefix} must be an object`);
      return;
    }
    const definition = candidate as ConnectorNotificationTypeDefinition;
    if (typeof definition.key !== 'string' || !KEY_PATTERN.test(definition.key)) {
      issues.push(`${prefix} key "${definition.key}" must be lowercase snake case`);
    } else if (keys.has(definition.key)) {
      issues.push(`${prefix} duplicates key "${definition.key}"`);
    }
    keys.add(definition.key);

    if (typeof definition.label !== 'string' || !definition.label.trim()) {
      issues.push(`${prefix} label is required`);
    }
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
      issues.push(`${prefix} description is required`);
    }
    if (!isNotificationLevel(definition.defaultLevel)) {
      issues.push(`${prefix} defaultLevel "${String(definition.defaultLevel)}" is invalid`);
    }
    if (typeof definition.pushEligible !== 'boolean') {
      issues.push(`${prefix} pushEligible must be a boolean`);
    }
    if (!RECOMMENDATIONS.has(definition.pushRecommendation)) {
      issues.push(`${prefix} pushRecommendation "${String(definition.pushRecommendation)}" is invalid`);
    }
    if (!SENSITIVITIES.has(definition.sensitivity)) {
      issues.push(`${prefix} sensitivity "${String(definition.sensitivity)}" is invalid`);
    }
    if (!PREVIEWS.has(definition.defaultPreview)) {
      issues.push(`${prefix} defaultPreview "${String(definition.defaultPreview)}" is invalid`);
    }
    if (!definition.pushEligible && definition.pushRecommendation !== 'off') {
      issues.push(`${prefix} push-ineligible types must recommend "off"`);
    }
    if (definition.sensitivity === 'sensitive' && definition.defaultPreview !== 'title_only') {
      issues.push(`${prefix} sensitive types must default to "title_only"`);
    }
    if (
      definition.cooldownSeconds !== undefined
      && (!Number.isInteger(definition.cooldownSeconds) || definition.cooldownSeconds < 0)
    ) {
      issues.push(`${prefix} cooldownSeconds must be a non-negative integer`);
    }
  });

  if (issues.length > 0) throw new NotificationCatalogValidationError(connectorType, issues);
  return Object.freeze(catalog.map(definition => Object.freeze({ ...definition })));
}

export function parseLocalNotificationTypeCatalog(
  connectorType: string,
  settings: unknown,
): readonly ConnectorNotificationTypeDefinition[] {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return Object.freeze([]);
  const value = (settings as Record<string, unknown>).notificationTypeCatalog;
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new NotificationCatalogValidationError(connectorType, [
      'notificationTypeCatalog must be an array',
    ]);
  }
  return validateNotificationTypeCatalog(
    connectorType,
    value as ConnectorNotificationTypeDefinition[],
  );
}

export function extractNotificationTemplateKey(
  payload: Record<string, unknown>,
  configuredField?: unknown,
): string | undefined {
  const field = typeof configuredField === 'string' && configuredField.trim()
    ? configuredField.trim()
    : 'templateKey';
  const candidates = [
    payload[field],
    payload.templateKey,
    payload.template_key,
  ];
  const key = candidates.find(candidate => typeof candidate === 'string' && candidate.trim());
  return typeof key === 'string' ? key.trim() : undefined;
}

export function isPushPreview(value: unknown): value is PushPreview {
  return typeof value === 'string' && PREVIEWS.has(value as PushPreview);
}

export function isPreviewSafeForType(
  definition: ConnectorNotificationTypeDefinition,
  preview: PushPreview,
): boolean {
  return preview === 'title_only' || definition.sensitivity === 'standard';
}
