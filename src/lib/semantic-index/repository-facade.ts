import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { SemanticIndexRepository } from './contracts';

let sqliteRepository: SemanticIndexRepository | null = null;

/**
 * Resolves the semantic-index adapter for the currently selected database
 * backend.
 *
 * Both sides are imported dynamically so that merely importing this module
 * never pulls in the `better-sqlite3` handle *or* the PostgreSQL schema/driver
 * graph — only the selected backend's module is ever loaded. That keeps the
 * PostgreSQL path from touching SQLite (and vice versa), which
 * `tests/semantic-index/backend-selection.test.ts` asserts.
 */
export async function getSemanticIndexRepository(): Promise<SemanticIndexRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    const { getPostgresSemanticIndexRepository } = await import('@/db/runtime');
    return getPostgresSemanticIndexRepository();
  }
  if (!sqliteRepository) {
    const [{ sqlite }, { SqliteSemanticIndexRepository }] = await Promise.all([
      import('@/db'),
      import('./sqlite-repository'),
    ]);
    sqliteRepository = new SqliteSemanticIndexRepository(sqlite);
  }
  return sqliteRepository;
}

/**
 * Test hook: drops the memoized SQLite adapter so a suite that swaps the
 * underlying database handle does not keep querying the previous one.
 */
export function resetSemanticIndexRepositoryForTests(): void {
  sqliteRepository = null;
}
