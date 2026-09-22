import { describe, expect, it } from 'vitest';
import type { NotificationLevel } from '@/types';
import {
  getNotificationLevelRank,
  normalizeNotificationLevel,
  notificationMeetsMinimumLevel,
} from '@/lib/notifications/levels';
import {
  NotificationCatalogValidationError,
  extractNotificationTemplateKey,
  parseLocalNotificationTypeCatalog,
  resolveNotificationPushPolicy,
  validateNotificationTypeCatalog,
  type ConnectorNotificationTypeDefinition,
  type NotificationPushRuleValues,
} from '@/lib/notifications/push-policy';
import {
  MAX_NOTIFICATION_PUSHES_PER_HOUR,
  validateNotificationPushRule,
} from '@/lib/notifications/push-policy/rules';
import { HOMELAB_NOTIFICATION_TYPES } from '@/lib/notifications/push-policy/catalogs';

const reviewRequested = {
  key: 'pr_review_requested',
  label: 'Review requested',
  description: 'A pull request needs review.',
  defaultLevel: 'action_needed',
  pushEligible: true,
  pushRecommendation: 'action_needed_or_higher',
  sensitivity: 'standard',
  defaultPreview: 'title_and_body',
} as const satisfies ConnectorNotificationTypeDefinition;

const sensitiveAlert = {
  key: 'security_alert',
  label: 'Security alert',
  description: 'A sensitive security alert.',
  defaultLevel: 'urgent',
  pushEligible: true,
  pushRecommendation: 'urgent_only',
  sensitivity: 'sensitive',
  defaultPreview: 'title_only',
} as const satisfies ConnectorNotificationTypeDefinition;

const digest = {
  key: 'weekly_digest',
  label: 'Weekly digest',
  description: 'A weekly summary.',
  defaultLevel: 'digest',
  pushEligible: false,
  pushRecommendation: 'off',
  sensitivity: 'standard',
  defaultPreview: 'title_only',
} as const satisfies ConnectorNotificationTypeDefinition;

const catalog = [reviewRequested, sensitiveAlert, digest];

function rule(
  templateKey: string,
  overrides: Partial<NotificationPushRuleValues> = {},
): NotificationPushRuleValues {
  return {
    templateKey,
    enabled: true,
    minLevel: 'heads_up',
    preview: 'title_and_body',
    maxPerHour: 12,
    ...overrides,
  };
}

describe('notification level ranks', () => {
  it('uses the canonical attention ordering', () => {
    const levels: NotificationLevel[] = [
      'urgent',
      'action_needed',
      'heads_up',
      'fyi',
      'digest',
    ];
    expect(levels.map(getNotificationLevelRank)).toEqual([0, 1, 2, 3, 4]);
  });

  it('includes levels at or above the configured minimum', () => {
    expect(notificationMeetsMinimumLevel('urgent', 'action_needed')).toBe(true);
    expect(notificationMeetsMinimumLevel('action_needed', 'action_needed')).toBe(true);
    expect(notificationMeetsMinimumLevel('heads_up', 'action_needed')).toBe(false);
  });

  it('normalizes legacy severities and unknown values through the same ranks', () => {
    expect(normalizeNotificationLevel('critical')).toEqual({
      level: 'urgent',
      levelRank: 0,
    });
    expect(normalizeNotificationLevel('medium')).toEqual({
      level: 'heads_up',
      levelRank: 2,
    });
    expect(normalizeNotificationLevel('not_known')).toEqual({
      level: 'digest',
      levelRank: 4,
    });
    expect(normalizeNotificationLevel('toString')).toEqual({
      level: 'digest',
      levelRank: 4,
    });
  });
});

describe('connector notification catalog validation', () => {
  it('returns an immutable validated catalog', () => {
    const validated = validateNotificationTypeCatalog('github-issues', catalog);
    expect(validated).toEqual(catalog);
    expect(Object.isFrozen(validated)).toBe(true);
    expect(Object.isFrozen(validated[0])).toBe(true);
  });

  it('validates the conservative Homelab notification catalog', () => {
    const validated = validateNotificationTypeCatalog(
      'homelab',
      HOMELAB_NOTIFICATION_TYPES,
    );
    expect(validated).toHaveLength(11);
    expect(validated.every(definition => definition.pushRecommendation === 'off')).toBe(true);
  });

  it.each([
    {
      name: 'non-snake-case keys',
      catalog: [{ ...reviewRequested, key: 'ReviewRequested' }],
      message: 'lowercase snake case',
    },
    {
      name: 'missing keys',
      catalog: [{ ...reviewRequested, key: undefined }],
      message: 'lowercase snake case',
    },
    {
      name: 'duplicate keys',
      catalog: [reviewRequested, reviewRequested],
      message: 'duplicates key',
    },
    {
      name: 'invalid levels',
      catalog: [{ ...reviewRequested, defaultLevel: 'high' }],
      message: 'defaultLevel "high" is invalid',
    },
    {
      name: 'recommendations on ineligible types',
      catalog: [{ ...digest, pushRecommendation: 'urgent_only' }],
      message: 'push-ineligible types must recommend "off"',
    },
    {
      name: 'non-boolean eligibility',
      catalog: [{ ...reviewRequested, pushEligible: 'yes' }],
      message: 'pushEligible must be a boolean',
    },
    {
      name: 'sensitive body previews',
      catalog: [{ ...sensitiveAlert, defaultPreview: 'title_and_body' }],
      message: 'sensitive types must default to "title_only"',
    },
    {
      name: 'negative cooldowns',
      catalog: [{ ...reviewRequested, cooldownSeconds: -1 }],
      message: 'cooldownSeconds must be a non-negative integer',
    },
  ])('rejects $name with an actionable error', ({ catalog: invalid, message }) => {
    expect(() => validateNotificationTypeCatalog(
      'test',
      invalid as ConnectorNotificationTypeDefinition[],
    )).toThrow(message);
  });

  it('rejects malformed locally configured catalogs deterministically', () => {
    expect(() => parseLocalNotificationTypeCatalog('custom-rest', {
      notificationTypeCatalog: [null],
    })).toThrow(NotificationCatalogValidationError);
  });

  it('reads custom REST and inbound webhook catalogs only from local settings', () => {
    const localSettings = { notificationTypeCatalog: [reviewRequested] };
    const remotePayload = {
      templateKey: 'remote_attempt',
      notificationTypeCatalog: [{ ...reviewRequested, key: 'remote_attempt' }],
    };

    expect(parseLocalNotificationTypeCatalog('custom-rest', localSettings)).toEqual([
      reviewRequested,
    ]);
    expect(parseLocalNotificationTypeCatalog('inbound-webhook', localSettings)).toEqual([
      reviewRequested,
    ]);
    expect(parseLocalNotificationTypeCatalog('inbound-webhook', {})).toEqual([]);
    expect(remotePayload.notificationTypeCatalog).not.toEqual(
      parseLocalNotificationTypeCatalog('inbound-webhook', localSettings),
    );
  });

  it('extracts a notification type without granting eligibility', () => {
    expect(extractNotificationTemplateKey({
      event_kind: ' door_open ',
      templateKey: 'fallback',
    }, 'event_kind')).toBe('door_open');
    expect(extractNotificationTemplateKey({ template_key: 'legacy_key' })).toBe('legacy_key');
    expect(extractNotificationTemplateKey({ templateKey: { pushEligible: true } })).toBeUndefined();
  });
});

describe('effective notification push policy', () => {
  it('resolves exact rules before wildcard rules', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'action_needed',
      catalog,
      exactRule: rule(reviewRequested.key, { enabled: false }),
      wildcardRule: rule('*', { enabled: true }),
    });

    expect(resolved).toMatchObject({
      eligible: true,
      enabled: false,
      shouldPush: false,
      source: 'user',
      sourceDetail: 'exact',
      ineligibilityReason: null,
    });
  });

  it('uses a connector-instance wildcard when no exact override exists', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'heads_up',
      catalog,
      wildcardRule: rule('*', { minLevel: 'action_needed' }),
    });

    expect(resolved).toMatchObject({
      source: 'user',
      sourceDetail: 'wildcard',
      enabled: true,
      shouldPush: false,
      minLevel: 'action_needed',
    });
  });

  it('inherits the current connector recommendation when overrides are absent', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'urgent',
      catalog,
    });

    expect(resolved).toMatchObject({
      source: 'connector',
      sourceDetail: 'recommended',
      enabled: true,
      shouldPush: true,
      minLevel: 'action_needed',
      preview: 'title_and_body',
    });
  });

  it('restores wildcard then recommended inheritance when exact overrides reset', () => {
    const exact = rule(reviewRequested.key, { enabled: false });
    const wildcard = rule('*', { enabled: true, minLevel: 'urgent' });
    const withExact = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'action_needed',
      catalog,
      exactRule: exact,
      wildcardRule: wildcard,
    });
    const afterExactReset = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'action_needed',
      catalog,
      wildcardRule: wildcard,
    });
    const afterAllReset = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'action_needed',
      catalog,
    });

    expect(withExact.sourceDetail).toBe('exact');
    expect(afterExactReset.sourceDetail).toBe('wildcard');
    expect(afterAllReset.sourceDetail).toBe('recommended');
  });

  it.each([
    ['missing template key', null, 'missing_template_key'],
    ['unknown template key', 'not_declared', 'unknown_template_key'],
    ['catalog-ineligible type', digest.key, 'catalog_ineligible'],
  ])('uses system-off for a %s', (_name, templateKey, reason) => {
    const resolved = resolveNotificationPushPolicy({
      templateKey,
      level: 'urgent',
      catalog,
      wildcardRule: rule('*'),
    });

    expect(resolved).toMatchObject({
      eligible: false,
      enabled: false,
      shouldPush: false,
      source: 'system',
      sourceDetail: 'system_off',
      ineligibilityReason: reason,
    });
  });

  it('makes soft-deleted connectors system-off even when an override exists', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'urgent',
      catalog,
      exactRule: rule(reviewRequested.key),
      connectorDeleted: true,
    });

    expect(resolved).toMatchObject({
      source: 'system',
      sourceDetail: 'system_off',
      ineligibilityReason: 'connector_deleted',
      enabled: false,
      shouldPush: false,
    });
  });

  it('makes disabled connectors system-off', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: reviewRequested.key,
      level: 'urgent',
      catalog,
      exactRule: rule(reviewRequested.key),
      connectorDisabled: true,
    });

    expect(resolved).toMatchObject({
      sourceDetail: 'system_off',
      ineligibilityReason: 'connector_disabled',
      enabled: false,
    });
  });

  it('defensively strips sensitive body previews from persisted rules', () => {
    const resolved = resolveNotificationPushPolicy({
      templateKey: sensitiveAlert.key,
      level: 'urgent',
      catalog,
      exactRule: rule(sensitiveAlert.key, { preview: 'title_and_body' }),
    });

    expect(resolved.preview).toBe('title_only');
    expect(resolved.shouldPush).toBe(true);
  });
});

describe('push rule validation', () => {
  it('allows exact and wildcard rules', () => {
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('pr_review_requested'),
    }, reviewRequested)).not.toThrow();
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('*', { preview: 'title_only' }),
    })).not.toThrow();
  });

  it('requires a catalog definition for exact rules', () => {
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('pr_review_requested'),
    })).toThrow('eligible catalog definition is required');
  });

  it('rejects unsafe sensitive previews and invalid rate limits', () => {
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('security_alert'),
    }, sensitiveAlert)).toThrow('does not allow body previews');
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('pr_review_requested', {
        maxPerHour: MAX_NOTIFICATION_PUSHES_PER_HOUR + 1,
      }),
    }, reviewRequested)).toThrow('maxPerHour');
  });

  it('rejects mismatched and push-ineligible definitions', () => {
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('pr_review_requested'),
    }, sensitiveAlert)).toThrow('does not match');
    expect(() => validateNotificationPushRule({
      connectorInstanceId: 'github-work',
      ...rule('weekly_digest', { preview: 'title_only' }),
    }, digest)).toThrow('not push-eligible');
  });
});
