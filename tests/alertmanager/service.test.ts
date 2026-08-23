import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomelabAlertLifecycleEventV1 } from '@/lib/alertmanager/contracts';

function event(
  overrides: Partial<HomelabAlertLifecycleEventV1> = {},
): HomelabAlertLifecycleEventV1 {
  return {
    schemaVersion: 1,
    eventId: 'event-firing-1',
    occurredAt: '2026-08-22T20:00:00.000Z',
    source: 'alertmanager',
    fingerprint: 'abcdef0123456789',
    status: 'firing',
    startsAt: '2026-08-22T20:00:00.000Z',
    severity: 'critical',
    type: 'homelab_service_unavailable',
    summary: 'Node exporter is unavailable',
    service: 'node-exporter',
    node: 'node-1',
    actionRequired: true,
    metrics: [{ label: 'Unavailable', value: '5m', tone: 'danger' }],
    links: [{ kind: 'dashboard', url: 'https://grafana.example/d/node' }],
    ...overrides,
  };
}

describe('homelab alert lifecycle service', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let ingest: typeof import('@/lib/alertmanager/service').ingestHomelabAlertEvents;
  const receivedAt = new Date('2026-08-22T20:10:00.000Z');

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    [db, { sqlite }, schema, { ingestHomelabAlertEvents: ingest }] = await Promise.all([
      import('@/db').then(module => module.default),
      import('@/db'),
      import('@/db/schema'),
      import('@/lib/alertmanager/service'),
    ]);
  }, 30_000);

  beforeEach(async () => {
    sqlite.exec('DROP TRIGGER IF EXISTS fail_homelab_projection');
    await db.delete(schema.homelabAlertReceipts);
    await db.delete(schema.notificationActions);
    await db.delete(schema.notificationDeliveryEvents);
    await db.delete(schema.notifications);
  });

  afterAll(() => {
    sqlite?.close();
    delete process.env.MC_DB_PATH;
  });

  it('deduplicates concurrent repeat deliveries into one projection and receipt', async () => {
    const results = await Promise.all([
      Promise.resolve().then(() => ingest([event()], {
        integration: 'homelab',
        receivedAt,
        wakeDispatcher: false,
      })),
      Promise.resolve().then(() => ingest([event()], {
        integration: 'homelab',
        receivedAt,
        wakeDispatcher: false,
      })),
    ]);

    expect(results.map(result => result.created).sort()).toEqual([0, 1]);
    expect(await db.select().from(schema.notifications)).toHaveLength(1);
    const [receipt] = await db.select().from(schema.homelabAlertReceipts);
    expect(receipt).toMatchObject({ deliveryCount: 2, applied: true });
  });

  it('settles firing incidents and rejects stale firing regression', async () => {
    ingest([event()], { integration: 'homelab', receivedAt, wakeDispatcher: false });
    ingest([event({
      eventId: 'event-resolved-1',
      status: 'resolved',
      occurredAt: '2026-08-22T20:30:00.000Z',
      endsAt: '2026-08-22T20:30:00.000Z',
    })], { integration: 'homelab', receivedAt, wakeDispatcher: false });
    const stale = ingest([event({
      eventId: 'event-firing-stale',
      occurredAt: '2026-08-22T20:00:00.000Z',
    })], { integration: 'homelab', receivedAt, wakeDispatcher: false });

    expect(stale).toMatchObject({ applied: 0, stale: 1 });
    const [notification] = await db.select().from(schema.notifications);
    expect(notification).toMatchObject({
      sourceId: 'homelab:alertmanager:abcdef0123456789',
      sourceState: 'resolved',
      state: 'resolved',
      lastSourceActivityAt: '2026-08-22T20:30:00.000Z',
    });
  });

  it('preserves local handling through resolution and reopens a new occurrence', async () => {
    ingest([event()], { integration: 'homelab', receivedAt, wakeDispatcher: false });
    await db.update(schema.notifications).set({
      disposition: 'handled',
      state: 'archived',
      handledAt: receivedAt.toISOString(),
    });
    ingest([event({
      eventId: 'event-resolved-1',
      status: 'resolved',
      occurredAt: '2026-08-22T20:30:00.000Z',
      endsAt: '2026-08-22T20:30:00.000Z',
    })], { integration: 'homelab', receivedAt, wakeDispatcher: false });
    expect((await db.select().from(schema.notifications))[0].disposition).toBe('handled');

    ingest([event({
      eventId: 'event-firing-2',
      startsAt: '2026-08-22T21:00:00.000Z',
      occurredAt: '2026-08-22T21:00:00.000Z',
    })], { integration: 'homelab', receivedAt, wakeDispatcher: false });
    expect((await db.select().from(schema.notifications))[0]).toMatchObject({
      sourceState: 'active',
      disposition: 'inbox',
      readState: 'unread',
      state: 'unread',
    });
  });

  it('rolls back all receipts and projections when any batch write fails', async () => {
    sqlite.exec(`
      CREATE TRIGGER fail_homelab_projection
      BEFORE INSERT ON notifications
      WHEN NEW.source_id = 'homelab:alertmanager:bad02'
      BEGIN
        SELECT RAISE(ABORT, 'simulated storage failure');
      END
    `);

    expect(() => ingest([
      event({ fingerprint: 'good01', eventId: 'good-event' }),
      event({ fingerprint: 'bad02', eventId: 'bad-event' }),
    ], { integration: 'homelab', receivedAt, wakeDispatcher: false }))
      .toThrow(/simulated storage failure/);
    expect(await db.select().from(schema.notifications)).toEqual([]);
    expect(await db.select().from(schema.homelabAlertReceipts)).toEqual([]);
  });
});
