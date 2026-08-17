/**
 * Shared detection for SQLite lock-contention failures.
 *
 * better-sqlite3 surfaces contention as `SQLITE_BUSY`, `SQLITE_BUSY_SNAPSHOT`,
 * or `SQLITE_LOCKED`. Drizzle wraps driver errors, so the code can appear on a
 * nested `cause` rather than the thrown error itself.
 */
const CONTENTION_CODES = new Set([
  'SQLITE_BUSY',
  'SQLITE_BUSY_SNAPSHOT',
  'SQLITE_BUSY_TIMEOUT',
  'SQLITE_LOCKED',
]);

interface SqliteErrorLike {
  code?: string;
  cause?: unknown;
}

export function isDatabaseContentionError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as SqliteErrorLike;
    if (typeof candidate.code === 'string' && CONTENTION_CODES.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
