/**
 * Shared contract tests for NotificationWebPersistence implementations.
 * Both SQLite and PostgreSQL adapters must pass these tests.
 */
import { describe, expect, it } from 'vitest';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

export function notificationWebRepositoryContractSuite(
  getName: () => string,
  getRepo: () => NotificationWebPersistence,
) {
  describe(`NotificationWebPersistence contract: ${getName()}`, () => {
    it('queryNotifications returns empty result for empty database', async () => {
      const repo = getRepo();
      const result = await repo.queryNotifications({
        query: {
          q: null, level: null, category: null, merchant: null,
          source: null, sourceAccount: null, state: null,
          actionableOnly: false, dateRange: null, repository: null,
          owner: null, reason: null, subjectType: null,
          participating: false, sort: 'newest',
        },
        limit: 50,
        cursor: null,
      });
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.stats.total).toBe(0);
    });

    it('listSavedViews returns empty array initially', async () => {
      const repo = getRepo();
      const views = await repo.listSavedViews();
      expect(views).toEqual([]);
    });

    it('createSavedView and deleteSavedView round-trip', async () => {
      const repo = getRepo();
      const now = new Date().toISOString();
      const view = await repo.createSavedView({
        id: 'test-view-1',
        name: 'Test View',
        query: { state: 'unread', q: null, level: null, category: null, merchant: null, source: null, sourceAccount: null, actionableOnly: false, dateRange: null, repository: null, owner: null, reason: null, subjectType: null, participating: false, sort: 'newest' as const },
        now,
      });
      expect(view.name).toBe('Test View');
      const views = await repo.listSavedViews();
      expect(views.length).toBeGreaterThanOrEqual(1);
      const deleted = await repo.deleteSavedView('test-view-1');
      expect(deleted).toBe(true);
      const deletedAgain = await repo.deleteSavedView('test-view-1');
      expect(deletedAgain).toBe(false);
    });

    it('findSubscriptionByEndpoint returns null for non-existent', async () => {
      const repo = getRepo();
      const result = await repo.findSubscriptionByEndpoint('https://example.com/nonexistent');
      expect(result).toBeNull();
    });

    it('registerSubscription and findSubscriptionByEndpoint round-trip', async () => {
      const repo = getRepo();
      const id = await repo.registerSubscription({
        endpoint: 'https://fcm.googleapis.com/test-endpoint-1',
        keys: { p256dh: 'test-p256dh', auth: 'test-auth' },
        userAgent: 'TestAgent/1.0',
      });
      expect(typeof id).toBe('string');
      const found = await repo.findSubscriptionByEndpoint('https://fcm.googleapis.com/test-endpoint-1');
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
    });

    it('removeSubscription is idempotent', async () => {
      const repo = getRepo();
      await repo.removeSubscription('https://fcm.googleapis.com/nonexistent');
      // No error thrown
    });

    it('snoozeNotification returns false for non-existent', async () => {
      const repo = getRepo();
      const result = await repo.snoozeNotification('nonexistent', new Date().toISOString());
      expect(result).toBe(false);
    });

    it('listWritebackStatus returns synced for empty database', async () => {
      const repo = getRepo();
      const status = await repo.listWritebackStatus(null);
      expect(status.syncState).toBe('synced');
      expect(status.jobs).toEqual([]);
    });
  });
}
