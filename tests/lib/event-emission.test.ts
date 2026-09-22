import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';
import { createSqliteEventDeliveryRepositories } from '@/db/persistence/sqlite-event-outbox-repository';
import type { EventDeliveryRepositories } from '@/db/persistence/event-outbox';
import { emitEvent, sendWebhookEvent } from '@/lib/events';
import {
  clearEventOutboxWakeRetry,
  registerEventOutboxDrain,
} from '@/lib/events/dispatcher-wake';
import { buildEventSignature, MissingEventSigningSecretError } from '@/lib/events/signing';

let sqlite: Database.Database;
let repositories: EventDeliveryRepositories;
let drains = 0;

beforeEach(() => {
  drains = 0;
  registerEventOutboxDrain(async () => {
    drains += 1;
  });
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));
  repositories = createSqliteEventDeliveryRepositories(sqlite);
  sqlite.prepare(`
    INSERT INTO outbound_webhooks (id, name, url, secret, event_types, enabled, created_at)
    VALUES ('a', 'Hook', 'https://receiver.test/a', 'sekret', '["task.created"]', 1, 'now')
  `).run();
});

afterEach(() => {
  registerEventOutboxDrain(null);
  clearEventOutboxWakeRetry();
  sqlite.close();
});

describe('emitEvent public semantics', () => {
  it('durably records an ad-hoc event and fans it out to matching subscriptions', async () => {
    await emitEvent(
      {
        type: 'task.created',
        timestamp: '2025-01-01T00:00:00.000Z',
        payload: { id: 't1' },
      },
      { repositories },
    );

    const event = sqlite.prepare('SELECT * FROM event_outbox').get() as Record<string, unknown>;
    expect(event).toMatchObject({
      event_type: 'task.created',
      occurred_at: '2025-01-01T00:00:00.000Z',
    });
    expect(JSON.parse(String(event.payload))).toEqual({ id: 't1' });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM event_outbox_deliveries').get(),
    ).toEqual({ n: 1 });
    await new Promise((r) => setTimeout(r, 5));
    expect(drains).toBe(1);
  });

  it('gives every keyless caller a distinct event, preserving prior emit semantics', async () => {
    const event = {
      type: 'task.created' as const,
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { id: 't1' },
    };
    await emitEvent(event, { repositories });
    await emitEvent(event, { repositories });

    expect(sqlite.prepare('SELECT count(*) AS n FROM event_outbox').get()).toEqual({ n: 2 });
  });

  it('deduplicates callers that supply a durable stable key', async () => {
    const event = {
      type: 'task.created' as const,
      timestamp: '2025-01-01T00:00:00.000Z',
      payload: { id: 't1' },
    };
    await emitEvent(event, { repositories, stableKey: 'task.created:t1' });
    await emitEvent(event, { repositories, stableKey: 'task.created:t1' });

    expect(sqlite.prepare('SELECT count(*) AS n FROM event_outbox').get()).toEqual({ n: 1 });
    expect(
      sqlite.prepare('SELECT count(*) AS n FROM event_outbox_deliveries').get(),
    ).toEqual({ n: 1 });
  });

  it('does not swallow a persistence failure', async () => {
    const failing = {
      subscriptions: repositories.subscriptions,
      outbox: {
        ...repositories.outbox,
        enqueue: vi.fn(async () => {
          throw new Error('outbox unavailable');
        }),
      },
    } as unknown as EventDeliveryRepositories;

    await expect(emitEvent(
      { type: 'task.created', timestamp: 'now', payload: {} },
      { repositories: failing },
    )).rejects.toThrow('outbox unavailable');
  });
});

describe('sendWebhookEvent', () => {
  const webhook = {
    id: 'a',
    name: 'Hook',
    url: 'https://receiver.test/a',
    secret: 'sekret',
    eventTypes: ['task.created'],
    enabled: true,
  };

  it('signs and records the outcome of a one-shot test delivery', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 204 }),
    );

    try {
      const result = await sendWebhookEvent(
        webhook,
        { type: 'task.created', timestamp: 'now', payload: { id: 't1' } },
        { repositories },
      );

      expect(result).toEqual({ ok: true, status: 204 });
      const init = fetchSpy.mock.calls[0][1] as RequestInit & {
        headers: Record<string, string>;
      };
      expect(init.headers['X-MC-Signature']).toBe(
        buildEventSignature(JSON.stringify({ id: 't1' }), 'sekret'),
      );
      expect(sqlite.prepare(
        'SELECT last_status FROM outbound_webhooks WHERE id = ?',
      ).get('a')).toEqual({ last_status: 204 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('reports failure without throwing when the receiver rejects', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('nope', { status: 500 }),
    );

    try {
      await expect(sendWebhookEvent(
        webhook,
        { type: 'task.created', timestamp: 'now', payload: {} },
        { repositories },
      )).resolves.toEqual({ ok: false, status: 500 });
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('event signing', () => {
  it('produces a stable sha256 hmac over the exact body', () => {
    expect(buildEventSignature('{"a":1}', 'k')).toBe(buildEventSignature('{"a":1}', 'k'));
    expect(buildEventSignature('{"a":1}', 'k')).not.toBe(buildEventSignature('{"a":2}', 'k'));
    expect(buildEventSignature('{"a":1}', 'k')).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('throws instead of sending an unsigned event when no secret is configured', () => {
    const previous = process.env.MC_EVENT_SECRET;
    delete process.env.MC_EVENT_SECRET;
    try {
      expect(() => buildEventSignature('{}', null)).toThrow(MissingEventSigningSecretError);
    } finally {
      if (previous !== undefined) process.env.MC_EVENT_SECRET = previous;
    }
  });

  it('falls back to the environment secret when the subscription has none', () => {
    const previous = process.env.MC_EVENT_SECRET;
    process.env.MC_EVENT_SECRET = 'env-secret';
    try {
      expect(buildEventSignature('{}', null)).toBe(buildEventSignature('{}', 'env-secret'));
    } finally {
      if (previous === undefined) delete process.env.MC_EVENT_SECRET;
      else process.env.MC_EVENT_SECRET = previous;
    }
  });
});
