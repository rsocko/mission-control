import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

vi.unmock('drizzle-orm');

const require = createRequire(import.meta.url);
const betterSqlitePath = require.resolve('better-sqlite3');
const directory = mkdtempSync(join(tmpdir(), 'mission-control-contention-'));
const databasePath = join(directory, 'contention.db');
const originalDatabasePath = process.env.MC_DB_PATH;
process.env.MC_DB_PATH = databasePath;

type DatabaseModule = typeof import('@/db');

let databaseModule: DatabaseModule;

function startCompetingWrite(
  statement: string,
  state: Int32Array,
): { worker: Worker; completion: Promise<unknown[]> } {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const Database = require(workerData.betterSqlitePath);
    const database = new Database(workerData.databasePath);
    database.pragma('busy_timeout = 2000');
    parentPort.once('message', () => {
      Atomics.store(workerData.state, 0, 1);
      Atomics.notify(workerData.state, 0);
      database.exec(workerData.statement);
      Atomics.store(workerData.state, 0, 2);
      Atomics.notify(workerData.state, 0);
      database.close();
    });
  `, {
    eval: true,
    workerData: {
      betterSqlitePath,
      databasePath,
      state,
      statement,
    },
  });

  return { worker, completion: once(worker, 'exit') };
}

function startHeldWrite(
  statement: string,
  state: Int32Array,
  holdMs: number,
): { completion: Promise<unknown[]> } {
  const worker = new Worker(`
    const { workerData } = require('node:worker_threads');
    const Database = require(workerData.betterSqlitePath);
    const database = new Database(workerData.databasePath);
    database.exec('BEGIN IMMEDIATE');
    database.exec(workerData.statement);
    Atomics.store(workerData.state, 0, 1);
    Atomics.notify(workerData.state, 0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
    database.exec('COMMIT');
    Atomics.store(workerData.state, 0, 2);
    Atomics.notify(workerData.state, 0);
    database.close();
  `, {
    eval: true,
    workerData: {
      betterSqlitePath,
      databasePath,
      holdMs,
      state,
      statement,
    },
  });

  return { completion: once(worker, 'exit') };
}

describe('SQLite write contention', () => {
  beforeAll(async () => {
    databaseModule = await import('@/db');
    databaseModule.sqlite.exec(`
      CREATE TABLE contention_test (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO contention_test (id, value) VALUES (1, 'initial'), (2, 'initial');
    `);
  });

  afterAll(() => {
    databaseModule.sqlite.close();
    if (originalDatabasePath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDatabasePath;
    rmSync(directory, { recursive: true, force: true });
  });

  it('reproduces SQLITE_BUSY_SNAPSHOT with a deferred read-then-write transaction', async () => {
    const sharedState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { worker, completion } = startCompetingWrite(
      "UPDATE contention_test SET value = 'deferred-worker' WHERE id = 2",
      sharedState,
    );
    let thrown: unknown;

    try {
      databaseModule.default.transaction((tx) => {
        tx.get('SELECT value FROM contention_test WHERE id = 1');
        worker.postMessage('write');
        Atomics.wait(sharedState, 0, 0, 5_000);
        Atomics.wait(sharedState, 0, 1, 1_000);
        expect(Atomics.load(sharedState, 0)).toBe(2);
        tx.run("UPDATE contention_test SET value = 'deferred-main' WHERE id = 1");
      }, { behavior: 'deferred' });
    } catch (error) {
      thrown = error;
    }

    await completion;
    expect(thrown).toMatchObject({
      cause: { code: 'SQLITE_BUSY_SNAPSHOT' },
    });
  });

  it('avoids a stale WAL snapshot when another connection writes after the first read', async () => {
    const sharedState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { worker, completion } = startCompetingWrite(
      "UPDATE contention_test SET value = 'worker' WHERE id = 2",
      sharedState,
    );
    let callbackCount = 0;

    const result = databaseModule.runTransaction((tx) => {
      callbackCount += 1;
      const before = tx.get<{ value: string }>(
        'SELECT value FROM contention_test WHERE id = 1',
      );
      worker.postMessage('write');
      Atomics.wait(sharedState, 0, 0, 5_000);
      Atomics.wait(sharedState, 0, 1, 250);
      expect(Atomics.load(sharedState, 0)).toBe(1);
      tx.run("UPDATE contention_test SET value = 'main' WHERE id = 1");
      return before?.value;
    });

    await completion;
    expect(result).toBe('initial');
    expect(callbackCount).toBe(1);
    expect(databaseModule.sqlite.prepare(
      'SELECT id, value FROM contention_test ORDER BY id',
    ).all()).toEqual([
      { id: 1, value: 'main' },
      { id: 2, value: 'worker' },
    ]);
  });

  it('propagates non-contention callback errors without replaying the callback', () => {
    const failure = new Error('callback failed');
    let callbackCount = 0;

    expect(() => databaseModule.runTransaction(() => {
      callbackCount += 1;
      throw failure;
    })).toThrow(failure);
    expect(callbackCount).toBe(1);
  });

  it('waits at transaction acquisition when another connection holds the writer lock', async () => {
    const sharedState = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
    const { completion } = startHeldWrite(
      "UPDATE contention_test SET value = 'held-writer' WHERE id = 2",
      sharedState,
      200,
    );
    Atomics.wait(sharedState, 0, 0, 5_000);
    expect(Atomics.load(sharedState, 0)).toBe(1);
    let callbackCount = 0;
    const startedAt = Date.now();

    databaseModule.runTransaction((tx) => {
      callbackCount += 1;
      tx.run("UPDATE contention_test SET value = 'after-wait' WHERE id = 1");
    });

    await completion;
    expect(callbackCount).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100);
    expect(Atomics.load(sharedState, 0)).toBe(2);
    expect(databaseModule.sqlite.prepare(
      'SELECT id, value FROM contention_test ORDER BY id',
    ).all()).toEqual([
      { id: 1, value: 'after-wait' },
      { id: 2, value: 'held-writer' },
    ]);
  });
});
