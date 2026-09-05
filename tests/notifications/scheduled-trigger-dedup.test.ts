import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NotificationPushPersistence } from '@/db/persistence/notification-push';
import { createSqliteNotificationPushRepository } from '@/db/persistence/sqlite-notification-push-repository';

vi.unmock('drizzle-orm');
process.env.MC_DB_PATH = ':memory:';

let db: typeof import('@/db').default;
let schema: typeof import('@/db/schema');
let triggerTriageNudge: typeof import('@/lib/push/triggers').triggerTriageNudge;
let pushPersistence: NotificationPushPersistence;

vi.mock('@/lib/push/notification-push-service', () => ({
  getNotificationPushPersistence: async () => pushPersistence,
}));

beforeAll(async () => {
  const database = await import('@/db');
  db = database.default;
  schema = await import('@/db/schema');
  pushPersistence = createSqliteNotificationPushRepository(database.sqlite);
  ({ triggerTriageNudge } = await import('@/lib/push/triggers'));
});

beforeEach(() => {
  db.delete(schema.notificationDeliveryEvents).run();
  db.delete(schema.notifications).run();
  db.delete(schema.triageItems).run();
  db.delete(schema.pushPreferences).run();
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
  it('persists a daily high-water mark and only resurfaces when the queue grows', async () => {
    addPendingTriageItem(1);
    addPendingTriageItem(2);
    addPendingTriageItem(3);

    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);

    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(1);

    addPendingTriageItem(4);
    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(2);

    db.delete(schema.triageItems).where(
      (await import('drizzle-orm')).eq(schema.triageItems.id, 'triage-4'),
    ).run();
    await triggerTriageNudge();
    expect(db.select().from(schema.notifications).all()).toHaveLength(2);
  });
});
