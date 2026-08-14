import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const DEFAULT_DATABASE_BUSY_TIMEOUT_MS = 5_000;

export function shouldRunDatabaseInitialization(
  role = process.env.MC_PROCESS_ROLE,
  initializerRole = process.env.MC_DATABASE_INITIALIZER_ROLE ?? 'web',
): boolean {
  return (role ?? 'web') === initializerRole;
}

export function resolveDatabasePath(): string {
  return process.env.MC_DB_PATH || path.join(process.cwd(), 'data', 'mission-control.db');
}

export function openDatabaseConnection(): Database.Database {
  const databasePath = resolveDatabasePath();
  const dataDirectory = path.dirname(databasePath);
  if (!fs.existsSync(dataDirectory)) {
    fs.mkdirSync(dataDirectory, { recursive: true });
  }
  return new Database(databasePath);
}

export function resolveDatabaseBusyTimeout(
  configuredValue = process.env.MC_DB_BUSY_TIMEOUT_MS,
): number {
  const configuredBusyTimeoutMs = Number(configuredValue);
  return Number.isSafeInteger(configuredBusyTimeoutMs) && configuredBusyTimeoutMs > 0
    ? configuredBusyTimeoutMs
    : DEFAULT_DATABASE_BUSY_TIMEOUT_MS;
}

export function configureDatabaseConnection(sqlite: Database.Database): void {
  if (shouldRunDatabaseInitialization()) {
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma(`busy_timeout = ${resolveDatabaseBusyTimeout()}`);
}
