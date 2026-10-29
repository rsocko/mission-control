import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import type { NotificationPushPersistence } from '@/db/persistence/notification-push';
import { createSqliteNotificationPushRepository } from '@/db/persistence/sqlite-notification-push-repository';

vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let triggerTriageNudge: typeof import('@/lib/push/triggers').triggerTriageNudge;
let getTriageNudgeHighWater: typeof import('@/lib/push/triggers').getTriageNudgeHighWater;
let pushPersistence: NotificationPushPersistence;

const clock = vi.hoisted(() => ({ today: '2026-10-29' }));
vi.mock('@/lib/utils/date', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/utils/date')>(),
  getLocalToday: () => clock.today,
}));

vi.mock('@/lib/push/notification-push-service', () => ({
  getNotificationPushPersistence: async () => pushPersistence,
}));
vi.mock('@/lib/notifications/dispatcher-wake', () => ({
  wakeNotificationDeliveryDispatcher: vi.fn(),
}));

beforeAll(async () => {
  const database = await import('@/db');
  db = database.default;
  schema = await import('@/db/schema');
  pushPersistence = createSqliteNotificationPushRepository(database.sqlite);
  await database.initializeSqlitePersistenceComposition();
  ({ triggerTriageNudge, getTriageNudgeHighWater } = await import('@/lib/push/triggers'));
});

beforeEach(() => {
  clock.today = '2026-10-29';
  db.delete(schema.notificationDeliveryEvents).run();
  db.delete(schema.notifications).run();
  db.delete(schema.triageItems).run();
  db.delete(schema.pushPreferences).run();
  db.delete(schema.pushSubscriptions).run();
  db.delete(schema.appSettings).run();
  db.insert(schema.pushPreferences).values({
    id: 'default',
    morningEnabled: true,
    morningHour: 8,
    triageNudgeEnabled: true,
    triageNudgeThreshold: 3,
    carryForwardEnabled: true,
    carryForwardHour: 18,
    quietStart: null,
    quietEnd: null,
    doNotDisturb: false,
    updatedAt: new Date().toISOString(),
  }).run();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function addPendingTriageItem(index: number) {
  const now = new Date().toISOString();
  db.insert(schema.triageItems).values({
    id: `triage-${index}`,
    sourcePlatform: 'web',
    sourceId: `source-${index}`,
    sourceUrl: `https://example.test/${index}`,
    title: `Triage item ${index}`,
    capturedAt: now,
    ingestedAt: now,
  }).run();
}

describe('scheduled triage nudge deduplication', () => {
  it('updates one card on growth without repeating delivery for the same daily high-water mark', async () => {
    addPendingTriageItem(1);
    addPendingTriageItem(2);
    addPendingTriageItem(3);

    await triggerTriageNudge();
    const [original] = db.select().from(schema.notifications).all();
    expect(original.sourceId).toBe('push:triage_nudge');
    expect(await getTriageNudgeHighWater()).toBe(3);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(2);

    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(2);

    addPendingTriageItem(4);
    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toMatchObject([{
      id: original.id,
      sourceId: 'push:triage_nudge',
      body: '4 items waiting for review. Quick triage session?',
      metadata: { queueSize: 4 },
    }]);
    expect(await getTriageNudgeHighWater()).toBe(4);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(4);

    db.delete(schema.triageItems).where(
      eq(schema.triageItems.id, 'triage-4'),
    ).run();
    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(await getTriageNudgeHighWater()).toBe(4);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(4);
  });

  it('reuses the same card and delivers a new occurrence on the next local day', async () => {
    for (let index = 1; index <= 3; index++) addPendingTriageItem(index);
    await triggerTriageNudge();
    const [original] = db.select().from(schema.notifications).all();

    clock.today = '2026-10-30';
    expect(await getTriageNudgeHighWater()).toBeNull();
    await triggerTriageNudge();
    await triggerTriageNudge();

    expect(db.select().from(schema.notifications).all()).toMatchObject([{
      id: original.id,
      dedupeKey: 'push:triage_nudge:2026-10-30',
    }]);
    expect(await getTriageNudgeHighWater()).toBe(3);
    expect(db.select().from(schema.notificationDeliveryEvents).all().map(row => row.dedupeKey))
      .toEqual(expect.arrayContaining([
        `web_push:${original.id}:2026-10-29:3`,
        `web_push:${original.id}:2026-10-30:3`,
      ]));
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(4);
  });

  it('reopens a handled reminder on growth while retaining one card', async () => {
    for (let index = 1; index <= 3; index++) addPendingTriageItem(index);
    await triggerTriageNudge();
    const [original] = db.select().from(schema.notifications).all();
    db.update(schema.notifications).set({
      disposition: 'handled',
      readState: 'read',
      state: 'archived',
    }).where(eq(schema.notifications.id, original.id)).run();

    addPendingTriageItem(4);
    await triggerTriageNudge();

    expect(db.select().from(schema.notifications).all()).toMatchObject([{
      id: original.id,
      disposition: 'inbox',
      readState: 'unread',
    }]);
  });

  it('does not undo a dismissal when the recurring reminder updates', async () => {
    for (let index = 1; index <= 3; index++) addPendingTriageItem(index);
    await triggerTriageNudge();
    const [original] = db.select().from(schema.notifications).all();
    db.update(schema.notifications).set({
      disposition: 'dismissed',
      readState: 'read',
      state: 'dismissed',
    }).where(eq(schema.notifications.id, original.id)).run();

    clock.today = '2026-10-30';
    await triggerTriageNudge();

    expect(db.select().from(schema.notifications).all()).toMatchObject([{
      id: original.id,
      disposition: 'dismissed',
      readState: 'read',
    }]);
    expect(db.select().from(schema.notificationDeliveryEvents).all().slice(-2))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ status: 'suppressed', suppressionReason: 'not_attention_eligible' }),
      ]));
  });

  it('creates only one card and one set of deliveries for concurrent checks', async () => {
    for (let index = 1; index <= 3; index++) addPendingTriageItem(index);
    await Promise.all([triggerTriageNudge(), triggerTriageNudge()]);

    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(db.select().from(schema.notificationDeliveryEvents).all()).toHaveLength(2);
  });

  it('reports queued delivery when updating an existing reminder', async () => {
    vi.stubEnv('VAPID_PUBLIC_KEY', 'inert-public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'inert-private-key');
    db.insert(schema.pushSubscriptions).values({
      id: 'triage-web-push',
      endpoint: 'https://example.test/push',
      keys: { p256dh: 'inert-key', auth: 'inert-auth' },
      createdAt: new Date().toISOString(),
    }).run();
    for (let index = 1; index <= 3; index++) addPendingTriageItem(index);
    expect(await triggerTriageNudge()).toBe(true);

    addPendingTriageItem(4);
    expect(await triggerTriageNudge()).toBe(true);
    expect(await triggerTriageNudge()).toBe(false);
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);
    expect(db.select().from(schema.notificationDeliveryEvents).all()
      .filter(event => event.status === 'pending')).toHaveLength(2);
  });

  it('keeps the threshold and disabled preference gates', async () => {
    addPendingTriageItem(1);
    expect(await triggerTriageNudge()).toBe(false);
    addPendingTriageItem(2);
    addPendingTriageItem(3);
    db.update(schema.pushPreferences).set({ triageNudgeEnabled: false }).run();
    expect(await triggerTriageNudge()).toBe(false);
    expect(db.select().from(schema.notifications).all()).toHaveLength(0);
  });
});
