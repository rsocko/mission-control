import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import {
  createSqliteEventDeliveryRepositories,
  enqueueSqliteEventOutbox,
} from '@/db/persistence/sqlite-event-outbox-repository';
import type { EventDeliveryRepositories } from '@/db/persistence/event-outbox';
import {
  calculateEventRetryDelayMs,
  dispatchEventDeliveries,
  DEFAULT_EVENT_RETRY_BASE_MS,
  EventOutboxDispatcher,
  MAX_EVENT_RETRY_DELAY_MS,
  recoverStaleEventDeliveryLeases,
} from '@/lib/events/dispatcher';

const SECRET = 'top-secret-signing-key';
const URL_A = 'https://receiver.test/hook-a?token=super-secret-query-token';

let sqlite: Database.Database;
let repositories: EventDeliveryRepositories;
const { logged } = vi.hoisted(() => ({ logged: [] as unknown[] }));

vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>();
  const record = (payload: unknown, message?: unknown) => {
    logged.push({ payload, message });
  };
  const capture = {
    error: record,
    warn: record,
    info: record,
    debug: record,
    child: () => capture,
  };
  return { ...actual, default: capture };
});

function addWebhook(id: string, eventTypes: string[], url = URL_A): void {
  sqlite.prepare(`
    INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(id, `Hook ${id}`, url, SECRET, JSON.stringify(eventTypes), new Date().toISOString());
}

function enqueue(stableKey: string, payload: Record<string, unknown> = { connectorId: 'c1' }) {
  return enqueueSqliteEventOutbox(sqlite, {
    stableKey,
    eventType: 'sync.completed',
    payload,
    occurredAt: new Date().toISOString(),
  });
}

function rows() {
  return sqlite.prepare(
    'SELECT * FROM event_outbox_deliveries ORDER BY event_sequence',
  ).all() as Array<Record<string, unknown>>;
}

function dispatch(fetchImpl: typeof fetch, overrides: Record<string, unknown> = {}) {
  return dispatchEventDeliveries({
    repositories,
    owner: 'worker-1',
    leaseMs: 60_000,
    fetchImpl,
    scheduleWakeups: false,
    ...overrides,
  });
}

function response(status: number): Response {
  return new Response(status === 204 ? null : 'body', { status });
}

beforeEach(() => {
  logged.length = 0;
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  repositories = createSqliteEventDeliveryRepositories(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe('event outbox dispatcher delivery', () => {
  it('signs, delivers and marks a claimed delivery as delivered', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1', { connectorId: 'c1' });
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;

    expect(await dispatch(fetchImpl)).toBe(1);

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe(URL_A);
    expect(call[1].headers['X-MC-Event']).toBe('sync.completed');
    expect(call[1].headers['X-MC-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(JSON.parse(call[1].body)).toEqual({ connectorId: 'c1' });

    expect(rows()[0]).toMatchObject({
      status: 'delivered',
      last_status: 204,
      last_error: null,
      lease_owner: null,
      lease_token: null,
    });
    expect(sqlite.prepare(
      'SELECT last_status FROM outbound_webhooks WHERE id = ?',
    ).get('a')).toEqual({ last_status: 204 });
  });

  it('schedules an exponential retry for a transient 5xx', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const now = new Date('2025-01-01T00:00:00.000Z');
    const fetchImpl = vi.fn(async () => response(503)) as unknown as typeof fetch;

    await dispatch(fetchImpl, { now: () => now, retryBaseMs: 1_000 });

    expect(rows()[0]).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_status: 503,
      last_error: 'http_server_error',
      next_attempt_at: '2025-01-01T00:00:01.000Z',
    });
  });

  it('treats 408 and 429 as retryable and other 4xx as permanent', async () => {
    addWebhook('a', ['sync.completed']);
    addWebhook('b', ['sync.completed'], 'https://receiver.test/hook-b');
    enqueue('k1');
    const statuses = new Map([['a', 429], ['b', 400]]);
    const fetchImpl = vi.fn(async (url: string) =>
      response(statuses.get(url.includes('hook-b') ? 'b' : 'a')!),
    ) as unknown as typeof fetch;

    await dispatch(fetchImpl, { retryBaseMs: 1_000 });

    const byWebhook = new Map(rows().map((row) => [row.webhook_id, row]));
    expect(byWebhook.get('a')).toMatchObject({ status: 'pending', last_status: 429 });
    expect(byWebhook.get('b')).toMatchObject({
      status: 'dead_letter',
      last_status: 400,
      last_error: 'http_client_error',
    });
  });

  it('classifies an aborted request as a bounded delivery timeout', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      },
    )) as unknown as typeof fetch;

    await dispatch(fetchImpl, { deliveryTimeoutMs: 10, retryBaseMs: 1_000 });

    expect(rows()[0]).toMatchObject({
      status: 'pending',
      last_error: 'delivery_timeout',
      last_status: null,
    });
  });

  it('dead-letters once the attempt budget is exhausted', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    const fetchImpl = vi.fn(async () => response(500)) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await dispatch(fetchImpl, { maxAttempts: 3, retryBaseMs: 0 });
    }

    expect(rows()[0]).toMatchObject({
      status: 'dead_letter',
      attempt_count: 3,
      last_error: 'retry_limit_exhausted',
    });
    expect(await dispatch(fetchImpl, { maxAttempts: 3 })).toBe(0);
  });

  it('permanently dead-letters a subscription with an unsupported scheme', async () => {
    addWebhook('a', ['sync.completed'], 'file:///etc/passwd');
    enqueue('k1');
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;

    await dispatch(fetchImpl);

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(rows()[0]).toMatchObject({
      status: 'dead_letter',
      last_error: 'unsupported_scheme',
    });
  });

  it('retries missing signing configuration within a bounded attempt budget', async () => {
    sqlite.prepare(`
      INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
      VALUES ('a', 'Hook a', 'https://receiver.test/a', NULL, '["sync.completed"]', 1, 'now')
    `).run();
    enqueue('k1');
    const previous = process.env.MC_EVENT_SECRET;
    delete process.env.MC_EVENT_SECRET;
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;

    try {
      await dispatch(fetchImpl, { maxAttempts: 2, retryBaseMs: 0, batchSize: 1 });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(rows()[0]).toMatchObject({
        status: 'pending',
        last_error: 'signing_secret_missing',
        next_attempt_at: expect.any(String),
      });
      expect(JSON.stringify(logged))
        .toContain('Event delivery is waiting for signing configuration');
      await dispatch(fetchImpl, { maxAttempts: 2, retryBaseMs: 0, batchSize: 1 });
    } finally {
      if (previous === undefined) {
        delete process.env.MC_EVENT_SECRET;
      } else {
        process.env.MC_EVENT_SECRET = previous;
      }
    }
    expect(rows()[0]).toMatchObject({
      status: 'dead_letter',
      last_error: 'retry_limit_exhausted',
    });
  });

  it('never persists or logs the webhook url, secret or payload', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1', { accountNumber: 'PAYLOAD-SENSITIVE-VALUE' });
    const fetchImpl = vi.fn(async () => response(500)) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await dispatch(fetchImpl, { maxAttempts: 2, retryBaseMs: 0 });
    }

    const persisted = JSON.stringify(rows());
    const observed = JSON.stringify(logged);
    for (const haystack of [persisted, observed]) {
      expect(haystack).not.toContain(SECRET);
      expect(haystack).not.toContain('super-secret-query-token');
      expect(haystack).not.toContain('receiver.test');
      expect(haystack).not.toContain('PAYLOAD-SENSITIVE-VALUE');
    }
    expect(observed).toContain('Event delivery moved to dead letter');
  });

  it('respects deterministic per-webhook ordering across a batch', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1', { n: 1 });
    enqueue('k2', { n: 2 });
    enqueue('k3', { n: 3 });
    const seen: number[] = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(String(init.body)).n);
      return response(204);
    }) as unknown as typeof fetch;

    expect(await dispatch(fetchImpl)).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('stops claiming once the batch size is reached', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    enqueue('k2');
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;

    expect(await dispatch(fetchImpl, { batchSize: 1 })).toBe(1);
    expect(rows().map((row) => row.status)).toEqual(['delivered', 'pending']);
  });

  it('aborts an in-flight delivery when the lease is fenced out mid-flight', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    let aborted = false;
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>(
      (_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted by fencing'));
        });
        // Another owner steals the lease while this request is outstanding.
        setTimeout(() => {
          sqlite.prepare(
            "UPDATE event_outbox_deliveries SET lease_token = 'stolen'",
          ).run();
        }, 5);
      },
    )) as unknown as typeof fetch;

    await dispatch(fetchImpl, { leaseMs: 3_000, retryBaseMs: 0 });

    expect(aborted).toBe(true);
    expect(JSON.stringify(logged)).toContain('Event delivery lease was fenced out mid-flight');
    // The fenced-out dispatcher must not be able to write the outcome.
    expect(rows()[0]).toMatchObject({ status: 'delivering', lease_token: 'stolen' });
  });
});

describe('event outbox retry backoff', () => {
  it('grows exponentially from the configured base and saturates at the cap', () => {
    expect(calculateEventRetryDelayMs(1, 1_000)).toBe(1_000);
    expect(calculateEventRetryDelayMs(2, 1_000)).toBe(2_000);
    expect(calculateEventRetryDelayMs(3, 1_000)).toBe(4_000);
    expect(calculateEventRetryDelayMs(0, 1_000)).toBe(1_000);
    expect(calculateEventRetryDelayMs(50, DEFAULT_EVENT_RETRY_BASE_MS))
      .toBe(MAX_EVENT_RETRY_DELAY_MS);
  });
});

describe('event outbox stale lease recovery', () => {
  it('returns abandoned leases to the pending pool', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    await repositories.outbox.claimNext({
      now: new Date('2025-01-01T00:00:00.000Z'),
      leaseMs: 1_000,
      owner: 'dead-worker',
    });

    expect(await recoverStaleEventDeliveryLeases({
      repositories,
      now: new Date('2025-01-01T00:01:00.000Z'),
    })).toBe(1);
    expect(rows()[0]).toMatchObject({ status: 'pending', lease_owner: null });
  });
});

describe('packaged event outbox dispatcher runtime', () => {
  it('does not recover or claim while dormant and drains after activation', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    let enabled = false;
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;
    const recoverExpired = vi.spyOn(repositories.outbox, 'recoverStaleLeases');
    const claimNext = vi.spyOn(repositories.outbox, 'claimNext');
    const dispatcher = new EventOutboxDispatcher({
      repositories,
      fetchImpl,
      scheduleWakeups: false,
      staleLeaseSweepMs: 3_600_000,
      isEnabled: () => enabled,
    });

    await dispatcher.start();
    await dispatcher.drain();
    expect(recoverExpired).not.toHaveBeenCalled();
    expect(claimNext).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();

    enabled = true;
    await Promise.all([dispatcher.drain(), dispatcher.drain()]);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(rows()[0]).toMatchObject({ status: 'delivered' });
    await dispatcher.stop();
  });

  it('recovers stale leases at startup, drains, and stops cleanly', async () => {
    addWebhook('a', ['sync.completed']);
    enqueue('k1');
    await repositories.outbox.claimNext({
      now: new Date(Date.now() - 600_000),
      leaseMs: 1_000,
      owner: 'previous-worker',
    });
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;
    const dispatcher = new EventOutboxDispatcher({
      repositories,
      fetchImpl,
      scheduleWakeups: false,
      staleLeaseSweepMs: 3_600_000,
    });

    await dispatcher.start();
    await dispatcher.drain();

    expect(rows()[0]).toMatchObject({ status: 'delivered' });

    await dispatcher.stop();
    enqueue('k2');
    expect(await dispatcher.drain()).toBe(0);
  });

  it('routes wake-ups to the running dispatcher and releases them on stop', async () => {
    const wake = await import('@/lib/events/dispatcher-wake');
    addWebhook('a', ['sync.completed']);
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;
    const dispatcher = new EventOutboxDispatcher({
      repositories,
      fetchImpl,
      scheduleWakeups: false,
      staleLeaseSweepMs: 3_600_000,
    });
    await dispatcher.start();

    enqueue('k1');
    wake.wakeEventOutboxDispatcher();
    await new Promise((r) => setTimeout(r, 50));

    expect(rows()[0]).toMatchObject({ status: 'delivered' });
    await dispatcher.stop();
  });

  it('can restart cleanly after a graceful stop', async () => {
    addWebhook('a', ['sync.completed']);
    const fetchImpl = vi.fn(async () => response(204)) as unknown as typeof fetch;
    const dispatcher = new EventOutboxDispatcher({
      repositories,
      fetchImpl,
      scheduleWakeups: false,
      staleLeaseSweepMs: 3_600_000,
    });

    await dispatcher.start();
    await dispatcher.stop();
    enqueue('k1');
    await dispatcher.start();
    await dispatcher.drain();

    expect(rows()[0]).toMatchObject({ status: 'delivered' });
    await dispatcher.stop();
  });
});
