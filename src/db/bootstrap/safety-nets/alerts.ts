import type Database from 'better-sqlite3';
import { execSafe } from './exec-safe';

export function applyAlertColumnSafetyNets(_sqlite: Database.Database): void {
  const _execSafe = (sql: string) => execSafe(_sqlite, sql);
  // Migrate alerts table: add dismissed columns (safety net for Drizzle migration 0017)
  const alertColumns = _sqlite.prepare("PRAGMA table_info('alerts')").all() as Array<{ name: string }>;
  if (alertColumns.length > 0 && !alertColumns.some((column) => column.name === 'is_dismissed')) {
    _sqlite.exec('ALTER TABLE alerts ADD COLUMN is_dismissed INTEGER NOT NULL DEFAULT 0');
  }
  if (alertColumns.length > 0 && !alertColumns.some((column) => column.name === 'dismissed_at')) {
    _sqlite.exec('ALTER TABLE alerts ADD COLUMN dismissed_at TEXT');
  }
  // Create index on is_dismissed after the column is guaranteed to exist
  _execSafe('CREATE INDEX IF NOT EXISTS idx_alerts_is_dismissed ON alerts(is_dismissed)');
}
