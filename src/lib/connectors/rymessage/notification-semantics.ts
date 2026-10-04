import type { NotificationLevel } from '@/types';

const FOCUS_TYPES = new Set([
  'action-required',
  'delivery',
  'financial',
  'needs-reply',
  'question',
  'repeated-ask',
  'scheduling',
  'security-code',
  'shipping-delivery',
  'travel',
]);

const SAFE_TYPES = new Set([
  'commitment',
  'snoozed-chat',
  'waiting-on-action',
  'waiting-on-reply',
]);

export function normalizeRyMessageSemanticType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return normalized || null;
}

export function resolveRyMessageSemanticType(
  category: unknown,
  actionType: unknown,
): string | null {
  return normalizeRyMessageSemanticType(category)
    ?? normalizeRyMessageSemanticType(actionType);
}

export function ryMessageNotificationLevel(input: {
  priority: unknown;
  semanticType: string | null;
  confidenceClass: unknown;
}): NotificationLevel {
  switch (normalizeRyMessageSemanticType(input.priority)) {
    case 'critical': return 'urgent';
    case 'high': return 'action_needed';
    case 'medium': return 'heads_up';
    case 'low': return 'fyi';
  }

  if (input.semanticType === 'critical-alert') return 'urgent';
  if (input.semanticType && FOCUS_TYPES.has(input.semanticType)) return 'action_needed';
  if (input.semanticType && SAFE_TYPES.has(input.semanticType)) return 'heads_up';

  switch (normalizeRyMessageSemanticType(input.confidenceClass)) {
    case 'high': return 'heads_up';
    case 'medium': return 'fyi';
    default: return 'fyi';
  }
}

export function ryMessageNotificationCategory(semanticType: string | null): string {
  switch (semanticType) {
    case 'critical-alert':
    case 'security-code':
    case 'security':
      return 'security';
    case 'delivery':
    case 'shipping-delivery':
      return 'packages';
    case 'financial':
    case 'finance':
      return 'finance';
    case 'automation':
      return 'automation';
    case 'development':
      return 'development';
    default:
      return 'social';
  }
}
