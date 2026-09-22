import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import {
  createSqliteEventDeliveryRepositories,
  enqueueSqliteEventOutbox,
} from '@/db/persistence/sqlite-event-outbox-repository';
import type { EventDeliveryRepositories } from '@/db/persistence/event-outbox';

let sqlite: Database.Database;
let repositories: EventDeliveryRepositories;

function addWebhook(
  id: string,
  eventTypes: string[],
  options: { enabled?: boolean; url?: string } = {},
): void {
  sqlite.prepare(`
    INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    `Hook ${id}`,
    options.url ?? `https://example.test/${id}`,
    'shhh',
    JSON.stringify(eventTypes),
    options.enabled === false ? 0 : 1,
    new Date().toISOString(),
  );
}

function enqueue(stableKey: string, eventType = 'sync.completed') {
  return enqueueSqliteEventOutbox(sqlite, {
    stableKey,
    eventType,
    payload: { connectorId: 'c1' },
    occurredAt: new Date().toISOString(),
  });
}

function deliveryRow(id: string) {
  return sqlite.prepare('SELECT * FROM event_outbox_deliveries WHERE id = ?').get(id) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  repositories = createSqliteEventDeliveryRepositories(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe('sqlite event outbox enqueue', () => {
  it('fans out to every enabled subscription that matches the event type', async () => {
    addWebhook('a', ['sync.completed']);
    addWebhook('b', ['sync.completed', 'sync.failed']);
    addWebhook('c', ['task.created']);
    addWebhook('d', ['sync.completed'], { enabled: false });

    const result = await repositories.outbox.enqueue({
      stableKey: 'sync.completed:job:j1:run:r1',
      eventType: 'sync.completed',
      payload: { connectorId: 'c1' },
      occurredAt: new Date().toISOString(),
    });

    expect(result).toMatchObject({ created: true, deliveryCount: 2 });
    const webhookIds = sqlite.prepare(
      'SELECT webhook_id FROM event_outbox_deliveries ORDER BY webhook_id',
    ).all() as Array<{ webhook_id: string }>;
    expect(webhookIds.map((row) => row.webhook_id)).toEqual(['a', 'b']);
  });

  it('deduplicates a repeated stable key without creating a second delivery', async () => {
    addWebhook('a', ['sync.completed']);
    const first = enqueue('sync.completed:job:j1:run:r1');
    const second = enqueue('sync.completed:job:j1:run:r1');

    expect(first).toMatchObject({ created: true, deliveryCount: 1 });
    expect(second).toMatchObject({ created: false, sequence: first.sequence, deliveryCount: 0 });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM event_outbox_deliveries').get(),
    ).toEqual({ n: 1 });
  });

  it('enqueues an event with no matching subscription without failing', async () => {
    const result = enqueue('sync.completed:job:j1:run:r1');
    expect(result).toMatchObject({ created: true, deliveryCount: 0 });
  });

  it('rolls back the outbox row when the enclosing transaction aborts', () => {
    addWebhook('a', ['sync.completed']);
    const transaction = sqlite.transaction(() => {
      enqueue('sync.completed:job:j1:run:r1');
      throw new Error('finalizer failed after enqueue');
    });

    expect(() => transaction.immediate()).toThrow('finalizer failed after enqueue');
    expect(sqlite.prepare('SELECT count(*) AS n FROM event_outbox').get()).toEqual({ n: 0 });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM event_outbox_deliveries').get(),
    ).toEqual({ n: 0 });
  });
});

describe('sqlite event delivery claiming', () => {
  it('claims a pending delivery under an owner/token fenced lease', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');

    const now = new Date('2025-01-01T00:00:00.000Z');
    const claim = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });

    expect(claim).not.toBeNull();
    expect(claim!.leaseOwner).toBe('w1');
    expect(claim!.leaseToken).toMatch(/[0-9a-f-]{36}/);
    expect(claim!.leaseExpiresAt).toBe('2025-01-01T00:01:00.000Z');
    expect(claim!.attemptCount).toBe(1);
    expect(claim!.payload).toEqual({ connectorId: 'c1' });
    expect(claim!.webhook.secret).toBe('shhh');
    expect(deliveryRow(claim!.id).status).toBe('delivering');
  });

  it('never hands the same delivery to two concurrent owners', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');

    const now = new Date();
    const first = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });
    const second = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w2' });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('does not claim a delivery whose retry backoff has not elapsed', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const now = new Date('2025-01-01T00:00:00.000Z');
    const claim = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });
    await repositories.outbox.scheduleRetry(claim!, {
      nextAttemptAt: '2025-01-01T00:05:00.000Z',
      lastError: 'http_server_error',
      lastStatus: 503,
    });

    expect(await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:04:59.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    })).toBeNull();

    const retried = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:05:00.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    });
    expect(retried?.attemptCount).toBe(2);
  });

  it('preserves deterministic per-webhook ordering', async () => {
    addWebhook('a', ['sync.completed']);
    const first = enqueue('k1');
    const second = enqueue('k2');
    expect(second.sequence).toBeGreaterThan(first.sequence);

    const now = new Date();
    const claimA = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });
    expect(claimA?.eventSequence).toBe(first.sequence);

    // The later event stays blocked while the earlier one is still outstanding.
    expect(await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w2' })).toBeNull();

    await repositories.outbox.markDelivered(claimA!, {
      deliveredAt: now.toISOString(),
      lastStatus: 200,
    });
    const claimB = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w2' });
    expect(claimB?.eventSequence).toBe(second.sequence);
  });

  it('does not let one blocked webhook stall a different webhook', async () => {
    addWebhook('a', ['sync.completed']);
    addWebhook('b', ['sync.completed']);
    enqueue('k1');

    const now = new Date();
    const first = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });
    const second = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w2' });

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.webhook.id).not.toBe(second!.webhook.id);
  });

  it('dead-letters a delivery whose stored payload is not decodable', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    sqlite.prepare("UPDATE event_outbox SET payload = 'not-json'").run();

    const claim = await repositories.outbox.claimNext({
      now: new Date(),
      leaseMs: 60_000,
      owner: 'w1',
    });

    expect(claim).toBeNull();
    const row = sqlite.prepare('SELECT status, last_error FROM event_outbox_deliveries').get();
    expect(row).toMatchObject({ status: 'dead_letter', last_error: 'invalid_payload' });
  });
});

describe('sqlite event delivery fencing', () => {
  async function claimAndFence() {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const now = new Date('2025-01-01T00:00:00.000Z');
    const stale = await repositories.outbox.claimNext({ now, leaseMs: 60_000, owner: 'w1' });
    const recovered = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:02:00.000Z'),
      leaseMs: 60_000,
      owner: 'w2',
    });
    return { stale: stale!, recovered: recovered! };
  }

  it('reclaims an expired lease for a new owner', async () => {
    const { stale, recovered } = await claimAndFence();
    expect(recovered.id).toBe(stale.id);
    expect(recovered.leaseOwner).toBe('w2');
    expect(recovered.leaseToken).not.toBe(stale.leaseToken);
    expect(recovered.attemptCount).toBe(2);
  });

  it('rejects every write from the fenced-out owner', async () => {
    const { stale, recovered } = await claimAndFence();

    expect(await repositories.outbox.heartbeat(stale, '2025-01-01T01:00:00.000Z')).toBe(false);
    expect(await repositories.outbox.markDelivered(stale, {
      deliveredAt: '2025-01-01T00:03:00.000Z',
      lastStatus: 200,
    })).toBe(false);
    expect(await repositories.outbox.scheduleRetry(stale, {
      nextAttemptAt: '2025-01-01T00:10:00.000Z',
      lastError: 'network_error',
    })).toBe(false);
    expect(await repositories.outbox.deadLetter(stale, { lastError: 'network_error' })).toBe(false);

    // The current owner is still able to finalize.
    expect(await repositories.outbox.markDelivered(recovered, {
      deliveredAt: '2025-01-01T00:03:00.000Z',
      lastStatus: 200,
    })).toBe(true);
    expect(deliveryRow(recovered.id).status).toBe('delivered');
  });

  it('extends a live lease through heartbeat', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const claim = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    });

    expect(await repositories.outbox.heartbeat(claim!, '2025-01-01T00:05:00.000Z')).toBe(true);
    expect(deliveryRow(claim!.id).lease_expires_at).toBe('2025-01-01T00:05:00.000Z');
  });
});

describe('sqlite event delivery recovery and scheduling', () => {
  it('returns expired delivering rows to pending', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const claim = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    });

    expect(await repositories.outbox.recoverStaleLeases({
      now: new Date('2025-01-01T00:00:30.000Z'),
    })).toBe(0);
    expect(await repositories.outbox.recoverStaleLeases({
      now: new Date('2025-01-01T00:02:00.000Z'),
    })).toBe(1);

    const row = deliveryRow(claim!.id);
    expect(row).toMatchObject({
      status: 'pending',
      lease_owner: null,
      lease_token: null,
      lease_expires_at: null,
    });
  });

  it('reports the earliest claimable moment and nothing once terminal', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const claim = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:00:00.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    });
    await repositories.outbox.scheduleRetry(claim!, {
      nextAttemptAt: '2025-01-01T00:05:00.000Z',
      lastError: 'network_error',
    });

    expect(await repositories.outbox.getNextWakeAt()).toBe('2025-01-01T00:05:00.000Z');

    const retried = await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:05:00.000Z'),
      leaseMs: 60_000,
      owner: 'w1',
    });
    await repositories.outbox.deadLetter(retried!, {
      lastError: 'retry_limit_exhausted',
      lastStatus: 500,
    });

    expect(await repositories.outbox.getNextWakeAt()).toBeNull();
  });
});

describe('sqlite event subscription persistence', () => {
  it('lists only enabled subscriptions for the requested event type', async () => {
    addWebhook('a', ['sync.completed']);
    addWebhook('b', ['sync.failed']);
    addWebhook('c', ['sync.completed'], { enabled: false });

    const matching = await repositories.subscriptions.listMatching('sync.completed');
    expect(matching.map((entry) => entry.id)).toEqual(['a']);
  });

  it('records a delivery outcome against the subscription row', async () => {
    addWebhook('a', ['sync.completed']);
    await repositories.subscriptions.recordDeliveryOutcome({
      webhookId: 'a',
      triggeredAt: '2025-01-01T00:00:00.000Z',
      status: 204,
    });

    expect(sqlite.prepare(
      'SELECT last_triggered_at, last_status FROM outbound_webhooks WHERE id = ?',
    ).get('a')).toEqual({
      last_triggered_at: '2025-01-01T00:00:00.000Z',
      last_status: 204,
    });
  });
});
