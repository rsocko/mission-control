import { afterAll, describe, it, vi } from 'vitest';
import { createPostgresEventDeliveryRepositories } from '@/db/postgres/repositories/event-outbox-repository';
import {
  describeEventOutboxRepositoryContract,
  EVENT_OUTBOX_BASE_TIME,
  type EventOutboxContractHarness,
} from '../contracts/event-outbox-repository.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL event outbox');
});

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const originalBackend = process.env.MC_DATABASE_BACKEND;
const originalPostgresUrl = process.env.MC_POSTGRES_URL;
const originalSslMode = process.env.MC_POSTGRES_SSL_MODE;
const originalApplicationName = process.env.MC_POSTGRES_APPLICATION_NAME;
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
  process.env.MC_POSTGRES_APPLICATION_NAME = 'mission-control-event-outbox-test';
  runtime = await import('@/db/runtime');
  await runtime.initializeRuntimeDatabase();
  initialized = true;
}

function currentPool() {
  if (!runtime) throw new Error('PostgreSQL event outbox runtime is not initialized');
  return runtime.getPostgresPersistenceBackend().context.pool;
}

async function createHarness(): Promise<EventOutboxContractHarness> {
  await initialize();
  const pool = currentPool();
  const repositories = createPostgresEventDeliveryRepositories(pool);

  return {
    repositories,
    async reset() {
      await pool.query("DELETE FROM event_outbox_deliveries WHERE webhook_id LIKE 'oc-%'");
      await pool.query("DELETE FROM event_outbox WHERE stable_key LIKE 'oc:%'");
      await pool.query("DELETE FROM outbound_webhooks WHERE id LIKE 'oc-%'");
    },
    async seedWebhook(input) {
      await pool.query(
        `
          INSERT INTO outbound_webhooks (
            id, name, url, secret, event_types, enabled, created_at
          ) VALUES ($1, $1, $2, $3, $4::jsonb, $5, $6)
        `,
        [
          input.id,
          input.url ?? `https://hooks.example.com/${input.id}`,
          input.secret ?? 'shh',
          JSON.stringify(input.eventTypes),
          input.enabled !== false,
          EVENT_OUTBOX_BASE_TIME.toISOString(),
        ],
      );
    },
    async setWebhookEnabled(id, enabled) {
      await pool.query(
        'UPDATE outbound_webhooks SET enabled = $1 WHERE id = $2',
        [enabled, id],
      );
    },
    async getDelivery(id) {
      const result = await pool.query(
        'SELECT * FROM event_outbox_deliveries WHERE id = $1',
        [id],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        status: row.status,
        attemptCount: row.attempt_count,
        leaseOwner: row.lease_owner,
        leaseToken: row.lease_token,
        nextAttemptAt: row.next_attempt_at,
        lastError: row.last_error,
        lastStatus: row.last_status,
      };
    },
    async listDeliveries() {
      const result = await pool.query(`
        SELECT id, event_sequence, webhook_id
        FROM event_outbox_deliveries
        WHERE webhook_id LIKE 'oc-%'
        ORDER BY event_sequence, id
      `);
      return result.rows.map((row) => ({
        id: row.id,
        eventSequence: row.event_sequence,
        webhookId: row.webhook_id,
      }));
    },
    async poisonPayload(sequence) {
      // jsonb cannot hold malformed JSON, so poison with a valid-but-non-object
      // document, which the shared payload parser rejects identically.
      await pool.query(
        "UPDATE event_outbox SET payload = '[1,2,3]'::jsonb WHERE sequence = $1",
        [sequence],
      );
    },
  };
}

if (connectionString) {
  afterAll(async () => {
    if (runtime) {
      await currentPool().query("DELETE FROM event_outbox_deliveries WHERE webhook_id LIKE 'oc-%'");
      await currentPool().query("DELETE FROM event_outbox WHERE stable_key LIKE 'oc:%'");
      await currentPool().query("DELETE FROM outbound_webhooks WHERE id LIKE 'oc-%'");
      await runtime.shutdownRuntimeDatabase();
    }
    restoreEnvironment('MC_DATABASE_BACKEND', originalBackend);
    restoreEnvironment('MC_POSTGRES_URL', originalPostgresUrl);
    restoreEnvironment('MC_POSTGRES_SSL_MODE', originalSslMode);
    restoreEnvironment('MC_POSTGRES_APPLICATION_NAME', originalApplicationName);
  });

  describeEventOutboxRepositoryContract('PostgreSQL event outbox repository', createHarness);
} else {
  describe('PostgreSQL event outbox repository', () => {
    it.skip('requires MC_TEST_POSTGRES_URL', () => undefined);
  });
}
