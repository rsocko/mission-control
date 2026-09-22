import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { SqliteRuntimeTelemetryPersistence } from '@/lib/telemetry/sqlite-runtime-telemetry';
import { describeRuntimeTelemetryPersistenceContract } from '../contracts/runtime-telemetry-persistence.contract';

describeRuntimeTelemetryPersistenceContract('SQLite', () => {
  const database = new Database(':memory:');
  database.exec(`
    CREATE TABLE runtime_telemetry (
      role TEXT PRIMARY KEY,
      instance_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      heartbeat_at TEXT NOT NULL,
      metrics TEXT NOT NULL
    );
    CREATE TABLE runtime_telemetry_samples (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id TEXT NOT NULL,
      role TEXT NOT NULL,
      pid INTEGER NOT NULL,
      sampled_at TEXT NOT NULL,
      resolution_seconds INTEGER NOT NULL,
      metrics TEXT NOT NULL,
      UNIQUE(instance_id, sampled_at, resolution_seconds)
    );
    CREATE TABLE runtime_telemetry_instances (
      instance_id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      pid INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      stopped_at TEXT,
      terminal_reason TEXT,
      restart_count INTEGER,
      build_sha TEXT,
      runtime_mode TEXT NOT NULL,
      high_water_metrics TEXT NOT NULL,
      terminal_metrics TEXT
    );
  `);

  return {
    persistence: new SqliteRuntimeTelemetryPersistence(
      database,
      (callback) => callback(),
      () => {
        throw new Error('Database telemetry is not read by the persistence contract');
      },
    ),
    instanceId: `sqlite-contract-${randomUUID()}`,
    close: () => database.close(),
  };
});
