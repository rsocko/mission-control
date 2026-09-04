import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { notificationWebRepositoryContractSuite } from '../contracts/notification-web-repository.contract';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-notification-web-'));
process.env.MC_DB_PATH = join(testDirectory, 'notification-web.db');

describe('SQLite NotificationWebPersistence', () => {
  let repo: NotificationWebPersistence;
  let sqlite: ReturnType<typeof import('@/db')> extends Promise<infer T> ? T['sqlite'] : never;

  beforeAll(async () => {
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.resetModules();
    const dbModule = await import('@/db');
    sqlite = dbModule.sqlite;
    const { createSqliteNotificationWebRepository } = await import(
      '@/db/persistence/sqlite-notification-web-repository'
    );
    repo = createSqliteNotificationWebRepository(sqlite);
  });

  afterAll(() => {
    sqlite?.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.MC_DB_PATH;
  });

  notificationWebRepositoryContractSuite(
    () => 'SQLite',
    () => repo,
  );

  it('recoverStaleActions does not throw on empty database', () => {
    expect(() => repo.recoverStaleActions(new Date().toISOString())).not.toThrow();
  });

  it('mutateNotificationsAndEnqueueWritebacks returns empty for no IDs', () => {
    const result = repo.mutateNotificationsAndEnqueueWritebacks([], 'mark_read', new Date().toISOString());
    expect(result).toEqual({ updatedCount: 0, queuedCount: 0, results: [] });
  });

  it('dismissNotificationsAndEnqueueWritebacks returns empty for no IDs', () => {
    const result = repo.dismissNotificationsAndEnqueueWritebacks([], new Date().toISOString());
    expect(result).toEqual({ updatedCount: 0, queuedCount: 0 });
  });

  it('claimNextConnectorBatch returns empty when no jobs pending', () => {
    const result = repo.claimNextConnectorBatch({
      batchSize: 50,
      leaseMs: 60000,
      singleJobConnectorIds: new Set(),
    });
    expect(result).toEqual([]);
  });

  it('getNextScheduledWriteback returns null when no jobs', () => {
    const result = repo.getNextScheduledWriteback();
    expect(result).toBeNull();
  });

  it('retryWritebacks returns empty when no retryable jobs', () => {
    const { retried } = repo.retryWritebacks('id', ['nonexistent'], new Date().toISOString());
    expect(retried).toEqual([]);
  });
});
