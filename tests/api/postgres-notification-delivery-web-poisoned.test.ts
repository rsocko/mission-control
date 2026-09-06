import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import {
  createPostgresCoreRepositories,
  createPostgresWorkerPersistenceRepositories,
} from '@/db/postgres/repositories';
import { createPostgresNotificationsInTransaction } from '@/db/postgres/repositories/notification-delivery-repository';
import {
  clearWorkerPersistenceRepositories,
  registerWorkerPersistenceRepositories,
} from '@/lib/persistence/worker-runtime';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import { resetProcessRuntimeRegistries } from '../helpers/process-runtime-registries';

vi.unmock('drizzle-orm');

const sqliteTouch = vi.hoisted(() => vi.fn());
vi.mock('@/db', () => {
  sqliteTouch();
  throw new Error('SQLite must not load in PostgreSQL notification delivery routes');
});
vi.mock('@/db/schema', () => {
  sqliteTouch();
  throw new Error('SQLite schema must not load in PostgreSQL notification delivery routes');
});
vi.mock('better-sqlite3', () => {
  sqliteTouch();
  throw new Error('SQLite driver must not load in PostgreSQL notification delivery routes');
});
vi.mock('drizzle-orm/better-sqlite3', () => {
  sqliteTouch();
  throw new Error('SQLite dialect must not load in PostgreSQL notification delivery routes');
});
vi.mock('@/lib/api/trusted-request', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/api/trusted-request')>(),
  isTrustedMutationRequest: () => true,
}));
vi.mock('@/lib/notifications/dispatcher-wake', () => ({
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));
vi.mock('@/lib/ai/features/notification-classifier', () => ({
  classifyNotificationItems: vi.fn(async items => ({ items })),
}));
vi.mock('@/lib/notifications/enrichment', () => ({
  enrichAlert: vi.fn(async item => ({
    ...item,
    body: item.body ?? null,
    templateKey: null,
    relatedTaskId: null,
    relatedProjectId: null,
    relatedEntityType: null,
    relatedEntityId: null,
    navigationTarget: '/notifications',
    metadata: item.metadata,
    presentation: {},
    providerSignature: null,
    actions: [],
  })),
}));
vi.mock('@/lib/notifications/providers', () => ({
  executeNotificationProviderAction: vi.fn(async () => null),
  materializeNotificationActions: vi.fn(() => []),
  normalizeInternalNavigationTarget: (value: unknown) => (
    typeof value === 'string' && value.startsWith('/') ? value : null
  ),
  normalizeNotificationUrl: (value: unknown) => (
    typeof value === 'string' && /^https?:\/\//.test(value) ? value : null
  ),
  registerDefaultNotificationProviders: vi.fn(),
}));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);
const suffix = randomUUID();
const integrationId = `notification-parity-${suffix}`;
const actionNotificationId = `notification-action-${suffix}`;
const actionId = `open-url-${suffix}`;
const enrichmentNotificationId = `notification-enrichment-${suffix}`;
const rateLimitSubscriptionId = `notification-rate-limit-${suffix}`;
const webhookFingerprint = suffix.replaceAll('-', '');

let backend: PostgresPersistenceBackend;
let repositories: ReturnType<typeof createPostgresWorkerPersistenceRepositories>;

async function cleanFixtures() {
  const sourceIds = [
    `source:${actionNotificationId}`,
    `source:${enrichmentNotificationId}`,
  ];
  await backend.context.pool.query(`
    DELETE FROM notification_actions
    WHERE notification_id IN (
      SELECT id FROM notifications
      WHERE source_id = ANY($1::text[])
         OR source_id LIKE $2
         OR source_id LIKE 'push:morning_start_day:%'
    )
  `, [sourceIds, `${integrationId}:%`]);
  await backend.context.pool.query(`
    DELETE FROM notification_delivery_events
    WHERE notification_id IN (
      SELECT id FROM notifications
      WHERE source_id = ANY($1::text[])
         OR source_id LIKE $2
         OR source_id LIKE 'push:morning_start_day:%'
    )
  `, [sourceIds, `${integrationId}:%`]);
  await backend.context.pool.query(`
    DELETE FROM notifications
    WHERE source_id = ANY($1::text[])
       OR source_id LIKE $2
       OR source_id LIKE 'push:morning_start_day:%'
  `, [sourceIds, `${integrationId}:%`]);
  await backend.context.pool.query(
    'DELETE FROM homelab_alert_receipts WHERE integration = $1',
    [integrationId],
  );
  await backend.context.pool.query(
    'DELETE FROM alertmanager_integration_events WHERE integration = $1',
    [integrationId],
  );
  await backend.context.pool.query(
    'DELETE FROM notification_push_rules WHERE connector_instance_id = $1',
    [integrationId],
  );
  await backend.context.pool.query(
    'DELETE FROM push_subscriptions WHERE id = $1',
    [rateLimitSubscriptionId],
  );
}

function alertmanagerPayload() {
  return {
    version: '4',
    groupKey: '{}:{alertname="NodeDown"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'mission-control',
    groupLabels: { alertname: 'NodeDown' },
    commonLabels: { severity: 'critical' },
    commonAnnotations: {},
    externalURL: 'https://alertmanager.example',
    alerts: [{
      status: 'firing',
      labels: {
        alertname: 'NodeDown',
        severity: 'critical',
        notification_type: 'homelab_service_unavailable',
      },
      annotations: { summary: 'Node is unavailable' },
      startsAt: '2026-09-06T12:00:00.000Z',
      endsAt: '2026-09-06T12:05:00.000Z',
      generatorURL: 'https://prometheus.example/graph',
      fingerprint: webhookFingerprint,
    }],
  };
}

describePostgres('PostgreSQL notification delivery routes with SQLite poisoned', () => {
  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    resetProcessRuntimeRegistries();
    backend = new PostgresPersistenceBackend({
      config: resolvePostgresConfig({
        MC_POSTGRES_URL: connectionString,
        MC_POSTGRES_APPLICATION_NAME: 'notification-delivery-web-poisoned-test',
      }),
    });
    await backend.initialize();
    const core = createPostgresCoreRepositories(backend.context.db);
    repositories = createPostgresWorkerPersistenceRepositories(
      backend.context.db,
      backend.context.pool,
      core,
    );
    registerWorkerPersistenceRepositories(repositories);
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN = 'test-token-with-at-least-32-characters';
    process.env.MC_ALERTMANAGER_INTEGRATION_ID = integrationId;
    process.env.CRON_SECRET = 'notification-parity-cron-secret';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ events: [] })));
    await cleanFixtures();
    await backend.context.pool.query(`
      INSERT INTO notifications (
        id, source_id, connector_type, connector_instance_id, title, body,
        level, category, received_at, sort_at, metadata, presentation,
        navigation_target, is_actionable
      ) VALUES
        ($1, $2, 'test', 'test-1', 'Action route', 'Body', 'heads_up',
         'general', $3, $3, '{}'::jsonb, '{}'::jsonb, '/notifications', true),
        ($4, $5, 'test', 'test-1', 'Re-enrichment route', 'Body', 'heads_up',
         'general', $3, $3, '{}'::jsonb, '{}'::jsonb, '/notifications', false)
    `, [
      actionNotificationId,
      `source:${actionNotificationId}`,
      '2026-09-06T12:00:00.000Z',
      enrichmentNotificationId,
      `source:${enrichmentNotificationId}`,
    ]);
    await backend.context.pool.query(`
      INSERT INTO notification_actions (
        id, notification_id, action_type, label, is_primary, payload
      ) VALUES ($1, $2, 'open_url', 'Open', true, $3::jsonb)
    `, [actionId, actionNotificationId, JSON.stringify({ url: 'https://example.test/item' })]);
  }, 30_000);

  afterAll(async () => {
    if (!backend) return;
    await cleanFixtures();
    clearWorkerPersistenceRepositories(repositories);
    resetProcessRuntimeRegistries();
    vi.unstubAllGlobals();
    delete process.env.MC_DATABASE_BACKEND;
    delete process.env.MC_ALERTMANAGER_WEBHOOK_TOKEN;
    delete process.env.MC_ALERTMANAGER_INTEGRATION_ID;
    delete process.env.CRON_SECRET;
    await backend.shutdown();
  }, 30_000);

  it('serves Alertmanager status', async () => {
    const { GET } = await import('@/app/api/integrations/alertmanager/route');
    expect((await GET()).status).toBe(200);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('runs the synthetic Alertmanager lifecycle', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/test/route');
    expect((await POST(new Request(
      'http://localhost/api/integrations/alertmanager/test',
      { method: 'POST' },
    ))).status).toBe(200);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('ingests and audits an Alertmanager webhook', async () => {
    const { POST } = await import('@/app/api/integrations/alertmanager/webhook/route');
    await backend.context.pool.query(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('push_delivery_enabled', 'false'::jsonb, now())
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    try {
      const response = await POST(new Request(
        'http://localhost/api/integrations/alertmanager/webhook',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer test-token-with-at-least-32-characters',
            'content-type': 'application/json',
          },
          body: JSON.stringify(alertmanagerPayload()),
        },
      ));
      expect(response.status).toBe(200);
      const deliveries = await backend.context.pool.query<{
        status: string;
        suppressionReason: string | null;
      }>(`
        SELECT event.status, event.suppression_reason AS "suppressionReason"
        FROM notification_delivery_events event
        JOIN notifications notification ON notification.id = event.notification_id
        WHERE notification.source_id = $1
        ORDER BY event.channel
      `, [`${integrationId}:alertmanager:${webhookFingerprint}`]);
      expect(deliveries.rows).toEqual([
        { status: 'suppressed', suppressionReason: 'channel_disabled' },
        { status: 'suppressed', suppressionReason: 'channel_disabled' },
      ]);
      expect(sqliteTouch).not.toHaveBeenCalled();
    } finally {
      await backend.context.pool.query(
        `DELETE FROM app_settings WHERE key = 'push_delivery_enabled'`,
      );
    }
  });

  it('serializes concurrent PostgreSQL creation at the global push limit', async () => {
    await repositories.notificationDelivery.pushRules.save({
      connectorInstanceId: integrationId,
      templateKey: 'homelab_service_unavailable',
      enabled: true,
      minLevel: 'urgent',
      preview: 'title_only',
      maxPerHour: null,
    });
    await backend.context.pool.query(`
      INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
      VALUES ($1, 'web', $2, $3::jsonb, $4)
    `, [
      rateLimitSubscriptionId,
      `https://push.example.test/${rateLimitSubscriptionId}`,
      JSON.stringify({ p256dh: 'key', auth: 'auth' }),
      '2199-01-01T00:00:00.000Z',
    ]);

    const create = async (suffix: string) => {
      const client = await backend.context.pool.connect();
      try {
        await client.query('BEGIN');
        const [result] = await createPostgresNotificationsInTransaction(client, [{
          sourceId: `${integrationId}:rate-limit:${suffix}`,
          connectorType: 'homelab',
          connectorInstanceId: integrationId,
          title: `Rate limit ${suffix}`,
          level: 'urgent',
          templateKey: 'homelab_service_unavailable',
          occurrenceKey: suffix,
        }], {
          now: new Date('2199-01-01T00:00:00.000Z'),
          timezone: 'UTC',
          channelConfigured: true,
          apnsConfigured: false,
          globalMaxPerHour: 1,
          wakeDispatcher: false,
        });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };

    const results = await Promise.all([create('a'), create('b')]);
    const webDeliveries = results.flatMap(result => result.deliveryEvents)
      .filter(delivery => delivery.channel === 'web_push');
    expect(webDeliveries.map(delivery => delivery.status).sort()).toEqual([
      'pending',
      'suppressed',
    ]);
    expect(webDeliveries.map(delivery => delivery.suppressionReason)).toContain('rate_limited');
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('executes a notification action', async () => {
    const { POST } = await import('@/app/api/notifications/[id]/actions/[actionId]/route');
    const response = await POST(
      new Request(
        `http://localhost/api/notifications/${actionNotificationId}/actions/${actionId}`,
        { method: 'POST', body: '{}' },
      ),
      { params: Promise.resolve({ id: actionNotificationId, actionId }) },
    );
    expect(response.status).toBe(200);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('re-enriches a selected notification', async () => {
    const { POST } = await import('@/app/api/notifications/re-enrich/route');
    const response = await POST(new Request(
      'http://localhost/api/notifications/re-enrich',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'ids', ids: [enrichmentNotificationId] }),
      },
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ processed: 1, enriched: 1 });
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('classifies notification triage candidates', async () => {
    const { GET } = await import('@/app/api/notifications/triage/route');
    expect((await GET()).status).toBe(200);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });

  it('runs a scheduled trigger through PostgreSQL creation and dedupe', async () => {
    const { POST } = await import('@/app/api/push/trigger/route');
    const response = await POST(new Request(
      'http://localhost/api/push/trigger?type=morning',
      {
        method: 'POST',
        headers: { authorization: 'Bearer notification-parity-cron-secret' },
      },
    ));
    expect(response.status).toBe(200);
    expect(sqliteTouch).not.toHaveBeenCalled();
  });
});
