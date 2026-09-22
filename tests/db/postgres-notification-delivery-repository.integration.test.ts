import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  createPostgresNotificationDeliveryRepository,
} from '@/db/postgres/repositories/notification-delivery-repository';
import {
  describeNotificationDeliveryRepositoryContract,
  NOTIFICATION_DELIVERY_BASE_TIME,
  type NotificationDeliveryContractHarness,
} from '../contracts/notification-delivery-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

const webPushMocks = vi.hoisted(() => ({
  sendNotification: vi.fn(),
  setVapidDetails: vi.fn(),
}));

vi.mock('web-push', () => ({
  default: webPushMocks,
}));

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL notification delivery');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;
const originalVapidPublicKey = process.env.VAPID_PUBLIC_KEY;
const originalVapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
let runtime: typeof import('@/db/runtime') | null = null;
let initialized = false;

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function initialize(): Promise<void> {
  if (initialized) return;
  if (!connectionString) throw new Error('MC_TEST_POSTGRES_URL is required');
  assertSafeIntegrationTestTarget(connectionString);
  process.env.MC_DATABASE_BACKEND = 'postgres';
  process.env.MC_POSTGRES_URL = connectionString;
  process.env.MC_POSTGRES_SSL_MODE = new URL(connectionString).searchParams.get('sslmode')
    ?? 'disable';
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-notification-delivery-test';
  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  initialized = true;
}

function currentPool() {
  if (!runtime) throw new Error('PostgreSQL notification delivery runtime is not initialized');
  return runtime.getPostgresPersistenceBackend().context.pool;
}

async function createHarness(): Promise<NotificationDeliveryContractHarness> {
  await initialize();
  const repository = createPostgresNotificationDeliveryRepository(currentPool());

  return {
    repository,
    async reset() {
      await currentPool().query(`
        DELETE FROM notification_delivery_events
        WHERE id IN ('ownership', 'exhausted', 'malformed', 'valid', 'later', 'earlier',
                     'dnd', 'quiet', 'channel', 'read', 'connector', 'webhook', 'finance',
                     'sent-outcome', 'partial-outcome', 'failed-outcome',
                     'suppressed-outcome',
                     'postgres-e2e', 'postgres-recovery')
      `);
      await currentPool().query(`DELETE FROM notifications WHERE source_id LIKE 'contract:%'
        OR source_id LIKE 'finance-insight:%'`);
      await currentPool().query(`DELETE FROM finance_insight_cutovers
        WHERE connector_id LIKE '%-connector'`);
      await currentPool().query(`DELETE FROM inbound_webhooks WHERE id LIKE '%-connector'`);
      await currentPool().query(`DELETE FROM connector_configs WHERE name = 'Contract'`);
      await currentPool().query(`
        DELETE FROM push_subscriptions WHERE id IN ('web-contract', 'postgres-e2e-web')
      `);
      await currentPool().query(`DELETE FROM apns_registrations WHERE id = 'apns-contract'`);
      await currentPool().query(`DELETE FROM push_preferences WHERE id = 'default'`);
      await currentPool().query(`DELETE FROM app_settings WHERE key = 'push_delivery_enabled'`);
    },
    async seedEvent(input) {
      const connectorType = input.connectorType ?? 'github-issues';
      const connectorId = `${input.id}-connector`;
      const now = NOTIFICATION_DELIVERY_BASE_TIME.toISOString();
      if (connectorType === 'inbound-webhook') {
        await currentPool().query(
          `
            INSERT INTO inbound_webhooks (
              id, name, source_label, enabled, created_at, updated_at
            ) VALUES ($1, 'Webhook', 'webhook', $2, $3, $3)
          `,
          [connectorId, input.webhookEnabled !== false, now],
        );
      } else {
        await currentPool().query(
          `
            INSERT INTO connector_configs (
              id, type, name, enabled, sync_mode, capabilities, credentials,
              settings, synced_lists, created_at, updated_at
            ) VALUES ($1, $2, 'Contract', $3, 'poll', '{}', '{}', '{}', '[]', $4, $4)
          `,
          [connectorId, connectorType, input.connectorEnabled !== false, now],
        );
      }
      if (connectorType === 'finance-manager') {
        await currentPool().query(
          `
            INSERT INTO finance_insight_cutovers (
              connector_id, cutover_at, source_generation, source_sequence,
              legacy_disabled, delivery_enabled, created_at, updated_at
            ) VALUES ($1, $2, 'generation', 1, true, $3, $2, $2)
          `,
          [connectorId, now, input.financeDeliveryEnabled !== false],
        );
      }
      const notificationId = `${input.id}-notification`;
      await currentPool().query(
        `
          INSERT INTO notifications (
            id, source_id, connector_type, connector_instance_id, title, level, category,
            state, read_state, disposition, source_state, sync_state, received_at, sort_at,
            metadata, presentation
          ) VALUES ($1, $2, $3, $4, 'Contract', 'action_needed', 'system',
                    'unread', $5, 'inbox', 'active', 'synced', $6, $6, '{}', '{}')
        `,
        [
          notificationId,
          connectorType === 'finance-manager'
            ? `finance-insight:${input.id}`
            : `contract:${input.id}`,
          connectorType,
          connectorId,
          input.readState ?? 'unread',
          now,
        ],
      );
      const payload = input.payload ?? {
        notificationId,
        title: 'Portable notification',
        tag: `mc:${notificationId}`,
        url: `/notifications?id=${notificationId}`,
      };
      await currentPool().query(
        `
          INSERT INTO notification_delivery_events (
            id, notification_id, channel, dedupe_key, status, policy_snapshot,
            payload_snapshot, attempt_count, next_attempt_at, lease_expires_at,
            claim_token, created_at
          ) VALUES ($1, $2, 'web_push', $3, $4, '{}', $5, $6, $7, $8, $9, $10)
        `,
        [
          input.id,
          notificationId,
          `web_push:${input.id}`,
          input.status ?? 'pending',
          JSON.stringify(payload),
          input.attemptCount ?? 0,
          input.nextAttemptAt ?? null,
          input.leaseExpiresAt ?? null,
          input.claimToken ?? null,
          input.createdAt ?? now,
        ],
      );
    },
    async getEvent(id) {
      const result = await currentPool().query(
        `
          SELECT status, attempt_count AS "attemptCount", claim_token AS "claimToken",
                 next_attempt_at AS "nextAttemptAt", lease_expires_at AS "leaseExpiresAt",
                 last_error AS "lastError", suppression_reason AS "suppressionReason",
                 subscriptions_attempted AS "subscriptionsAttempted",
                 subscriptions_sent AS "subscriptionsSent",
                 subscriptions_failed AS "subscriptionsFailed"
          FROM notification_delivery_events WHERE id = $1
        `,
        [id],
      );
      return result.rows[0];
    },
    async setDnd(enabled) {
      await currentPool().query(
        `
          INSERT INTO push_preferences (
            id, morning_enabled, morning_hour, triage_nudge_enabled,
            triage_nudge_threshold, carry_forward_enabled, carry_forward_hour,
            do_not_disturb, updated_at
          ) VALUES ('default', true, 8, true, 5, true, 18, $1, $2)
        `,
        [enabled, NOTIFICATION_DELIVERY_BASE_TIME.toISOString()],
      );
    },
    async setQuietHours(start, end) {
      await currentPool().query(
        `
          INSERT INTO push_preferences (
            id, morning_enabled, morning_hour, triage_nudge_enabled,
            triage_nudge_threshold, carry_forward_enabled, carry_forward_hour,
            quiet_start, quiet_end, do_not_disturb, updated_at
          ) VALUES ('default', true, 8, true, 5, true, 18, $1, $2, false, $3)
        `,
        [start, end, NOTIFICATION_DELIVERY_BASE_TIME.toISOString()],
      );
    },
    async setChannelEnabled(enabled) {
      await currentPool().query(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ('push_delivery_enabled', $1, $2)
        `,
        [JSON.stringify({ enabled }), NOTIFICATION_DELIVERY_BASE_TIME.toISOString()],
      );
    },
    async seedWebPushSubscription(id) {
      await currentPool().query(
        `
          INSERT INTO push_subscriptions (id, platform, endpoint, keys, created_at)
          VALUES ($1, 'web', $2, $3, $4)
        `,
        [
          id,
          `https://push.example.test/${id}`,
          JSON.stringify({ p256dh: 'key', auth: 'auth' }),
          NOTIFICATION_DELIVERY_BASE_TIME.toISOString(),
        ],
      );
    },
    async hasWebPushSubscription(id) {
      const result = await currentPool().query(
        'SELECT id FROM push_subscriptions WHERE id = $1',
        [id],
      );
      return result.rowCount === 1;
    },
    async seedApnsRegistration(id) {
      const now = NOTIFICATION_DELIVERY_BASE_TIME.toISOString();
      await currentPool().query(
        `
          INSERT INTO apns_registrations (
            id, installation_id, token_ciphertext, token_hash, environment, topic,
            app_version, build_number, locale, time_zone, created_at, updated_at, last_seen_at
          ) VALUES ($1, $2, 'ciphertext', $3, 'development', 'app.mission-control.test',
                    '1.0', 1, 'en-US', 'UTC', $4, $4, $4)
        `,
        [id, `installation-${id}`, `hash-${id}`, now],
      );
    },
    async getApnsInvalidation(id) {
      const result = await currentPool().query<{ invalidation_reason: string | null }>(
        'SELECT invalidation_reason FROM apns_registrations WHERE id = $1',
        [id],
      );
      return result.rows[0]?.invalidation_reason ?? null;
    },
  };
}

afterAll(async () => {
  if (initialized) {
    await (await createHarness()).reset();
    await runtime?.shutdownRuntimeDatabase();
  }
  restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
  restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
  restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
  restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  restoreEnvironment('VAPID_PUBLIC_KEY', originalVapidPublicKey);
  restoreEnvironment('VAPID_PRIVATE_KEY', originalVapidPrivateKey);
});

if (connectionString) {
  describe('PostgreSQL notification delivery repository', () => {
    describeNotificationDeliveryRepositoryContract(createHarness);

    it('runs real dispatch orchestration and recovers an expired lease without SQLite', async () => {
      process.env.VAPID_PUBLIC_KEY = 'inert-public-key';
      process.env.VAPID_PRIVATE_KEY = 'inert-private-key';
      const harness = await createHarness();
      await harness.reset();
      await harness.seedEvent({ id: 'postgres-e2e' });
      await harness.seedWebPushSubscription('postgres-e2e-web');
      const { dispatchNotificationDeliveries } = await import('@/lib/push/dispatcher');
      webPushMocks.sendNotification.mockResolvedValue({});

      expect(await dispatchNotificationDeliveries({
        now: () => NOTIFICATION_DELIVERY_BASE_TIME,
        batchSize: 1,
      })).toBe(1);
      expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
      expect(await harness.getEvent('postgres-e2e')).toMatchObject({
        status: 'sent',
        claimToken: null,
        subscriptionsSent: 1,
      });

      await harness.seedEvent({ id: 'postgres-recovery' });
      webPushMocks.sendNotification.mockClear();
      webPushMocks.sendNotification.mockRejectedValueOnce({ statusCode: 503 });
      await dispatchNotificationDeliveries({
        now: () => NOTIFICATION_DELIVERY_BASE_TIME,
        retryBaseMs: 1_000,
        batchSize: 1,
      });
      expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
      const retryAt = new Date(NOTIFICATION_DELIVERY_BASE_TIME.getTime() + 1_000);
      const { getWorkerPersistenceRepositories } = await import(
        '@/lib/persistence/worker-runtime'
      );
      const abandoned = await (await getWorkerPersistenceRepositories())
        .notificationDelivery.claimNext({
          now: retryAt,
          leaseMs: 1_000,
          maxAttempts: 5,
        });
      expect(abandoned?.id).toBe('postgres-recovery');
      await runtime!.shutdownRuntimeDatabase();
      await runtime!.initializeRuntimeDatabase();
      webPushMocks.sendNotification.mockClear();
      webPushMocks.sendNotification.mockResolvedValue({});
      await dispatchNotificationDeliveries({
        now: () => new Date(retryAt.getTime() + 1_000),
        batchSize: 1,
      });
      expect(webPushMocks.sendNotification).toHaveBeenCalledOnce();
      expect(await harness.getEvent('postgres-recovery')).toMatchObject({
        status: 'sent',
        attemptCount: 3,
        claimToken: null,
      });
    });
  });
} else {
  describe('PostgreSQL notification delivery repository', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
