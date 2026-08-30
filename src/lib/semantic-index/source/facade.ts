import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SemanticSourcePort } from './contracts';

let sqliteSourcePort: SemanticSourcePort | null = null;

/**
 * Resolves the authoritative-source read port for the selected backend.
 *
 * Mirrors `getSemanticIndexRepository`: both sides are imported dynamically so
 * merely importing this module never pulls in the `better-sqlite3` handle *or*
 * the PostgreSQL driver graph.
 */
export async function getSemanticSourcePort(): Promise<SemanticSourcePort> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresSemanticSourcePort } = await import('@/db/runtime');
    return getPostgresSemanticSourcePort();
  }
  if (!sqliteSourcePort) {
    const [{ sqlite }, { SqliteSemanticSourcePort }] = await Promise.all([
      import('@/db'),
      import('./sqlite-source-port'),
    ]);
    sqliteSourcePort = new SqliteSemanticSourcePort(sqlite);
  }
  return sqliteSourcePort;
}

/** Test hook: drops the memoized SQLite port after a handle swap. */
export function resetSemanticSourcePortForTests(): void {
  sqliteSourcePort = null;
}
