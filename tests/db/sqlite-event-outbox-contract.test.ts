import Database from 'better-sqlite3';
import { afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { createSqliteEventDeliveryRepositories } from '@/db/persistence/sqlite-event-outbox-repository';
import {
  describeEventOutboxRepositoryContract,
  EVENT_OUTBOX_BASE_TIME,
  type EventOutboxContractHarness,
} from '../contracts/event-outbox-repository.contract';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

let sqlite: Database.Database | null = null;

afterEach(() => {
  sqlite?.close();
  sqlite = null;
});

interface DeliveryRow {
  id: string;
  event_sequence: number;
  webhook_id: string;
  status: string;
  attempt_count: number;
  lease_owner: string | null;
  lease_token: string | null;
  next_attempt_at: string | null;
  last_error: string | null;
  last_status: number | null;
}

async function createHarness(): Promise<EventOutboxContractHarness> {
  const { _runMigrationsIndividually } = await import('@/db');
  sqlite?.close();
  const database = new Database(':memory:');
  sqlite = database;
  database.pragma('foreign_keys = ON');
  _runMigrationsIndividually(database, resolve(process.cwd(), 'drizzle'));
  const repositories = createSqliteEventDeliveryRepositories(database);

  return {
    repositories,
    async reset() {
      database.exec('DELETE FROM event_outbox_deliveries');
      database.exec('DELETE FROM event_outbox');
      database.exec('DELETE FROM outbound_webhooks');
    },
    async seedWebhook(input) {
      database.prepare(`
        INSERT INTO outbound_webhooks (
          id, name, url, secret, event_types, enabled, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.id,
        input.url ?? `https://hooks.example.com/${input.id}`,
        input.secret ?? 'shh',
        JSON.stringify(input.eventTypes),
        input.enabled === false ? 0 : 1,
        EVENT_OUTBOX_BASE_TIME.toISOString(),
      );
    },
    async setWebhookEnabled(id, enabled) {
      database.prepare(
        'UPDATE outbound_webhooks SET enabled = ? WHERE id = ?',
      ).run(enabled ? 1 : 0, id);
    },
    async getDelivery(id) {
      const row = database.prepare(
        'SELECT * FROM event_outbox_deliveries WHERE id = ?',
      ).get(id) as DeliveryRow | undefined;
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
      const rows = database.prepare(
        'SELECT id, event_sequence, webhook_id FROM event_outbox_deliveries ORDER BY event_sequence, id',
      ).all() as DeliveryRow[];
      return rows.map((row) => ({
        id: row.id,
        eventSequence: row.event_sequence,
        webhookId: row.webhook_id,
      }));
    },
    async poisonPayload(sequence) {
      database.prepare('UPDATE event_outbox SET payload = ? WHERE sequence = ?')
        .run('{not json', sequence);
    },
  };
}

describeEventOutboxRepositoryContract('SQLite event outbox repository', createHarness);
