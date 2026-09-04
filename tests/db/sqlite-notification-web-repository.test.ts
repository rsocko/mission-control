import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import {
  notificationWebRepositoryContractSuite,
  type ContractSeedNotificationAction,
  type ContractSeedNotification,
  type ContractSeedWritebackJob,
  type ContractSeededJob,
  type ContractSeededNotification,
  type NotificationWebContractSeed,
} from '../contracts/notification-web-repository.contract';
import type { NotificationWebPersistence } from '@/db/persistence/notification-web';

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-notification-web-'));
process.env.MC_DB_PATH = join(testDirectory, 'notification-web.db');

describe('SQLite NotificationWebPersistence', () => {
  let repo: NotificationWebPersistence;
  let sqlite: ReturnType<typeof import('@/db')> extends Promise<infer T> ? T['sqlite'] : never;
  let seed: NotificationWebContractSeed;

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
    seed = createSqliteContractSeed(sqlite);
  });

  afterAll(() => {
    sqlite?.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.MC_DB_PATH;
  });

  notificationWebRepositoryContractSuite(
    () => 'SQLite',
    () => repo,
    () => seed,
  );

  it('recoverStaleActions does not throw on empty database', async () => {
    await expect(repo.recoverStaleActions(new Date().toISOString())).resolves.toBeUndefined();
  });

  it('mutateNotificationsAndEnqueueWritebacks returns empty for no IDs', async () => {
    const result = await repo.mutateNotificationsAndEnqueueWritebacks([], 'mark_read', new Date().toISOString());
    expect(result).toEqual({ updatedCount: 0, queuedCount: 0, results: [] });
  });

  it('dismissNotificationsAndEnqueueWritebacks returns empty for no IDs', async () => {
    const result = await repo.dismissNotificationsAndEnqueueWritebacks([], new Date().toISOString());
    expect(result).toEqual({ updatedCount: 0, queuedCount: 0 });
  });

  it('dismissNotificationsAndEnqueueWritebacksSync returns empty for no IDs', () => {
    const result = repo.dismissNotificationsAndEnqueueWritebacksSync!([], new Date().toISOString());
    expect(result).toEqual({ updatedCount: 0, queuedCount: 0 });
  });

  it('claimNextConnectorBatch returns empty when no jobs pending', async () => {
    const result = await repo.claimNextConnectorBatch({
      batchSize: 50,
      leaseMs: 60000,
      singleJobConnectorIds: new Set(),
    });
    expect(result).toEqual([]);
  });

  it('getNextScheduledWriteback returns null when no jobs', async () => {
    const result = await repo.getNextScheduledWriteback();
    expect(result).toBeNull();
  });

  it('retryWritebacks returns empty when no retryable jobs', async () => {
    const { retried } = await repo.retryWritebacks('id', ['nonexistent'], new Date().toISOString());
    expect(retried).toEqual([]);
  });
});

type SqliteStatement = {
  run: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
  get: (...params: unknown[]) => unknown;
};
type SqliteHandle = { prepare: (sql: string) => SqliteStatement };

function createSqliteContractSeed(sqlite: SqliteHandle): NotificationWebContractSeed {
  return {
    async reset() {
      sqlite.prepare('DELETE FROM notification_writeback_jobs').run();
      sqlite.prepare('DELETE FROM notification_saved_views').run();
      sqlite.prepare('DELETE FROM push_subscriptions').run();
      sqlite.prepare('DELETE FROM notification_actions').run();
      sqlite.prepare('DELETE FROM notifications').run();
    },
    async insertNotification(row: ContractSeedNotification) {
      sqlite.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id,
          title, received_at, sort_at, metadata, presentation, is_actionable
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.sourceId, row.connectorType, row.connectorInstanceId,
        row.title, row.receivedAt, row.sortAt,
        JSON.stringify(row.metadata ?? {}),
        JSON.stringify(row.presentation ?? {}),
        row.isActionable ? 1 : 0,
      );
    },
    async insertNotificationAction(row: ContractSeedNotificationAction) {
      sqlite.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, label, is_primary, payload,
          opens_external, requires_confirmation
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id,
        row.notificationId,
        row.actionType,
        row.label,
        row.isPrimary ? 1 : 0,
        JSON.stringify(row.payload ?? {}),
        row.opensExternal ? 1 : 0,
        row.requiresConfirmation ? 1 : 0,
      );
    },
    async insertWritebackJob(row: ContractSeedWritebackJob) {
      sqlite.prepare(`
        INSERT INTO notification_writeback_jobs (
          id, notification_id, connector_instance_id, connector_type, source_id,
          action_type, dedupe_key, status, retryable, attempt_count, max_attempts,
          next_attempt_at, lease_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.id, row.notificationId, row.connectorInstanceId, row.connectorType, row.sourceId,
        row.actionType, row.dedupeKey, row.status, row.retryable ? 1 : 0,
        row.attemptCount, row.maxAttempts, row.nextAttemptAt, row.leaseExpiresAt,
        row.createdAt, row.updatedAt,
      );
    },
    async getNotification(id: string): Promise<ContractSeededNotification | null> {
      const found = sqlite.prepare(`
        SELECT read_state AS readState, disposition, sync_state AS syncState,
               muted_at AS mutedAt, presentation
        FROM notifications WHERE id = ?
      `).get(id) as
        | { readState: string; disposition: string; syncState: string; mutedAt: string | null; presentation: unknown }
        | undefined;
      return found ?? null;
    },
    async listWritebackJobs(notificationId?: string): Promise<ContractSeededJob[]> {
      const where = notificationId ? 'WHERE notification_id = ?' : '';
      const params = notificationId ? [notificationId] : [];
      const rows = sqlite.prepare(`
        SELECT id, notification_id AS notificationId, status,
               retryable, attempt_count AS attemptCount, max_attempts AS maxAttempts,
               next_attempt_at AS nextAttemptAt, lease_expires_at AS leaseExpiresAt,
               last_error AS lastError
        FROM notification_writeback_jobs ${where}
        ORDER BY created_at ASC, id ASC
      `).all(...params) as Array<ContractSeededJob & { retryable: number | boolean }>;
      return rows.map(row => ({
        ...row,
        retryable: row.retryable === 1 || row.retryable === true,
      }));
    },
  };
}
