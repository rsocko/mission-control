import type Database from 'better-sqlite3';

export function execSafe(sqlite: Database.Database, sql: string): void {
  try {
    sqlite.exec(sql);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('no such table')) return;
    throw error;
  }
}
