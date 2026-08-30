import type Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { dbLogger } from '@/lib/logger';

/**
 * Apply Drizzle migrations one at a time, outside of Drizzle's single-transaction
 * wrapper. Drizzle's migrate() wraps every pending migration in one transaction,
 * so one compatibility error can roll back earlier migrations that created tables
 * required by later safety nets. Expected schema-level idempotency errors are
 * skipped; an unexpected statement failure is logged, left unmarked, and stops
 * subsequent migrations.
 */
export function _runMigrationsIndividually(
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at INTEGER
    )
  `);

  const journalPath = path.join(migrationsFolder, 'meta', '_journal.json');
  if (!fs.existsSync(journalPath)) return;
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf-8'));

  const applied = sqlite
    .prepare('SELECT hash FROM __drizzle_migrations')
    .all() as Array<{ hash: string }>;
  const appliedHashes = new Set(applied.map((row) => row.hash));

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require('crypto') as typeof import('crypto');

  for (const entry of journal.entries) {
    const tag = entry.tag as string;
    const sqlFile = path.join(migrationsFolder, `${tag}.sql`);
    if (!fs.existsSync(sqlFile)) continue;

    const sql = fs.readFileSync(sqlFile, 'utf-8');
    const normalizedSql = sql.replace(/\r\n?/g, '\n');
    const hash = createHash('sha256').update(normalizedSql).digest('hex');
    const legacyWindowsHash = createHash('sha256')
      .update(normalizedSql.replace(/\n/g, '\r\n'))
      .digest('hex');
    if (appliedHashes.has(hash) || appliedHashes.has(legacyWindowsHash)) continue;

    const statements = sql
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter(Boolean);

    let skipped = false;
    let failed = false;
    try {
      for (const statement of statements) {
        try {
          sqlite.exec(statement);
        } catch (statementError: unknown) {
          const message = statementError instanceof Error
            ? statementError.message
            : String(statementError);
          if (
            message.includes('duplicate column name')
            || message.includes('already exists')
            || (entry.idx < 33 && message.includes('no such column'))
            || (entry.idx < 33 && message.includes('no such table'))
            || (
              entry.tag === '0038_enforce_task_source_identity'
              && message.includes('no such table: task_triage_log')
            )
            || (
              // `task_triage_log` is owned by the task-activity safety net, which
              // runs after migrations, so a fresh database has no table to alter.
              entry.tag === '0104_quick_sort_undo'
              && message.includes('no such table: task_triage_log')
            )
            || (
              entry.tag === '0060_optimize_list_queries'
              && message.includes('no such table')
            )
            || message.includes('DROP COLUMN')
          ) {
            skipped = true;
            continue;
          }
          throw statementError;
        }
      }
    } catch (error) {
      dbLogger.error(
        { err: error, tag },
        'Migration failed unexpectedly — will retry on next startup',
      );
      failed = true;
    }

    if (failed) break;

    sqlite.prepare(
      'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
    ).run(hash, entry.when ?? Date.now());

    if (skipped) {
      dbLogger.info(
        { tag },
        'Migration applied (some statements skipped — schema already matched)',
      );
    }
  }
}
