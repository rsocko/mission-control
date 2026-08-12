import db from '@/db';
import { tasks } from '@/db/schema';
import { and, eq, isNull, like, lt, ne, not, or } from 'drizzle-orm';

const PUSH_LEASE_MS = 5 * 60 * 1000;

export async function claimTaskForPush(taskId: string): Promise<string | null> {
  const now = new Date();
  const leaseToken = now.toISOString();
  const staleBefore = new Date(now.getTime() - PUSH_LEASE_MS).toISOString();
  const claimed = await db.update(tasks).set({
    syncStatus: 'pushing',
    lastSyncedAt: leaseToken,
  }).where(and(
    eq(tasks.id, taskId),
    or(
      eq(tasks.syncStatus, 'pending_push'),
      eq(tasks.syncStatus, 'push_error'),
      eq(tasks.syncStatus, 'pushing'),
      like(tasks.sourceId, 'local:%'),
      and(
        eq(tasks.isChecklistItem, true),
        eq(tasks.sourceId, tasks.id),
        not(eq(tasks.syncStatus, 'push_failed')),
      ),
    ),
    or(
      ne(tasks.syncStatus, 'pushing'),
      isNull(tasks.lastSyncedAt),
      lt(tasks.lastSyncedAt, staleBefore),
    ),
  )).returning({ id: tasks.id }).get();

  return claimed ? leaseToken : null;
}

export async function releaseTaskPush(
  taskId: string,
  leaseToken: string,
  syncStatus: string | null,
  expectedTaskVersion?: string,
): Promise<boolean> {
  const released = await db.update(tasks).set({
    syncStatus: syncStatus ?? 'pending_push',
    lastSyncedAt: new Date().toISOString(),
  }).where(and(
    eq(tasks.id, taskId),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, leaseToken),
    expectedTaskVersion === undefined ? undefined : eq(tasks.updatedAt, expectedTaskVersion),
  )).returning({ id: tasks.id }).get();
  return Boolean(released);
}

export async function loadClaimedTaskForPush(
  taskId: string,
  leaseToken: string,
): Promise<typeof tasks.$inferSelect | null> {
  const task = await db.select().from(tasks).where(and(
    eq(tasks.id, taskId),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, leaseToken),
  )).limit(1).get();
  return task ?? null;
}

export async function completeTaskPush(
  taskId: string,
  leaseToken: string,
  sourceId: string,
  metadata?: Record<string, unknown>,
  localUpdates?: {
    status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
    completedAt?: string | null;
  },
  expectedTaskVersion?: string,
): Promise<boolean> {
  const completed = await db.update(tasks).set({
    sourceId,
    syncStatus: 'synced',
    lastSyncedAt: new Date().toISOString(),
    ...(metadata ? { metadata: JSON.stringify(metadata) } : {}),
    ...localUpdates,
  }).where(and(
    eq(tasks.id, taskId),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, leaseToken),
    expectedTaskVersion === undefined ? undefined : eq(tasks.updatedAt, expectedTaskVersion),
  )).returning({ id: tasks.id }).get();

  return Boolean(completed);
}

export async function heartbeatTaskPush(
  taskId: string,
  leaseToken: string,
): Promise<string | null> {
  const renewedToken = new Date(
    Math.max(Date.now(), new Date(leaseToken).getTime() + 1),
  ).toISOString();
  const renewed = await db.update(tasks).set({
    lastSyncedAt: renewedToken,
  }).where(and(
    eq(tasks.id, taskId),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, leaseToken),
  )).returning({ id: tasks.id }).get();

  return renewed ? renewedToken : null;
}

export async function failTaskPush(
  taskId: string,
  leaseToken: string,
  syncStatus: 'push_error' | 'push_failed' = 'push_error',
  pushRetryCount?: number,
  expectedTaskVersion?: string,
): Promise<boolean> {
  const failed = await db.update(tasks).set({
    syncStatus,
    lastSyncedAt: new Date().toISOString(),
    ...(pushRetryCount === undefined ? {} : { pushRetryCount }),
  }).where(and(
    eq(tasks.id, taskId),
    eq(tasks.syncStatus, 'pushing'),
    eq(tasks.lastSyncedAt, leaseToken),
    expectedTaskVersion === undefined ? undefined : eq(tasks.updatedAt, expectedTaskVersion),
  )).returning({ id: tasks.id }).get();

  return Boolean(failed);
}
