import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_NOTIFICATION_PUSH_PREFERENCES } from '@/db/persistence/notification-push';
import { _runMigrationsIndividually } from '@/db';
import { createSqliteNotificationPushRepository } from '@/db/persistence/sqlite-notification-push-repository';
import {
  describeNotificationPushRepositoryContract,
  NOTIFICATION_PUSH_TEST_TIME,
  type NotificationPushContractHarness,
} from '../contracts/notification-push-repository.contract';

const sqlite = new Database(':memory:');
sqlite.pragma('foreign_keys = ON');
_runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

async function createHarness(): Promise<NotificationPushContractHarness> {
  return {
    repository: createSqliteNotificationPushRepository(sqlite),
    async reset() {
      sqlite.prepare(`DELETE FROM connector_configs WHERE id LIKE 'calendar-%'`).run();
      sqlite.prepare(`DELETE FROM push_preferences WHERE id = 'default'`).run();
      sqlite.prepare(`
        DELETE FROM app_settings
        WHERE key IN ('push_delivery_enabled', 'scheduled_summaries_enabled')
      `).run();
    },
    async seedSetting(key, value) {
      sqlite.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(key, JSON.stringify(value), NOTIFICATION_PUSH_TEST_TIME);
    },
    async seedCalendarConnector(input) {
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials,
          settings, synced_lists, created_at, updated_at, deleted_at
        ) VALUES (?, 'outlook-calendar', 'Calendar', ?, 'poll', '{}', ?, '{}', '[]', ?, ?, ?)
      `).run(
        input.id,
        input.enabled === false ? 0 : 1,
        JSON.stringify(input.credentials),
        NOTIFICATION_PUSH_TEST_TIME,
        NOTIFICATION_PUSH_TEST_TIME,
        input.deleted ? NOTIFICATION_PUSH_TEST_TIME : null,
      );
    },
  };
}

describe('SQLite notification push repository', () => {
  describeNotificationPushRepositoryContract(createHarness);

  it('waits for a concurrent writer before preserving an omitted master switch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-notification-push-'));
    const databasePath = join(directory, 'concurrency.db');
    const setup = new Database(databasePath);
    _runMigrationsIndividually(setup, resolve(process.cwd(), 'drizzle'));
    setup.close();

    const connection = new Database(databasePath);
    connection.pragma('busy_timeout = 2000');
    const repository = createSqliteNotificationPushRepository(connection);
    const writer = new Worker(`
      const Database = require('better-sqlite3');
      const { parentPort, workerData } = require('node:worker_threads');
      const db = new Database(workerData);
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
      ).run('push_delivery_enabled', 'false', '${NOTIFICATION_PUSH_TEST_TIME}');
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
      db.exec('COMMIT');
      db.close();
    `, { eval: true, workerData: databasePath });

    try {
      await new Promise<void>((resolveLocked, reject) => {
        writer.once('message', () => resolveLocked());
        writer.once('error', reject);
      });
      await repository.savePreferences({
        preferences: { ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES, morningHour: 9 },
        updatedAt: NOTIFICATION_PUSH_TEST_TIME,
      });
      await expect(repository.getPushDeliveryEnabled()).resolves.toBe(false);
    } finally {
      await writer.terminate();
      connection.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

afterAll(() => {
  sqlite.close();
});
