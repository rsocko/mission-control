import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const databasePath = process.env.MC_DB_PATH ?? '/app/data/mission-control.db';
const instanceFile = process.env.MC_WORKER_INSTANCE_FILE
  ?? join(tmpdir(), 'mission-control-worker-instance');
const durationBudgetMs = Number(process.env.MC_SYNC_DURATION_BUDGET_MS) || 300_000;
const leaseMs = Number(process.env.MC_SYNC_JOB_LEASE_MS) || 120_000;
const staleMs = Number(process.env.MC_WORKER_HEALTH_STALE_MS)
  || Math.max(durationBudgetMs + 60_000, leaseMs * 2);
const instanceId = readFileSync(instanceFile, 'utf8').trim();
if (!instanceId) {
  throw new Error('current worker instance marker is empty');
}
const database = new Database(databasePath, { readonly: true, fileMustExist: true });

try {
  const row = database.prepare(`
    SELECT heartbeat_at AS heartbeatAt
    FROM runtime_telemetry
    WHERE role = 'worker' AND instance_id = ?
  `).get(instanceId);
  if (!row?.heartbeatAt) {
    throw new Error('telemetry heartbeat for the current worker instance is missing');
  }
  const ageMs = Date.now() - new Date(row.heartbeatAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > staleMs) {
    throw new Error(`worker telemetry heartbeat is ${ageMs}ms old`);
  }
} finally {
  database.close();
}
