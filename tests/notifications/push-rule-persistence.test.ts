import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  GITHUB_NOTIFICATION_TYPES,
} from '@/lib/notifications/push-policy/catalogs';
import type {
  ConnectorNotificationTypeDefinition,
} from '@/lib/notifications/push-policy/catalog';

process.env.MC_DB_PATH = ':memory:';
vi.unmock('drizzle-orm');

let db: typeof import('@/db').default;
let connectorConfigs: typeof import('@/db/schema').connectorConfigs;
let inboundWebhooks: typeof import('@/db/schema').inboundWebhooks;
let notificationPushRules: typeof import('@/db/schema').notificationPushRules;
let saveNotificationPushRule: typeof import(
  '@/lib/notifications/push-policy/rules'
).saveNotificationPushRule;
let resetNotificationPushRule: typeof import(
  '@/lib/notifications/push-policy/rules'
).resetNotificationPushRule;
let resolveStoredNotificationPushPolicy: typeof import(
  '@/lib/notifications/push-policy/resolver'
).resolveStoredNotificationPushPolicy;

const reviewRequested = GITHUB_NOTIFICATION_TYPES.find(
  definition => definition.key === 'pr_review_requested',
)!;
const doorOpen = {
  key: 'door_open',
  label: 'Door open',
  description: 'A monitored door is open.',
  defaultLevel: 'heads_up',
  pushEligible: true,
  pushRecommendation: 'off',
  sensitivity: 'standard',
  defaultPreview: 'title_only',
} as const satisfies ConnectorNotificationTypeDefinition;

beforeAll(async () => {
  ({ default: db } = await import('@/db'));
  ({ connectorConfigs, inboundWebhooks, notificationPushRules } = await import('@/db/schema'));
  ({ saveNotificationPushRule, resetNotificationPushRule } = await import(
    '@/lib/notifications/push-policy/rules'
  ));
  ({ resolveStoredNotificationPushPolicy } = await import(
    '@/lib/notifications/push-policy/resolver'
  ));

  await db.insert(connectorConfigs).values({
    id: 'github-work',
    type: 'github-issues',
    name: 'GitHub Work',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 5,
    capabilities: {},
    credentials: {},
    settings: {},
    syncedLists: [],
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  });
});

describe('notification push rule persistence', () => {
  it('resolves a missing template key without loading persisted rules', async () => {
    await db.insert(notificationPushRules).values({
      id: 'invalid-wildcard',
      connectorInstanceId: 'missing-key-connector',
      templateKey: '*',
      enabled: true,
      minLevel: 'not_a_level',
      preview: 'title_only',
      maxPerHour: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });

    await expect(resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'missing-key-connector',
      connectorType: 'custom-rest',
      templateKey: null,
      level: 'urgent',
    })).resolves.toMatchObject({
      sourceDetail: 'system_off',
      ineligibilityReason: 'missing_template_key',
      shouldPush: false,
    });
  });

  it('upserts one override per connector and template key', async () => {
    const first = await saveNotificationPushRule({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: 5,
    }, reviewRequested);
    const updated = await saveNotificationPushRule({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: false,
      minLevel: 'action_needed',
      preview: 'title_only',
      maxPerHour: null,
    }, reviewRequested);

    expect(updated.id).toBe(first.id);
    expect(updated).toMatchObject({
      enabled: false,
      minLevel: 'action_needed',
      maxPerHour: null,
    });
  });

  it('deleting overrides restores wildcard then connector inheritance', async () => {
    await saveNotificationPushRule({
      connectorInstanceId: 'github-work',
      templateKey: '*',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
    });
    await saveNotificationPushRule({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: false,
      minLevel: 'action_needed',
      preview: 'title_only',
    }, reviewRequested);

    const exact = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'github-work',
      connectorType: 'github-issues',
      templateKey: 'pr_review_requested',
      level: 'urgent',
    });
    await resetNotificationPushRule('github-work', 'pr_review_requested');
    const wildcard = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'github-work',
      connectorType: 'github-issues',
      templateKey: 'pr_review_requested',
      level: 'urgent',
    });
    await resetNotificationPushRule('github-work', '*');
    const recommended = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'github-work',
      connectorType: 'github-issues',
      templateKey: 'pr_review_requested',
      level: 'urgent',
    });

    expect(exact.sourceDetail).toBe('exact');
    expect(wildcard.sourceDetail).toBe('wildcard');
    expect(recommended).toMatchObject({
      source: 'connector',
      sourceDetail: 'recommended',
      enabled: false,
    });
  });

  it('keeps retained overrides disabled while a connector is soft-deleted', async () => {
    const { eq } = await import('drizzle-orm');
    await saveNotificationPushRule({
      connectorInstanceId: 'github-work',
      templateKey: 'pr_review_requested',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
    }, reviewRequested);
    db.update(connectorConfigs).set({
      deletedAt: '2026-08-02T01:00:00.000Z',
    }).where(eq(connectorConfigs.id, 'github-work')).run();

    const resolved = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'github-work',
      connectorType: 'github-issues',
      templateKey: 'pr_review_requested',
      level: 'urgent',
    });

    expect(resolved).toMatchObject({
      source: 'system',
      sourceDetail: 'system_off',
      ineligibilityReason: 'connector_deleted',
      enabled: false,
      shouldPush: false,
    });
  });

  it('resolves inbound webhook eligibility only from its local catalog', async () => {
    await db.insert(inboundWebhooks).values({
      id: 'webhook-local',
      name: 'Local webhook',
      sourceLabel: 'Automation',
      secret: null,
      enabled: true,
      defaultAction: 'alert',
      fieldMappings: {
        notificationTypeCatalog: [doorOpen],
      },
      totalReceived: 0,
      lastReceivedAt: null,
      lastStatus: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });
    await saveNotificationPushRule({
      connectorInstanceId: 'webhook-local',
      templateKey: 'door_open',
      enabled: true,
      minLevel: 'heads_up',
      preview: 'title_only',
    }, doorOpen);

    const known = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'webhook-local',
      connectorType: 'inbound-webhook',
      templateKey: 'door_open',
      level: 'urgent',
    });
    const payloadOnlyKey = await resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'webhook-local',
      connectorType: 'inbound-webhook',
      templateKey: 'payload_claimed_eligible',
      level: 'urgent',
    });

    expect(known).toMatchObject({
      sourceDetail: 'exact',
      enabled: true,
      shouldPush: true,
    });
    expect(payloadOnlyKey).toMatchObject({
      sourceDetail: 'system_off',
      ineligibilityReason: 'unknown_template_key',
      shouldPush: false,
    });
  });

  it('fails closed when a stored local catalog is malformed', async () => {
    await db.insert(inboundWebhooks).values({
      id: 'webhook-invalid-catalog',
      name: 'Invalid local webhook',
      sourceLabel: 'Automation',
      secret: null,
      enabled: true,
      defaultAction: 'alert',
      fieldMappings: {
        notificationTypeCatalog: [{
          ...doorOpen,
          defaultPreview: 'title_and_body',
          sensitivity: 'sensitive',
        }],
      },
      totalReceived: 0,
      lastReceivedAt: null,
      lastStatus: null,
      createdAt: '2026-08-02T00:00:00.000Z',
      updatedAt: '2026-08-02T00:00:00.000Z',
    });

    await expect(resolveStoredNotificationPushPolicy({
      connectorInstanceId: 'webhook-invalid-catalog',
      connectorType: 'inbound-webhook',
      templateKey: 'door_open',
      level: 'urgent',
    })).resolves.toMatchObject({
      sourceDetail: 'system_off',
      ineligibilityReason: 'unknown_template_key',
      shouldPush: false,
    });
  });
});
