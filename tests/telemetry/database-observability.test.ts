import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createObservedDatabase,
  DatabaseTelemetryCollector,
} from '@/lib/telemetry/database';
import { withDatabaseOperation } from '@/lib/telemetry/database-operation-context';

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

describe('SQLite database observability', () => {
  let directory: string;
  let databasePath: string;
  let rawDatabase: Database.Database;
  let collector: DatabaseTelemetryCollector;
  let database: Database.Database;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'mission-control-db-telemetry-'));
    databasePath = join(directory, 'telemetry.db');
    rawDatabase = new Database(databasePath);
    rawDatabase.pragma('journal_mode = WAL');
    rawDatabase.pragma('busy_timeout = 50');
    collector = new DatabaseTelemetryCollector();
    database = createObservedDatabase(rawDatabase, collector);
    database.exec('CREATE TABLE telemetry_test (id INTEGER PRIMARY KEY, value TEXT NOT NULL)');
  });

  afterEach(() => {
    rawDatabase.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.MC_DB_BUSY_TIMEOUT_MS;
    delete process.env.MC_DB_BUSY_WAIT_WARNING_MS;
    delete process.env.MC_DB_SLOW_OPERATION_MS;
    delete process.env.MC_DB_MAX_SLOW_OPERATIONS;
    delete process.env.MC_DB_MAX_SAMPLES;
    delete process.env.MC_DB_LATENCY_P95_WARNING_MS;
    delete process.env.MC_DB_LATENCY_P99_CRITICAL_MS;
    delete process.env.MC_DB_WAL_WARNING_BYTES;
    delete process.env.MC_DB_WAL_CRITICAL_BYTES;
    delete process.env.MC_DB_CHECKPOINT_STARVATION_MS;
    delete process.env.MC_DB_CHECKPOINT_PENDING_FRAMES;
    delete process.env.MC_DB_CHECKPOINT_PROBE_INTERVAL_MS;
    delete process.env.MC_DB_OBSERVATION_WINDOW_MS;
  });

  it('reports healthy bounded aggregates without retaining SQL values', () => {
    process.env.MC_DB_LATENCY_P95_WARNING_MS = String(Number.MAX_SAFE_INTEGER);
    process.env.MC_DB_LATENCY_P99_CRITICAL_MS = String(Number.MAX_SAFE_INTEGER);
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('private-value');
    database.prepare('SELECT value FROM telemetry_test WHERE id = ?').get(1);

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.severity).toBe('healthy');
    expect(snapshot.operations.byCategory.write?.count).toBeGreaterThanOrEqual(1);
    expect(snapshot.operations.byCategory.read?.count).toBe(1);
    expect(snapshot.wal.available).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('private-value');
    expect(JSON.stringify(snapshot)).not.toContain('telemetry_test');

    const nextSnapshot = collector.snapshot(rawDatabase);
    expect(nextSnapshot.sampleInterval).toMatchObject({
      operationCount: 0,
      synchronousDatabaseTimeMs: 0,
    });
  });

  it('bounds slow-operation reporting and reports degraded latency', () => {
    process.env.MC_DB_SLOW_OPERATION_MS = '1';
    process.env.MC_DB_MAX_SLOW_OPERATIONS = '2';
    process.env.MC_DB_LATENCY_P95_WARNING_MS = '1';
    collector = new DatabaseTelemetryCollector();

    for (let index = 0; index < 3; index++) {
      collector.observe('SELECT', 'read', () => sleep(3));
    }

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.severity).toBe('degraded');
    expect(snapshot.operations.total.p95Ms).toBeGreaterThanOrEqual(1);
    expect(snapshot.slowOperations).toHaveLength(2);
  });

  it('attributes timings only to fixed low-cardinality operation names', () => {
    process.env.MC_DB_SLOW_OPERATION_MS = '1';
    collector = new DatabaseTelemetryCollector();

    withDatabaseOperation('sync-phase-tasks', () => {
      collector.observe('SELECT', 'read', () => sleep(3));
    });
    withDatabaseOperation('private-connector-id' as never, () => {
      collector.observe('UPDATE', 'write', () => undefined);
    });

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.operations.byAttribution['sync-phase-tasks']?.count).toBe(1);
    expect(snapshot.operations.byAttribution.unattributed?.count).toBe(1);
    expect(snapshot.slowOperations[0]).toMatchObject({
      attribution: 'sync-phase-tasks',
      operation: 'SELECT',
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-connector-id');
  });

  it('distinguishes a successful writer wait from a terminal failure', () => {
    process.env.MC_DB_BUSY_WAIT_WARNING_MS = '5';
    collector.recordWriterAcquisition(12);

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.severity).toBe('degraded');
    expect(snapshot.contention).toMatchObject({
      successfulWaitCount: 1,
      successfulWaitDurationMs: 12,
      busyFailureCount: 0,
      busyTimeoutCount: 0,
    });
  });

  it('expires old degradation samples from the rolling health window', () => {
    process.env.MC_DB_SLOW_OPERATION_MS = '1';
    process.env.MC_DB_LATENCY_P95_WARNING_MS = '1';
    process.env.MC_DB_OBSERVATION_WINDOW_MS = '1';
    collector.observe('SELECT', 'read', () => sleep(3));
    sleep(3);

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.severity).toBe('healthy');
    expect(snapshot.operations.total.count).toBe(0);
  });

  it('surfaces busy-timeout exhaustion as critical', () => {
    process.env.MC_DB_BUSY_TIMEOUT_MS = '50';
    const holder = new Database(databasePath);
    holder.pragma('busy_timeout = 50');
    holder.exec('BEGIN IMMEDIATE');

    try {
      expect(() => database
        .prepare('INSERT INTO telemetry_test (value) VALUES (?)')
        .run('blocked')).toThrowError(/locked/u);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    const snapshot = collector.snapshot(rawDatabase);

    expect(snapshot.severity).toBe('critical');
    expect(snapshot.contention.busyFailureCount).toBe(1);
    expect(snapshot.contention.busyTimeoutCount).toBe(1);
    expect(snapshot.reasons).toContain('1 SQLite busy timeout(s) exhausted');
  });

  it('does not double-count a statement lock failure propagated by a transaction', () => {
    process.env.MC_DB_BUSY_TIMEOUT_MS = '50';
    const holder = new Database(databasePath);
    holder.pragma('busy_timeout = 50');
    holder.exec('BEGIN IMMEDIATE');
    const transaction = database.transaction(() => {
      database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('blocked');
    });

    try {
      expect(() => transaction()).toThrowError(/locked/u);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }

    const snapshot = collector.snapshot(rawDatabase);
    expect(snapshot.contention.busyFailureCount).toBe(1);
    expect(snapshot.contention.busyTimeoutCount).toBe(1);
    expect(snapshot.operations.byCategory.transaction?.failureCount).toBe(1);
  });

  it('preserves a busy timeout through a high-volume sample interval', () => {
    process.env.MC_DB_BUSY_TIMEOUT_MS = '1';
    process.env.MC_DB_MAX_SAMPLES = '1';
    collector = new DatabaseTelemetryCollector();
    const busyError = Object.assign(new Error('database is locked'), {
      code: 'SQLITE_BUSY',
    });

    expect(() => collector.observe('INSERT', 'write', () => {
      sleep(2);
      throw busyError;
    })).toThrow(busyError);
    collector.observe('SELECT', 'read', () => undefined);
    collector.observe('SELECT', 'read', () => undefined);

    const snapshot = collector.snapshot(rawDatabase);
    expect(snapshot.severity).toBe('critical');
    expect(snapshot.contention.busyTimeoutCount).toBe(1);
    expect(snapshot.sampleInterval.busyTimeoutCount).toBe(1);
  });

  it('treats SQLITE_LOCKED as terminal contention without timeout exhaustion', () => {
    const lockedError = Object.assign(new Error('database table is locked'), {
      code: 'SQLITE_LOCKED_SHAREDCACHE',
    });

    expect(() => collector.observe('UPDATE', 'write', () => {
      throw lockedError;
    })).toThrow(lockedError);

    const snapshot = collector.snapshot(rawDatabase);
    expect(snapshot.severity).toBe('degraded');
    expect(snapshot.contention.busyFailureCount).toBe(1);
    expect(snapshot.contention.busyTimeoutCount).toBe(0);
  });

  it('records an iterator once when the caller stops reading early', () => {
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('one');
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('two');
    collector.reset();

    for (const row of database.prepare('SELECT value FROM telemetry_test').iterate()) {
      expect(row).toBeDefined();
      break;
    }

    const snapshot = collector.snapshot(rawDatabase);
    expect(snapshot.operations.byCategory.read?.count).toBe(1);
  });

  it('can exclude telemetry bookkeeping from application aggregates', () => {
    collector.reset();
    collector.withoutObservation(() => {
      database.prepare('SELECT value FROM telemetry_test').all();
    });

    expect(collector.snapshot(rawDatabase).operations.total.count).toBe(0);
  });

  it('keeps async health collection suppressed without hiding concurrent work', async () => {
    collector.reset();
    await collector.withoutObservation(async () => {
      await Promise.resolve();
      database.prepare('SELECT value FROM telemetry_test').all();
    });
    database.prepare('SELECT value FROM telemetry_test').all();

    expect(collector.snapshot(rawDatabase).operations.byCategory.read?.count).toBe(1);
  });

  it('detects checkpoint starvation behind a long-lived read', () => {
    process.env.MC_DB_CHECKPOINT_STARVATION_MS = '1';
    process.env.MC_DB_CHECKPOINT_PENDING_FRAMES = '1';
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('before-reader');
    rawDatabase.pragma('wal_checkpoint(TRUNCATE)');

    const reader = new Database(databasePath);
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM telemetry_test').all();
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('after-reader');
    sleep(5);

    try {
      const snapshot = collector.snapshot(rawDatabase);
      expect(snapshot.wal.pendingFrames).toBeGreaterThanOrEqual(1);
      expect(snapshot.wal.allocationState).toBe('pending');
      expect(snapshot.wal.starved).toBe(true);
      expect(snapshot.severity).toBe('critical');
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
  });

  it('does not force a checkpoint on every telemetry snapshot', () => {
    const first = collector.snapshot(rawDatabase);
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('after-probe');

    const second = collector.snapshot(rawDatabase);

    expect(second.wal.checkpointAttemptedAt).toBe(first.wal.checkpointAttemptedAt);
  });

  it('reports a large fully checkpointed WAL as retained allocation without repeated probes', () => {
    const warningBytes = 1024 * 1024;
    process.env.MC_DB_WAL_WARNING_BYTES = String(warningBytes);
    rawDatabase.pragma('wal_autocheckpoint = 0');
    collector = new DatabaseTelemetryCollector();
    const insert = database.prepare('INSERT INTO telemetry_test (value) VALUES (?)');
    database.transaction(() => {
      for (let index = 0; index < 2_048; index++) insert.run('x'.repeat(1_024));
    })();

    const snapshot = collector.snapshot(rawDatabase);
    const retainedSize = statSync(`${databasePath}-wal`).size;
    const nextSnapshot = collector.snapshot(rawDatabase);

    expect(snapshot.wal.sizeBytes).toBeGreaterThan(warningBytes);
    expect(retainedSize).toBe(snapshot.wal.sizeBytes);
    expect(snapshot.wal.pendingFrames).toBe(0);
    expect(snapshot.wal.allocationState).toBe('retained');
    expect(snapshot.wal.checkpointProbeDurationMs).toBeGreaterThanOrEqual(0);
    expect(nextSnapshot.wal.checkpointAttemptedAt).toBe(snapshot.wal.checkpointAttemptedAt);
    expect(snapshot.severity).toBe('healthy');
    expect(snapshot.reasons).not.toEqual(expect.arrayContaining([
      expect.stringContaining('SQLite WAL is'),
    ]));
  });

  it('degrades health when an oversized WAL still has pending frames', () => {
    process.env.MC_DB_WAL_WARNING_BYTES = '1';
    process.env.MC_DB_WAL_CRITICAL_BYTES = String(Number.MAX_SAFE_INTEGER);
    collector = new DatabaseTelemetryCollector();
    rawDatabase.pragma('wal_checkpoint(TRUNCATE)');
    const reader = new Database(databasePath);
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM telemetry_test').all();
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('pending');

    try {
      const snapshot = collector.snapshot(rawDatabase);

      expect(snapshot.wal.sizeBytes).toBeGreaterThan(1);
      expect(snapshot.wal.pendingFrames).toBeGreaterThan(0);
      expect(snapshot.wal.allocationState).toBe('pending');
      expect(snapshot.severity).toBe('degraded');
      expect(snapshot.reasons).toEqual(expect.arrayContaining([
        expect.stringMatching(/^SQLite WAL is \d+\.\d [KMGT]iB with pending checkpoint work$/u),
      ]));
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
    }
  });

  it('reports a concurrent checkpoint as busy without treating retained bytes as backlog', async () => {
    process.env.MC_DB_WAL_WARNING_BYTES = '1';
    process.env.MC_DB_CHECKPOINT_PROBE_INTERVAL_MS = '1';
    collector = new DatabaseTelemetryCollector();
    rawDatabase.pragma('wal_checkpoint(TRUNCATE)');
    const reader = new Database(databasePath);
    reader.exec('BEGIN');
    reader.prepare('SELECT * FROM telemetry_test').all();
    database.prepare('INSERT INTO telemetry_test (value) VALUES (?)').run('pending');

    const childScript = [
      "const Database = require('better-sqlite3');",
      `const database = new Database(${JSON.stringify(databasePath)});`,
      "database.pragma('busy_timeout = 1000');",
      "process.stdout.write('ready\\n');",
      "database.pragma('wal_checkpoint(TRUNCATE)');",
      'database.close();',
    ].join('');
    const checkpoint = spawn(process.execPath, ['-e', childScript], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    try {
      await new Promise<void>((resolve, reject) => {
        checkpoint.once('error', reject);
        checkpoint.stdout.once('data', () => resolve());
      });
      sleep(50);

      const snapshot = collector.snapshot(rawDatabase);

      expect(snapshot.wal.checkpointBusy).toBe(true);
      expect(snapshot.wal.allocationState).toBe('busy');
      expect(snapshot.wal.checkpointProbeDurationMs).toBeGreaterThanOrEqual(0);
      expect(snapshot.severity).toBe('degraded');
      expect(snapshot.reasons).toEqual(expect.arrayContaining([
        expect.stringContaining('with pending checkpoint work'),
      ]));
    } finally {
      reader.exec('ROLLBACK');
      reader.close();
      await new Promise<void>((resolve) => checkpoint.once('exit', () => resolve()));
    }
  });
});
