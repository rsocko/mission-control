import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  initializeDatabaseWithRetry,
  isRetryableDatabaseStartupError,
} from '@/db/startup';
import { shouldRunDatabaseInitialization } from '@/db';

vi.mock('@/lib/logger', () => ({
  dbLogger: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

describe('database startup', () => {
  it('assigns schema initialization to the web process only', () => {
    expect(shouldRunDatabaseInitialization('web')).toBe(true);
    expect(shouldRunDatabaseInitialization('worker')).toBe(false);
    expect(shouldRunDatabaseInitialization('worker', 'worker')).toBe(true);
  });

  it('retries transient lock contention with exponential backoff', async () => {
    const locked = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
    const initialize = vi.fn()
      .mockImplementationOnce(() => { throw locked; })
      .mockImplementationOnce(() => { throw locked; })
      .mockImplementationOnce(() => undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);

    await initializeDatabaseWithRetry({
      initialize,
      maxAttempts: 3,
      retryBaseMs: 10,
      sleep,
    });

    expect(initialize).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 10);
    expect(sleep).toHaveBeenNthCalledWith(2, 20);
  });

  it('surfaces the final lock error after bounded attempts', async () => {
    const locked = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });
    const initialize = vi.fn(() => { throw locked; });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(initializeDatabaseWithRetry({
      initialize,
      maxAttempts: 2,
      retryBaseMs: 10,
      sleep,
    })).rejects.toBe(locked);

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('awaits and retries transient PostgreSQL startup failures', async () => {
    const unavailable = Object.assign(new Error('database unavailable'), {
      code: '57P03',
    });
    const initialize = vi.fn()
      .mockRejectedValueOnce(unavailable)
      .mockResolvedValueOnce('ready');
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(initializeDatabaseWithRetry({
      initialize,
      maxAttempts: 2,
      retryBaseMs: 10,
      sleep,
    })).resolves.toBe('ready');

    expect(initialize).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it('recovers from a real competing SQLite writer', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mc-startup-lock-'));
    const databasePath = join(directory, 'startup.db');
    const holder = new Database(databasePath);
    holder.pragma('journal_mode = WAL');
    holder.pragma('busy_timeout = 10');
    holder.exec('CREATE TABLE existing_data (id INTEGER PRIMARY KEY)');
    holder.exec('BEGIN IMMEDIATE');

    let attempts = 0;
    const initialize = () => {
      attempts++;
      const contender = new Database(databasePath);
      contender.pragma('busy_timeout = 10');
      try {
        contender.exec('CREATE TABLE startup_marker (id INTEGER PRIMARY KEY)');
      } finally {
        contender.close();
      }
    };

    try {
      await initializeDatabaseWithRetry({
        initialize,
        maxAttempts: 2,
        retryBaseMs: 1,
        sleep: async () => {
          holder.exec('ROLLBACK');
        },
      });

      expect(attempts).toBe(2);
      expect(holder.prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'startup_marker'
      `).get()).toBeTruthy();
    } finally {
      if (holder.inTransaction) holder.exec('ROLLBACK');
      holder.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('does not retry non-lock startup failures', async () => {
    const failure = Object.assign(new Error('database disk image is malformed'), {
      code: 'SQLITE_CORRUPT',
    });
    const initialize = vi.fn(() => { throw failure; });
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(initializeDatabaseWithRetry({
      initialize,
      maxAttempts: 5,
      sleep,
    })).rejects.toBe(failure);

    expect(initialize).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('recognizes wrapped SQLite lock errors', () => {
    expect(isRetryableDatabaseStartupError({
      cause: { code: 'SQLITE_LOCKED' },
    })).toBe(true);
  });
});
