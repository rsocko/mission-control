import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { DurableAiRunRepository } from './repository';

let sqliteRepositoryPromise: Promise<DurableAiRunRepository> | null = null;

export async function getDurableAiRunRepository(): Promise<DurableAiRunRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    throw new Error(
      'PostgreSQL durable AI run persistence is unsupported in this release',
    );
  }
  sqliteRepositoryPromise ??= import('./sqlite-adapter')
    .then(({ SqliteDurableAiRunRepository }) => new SqliteDurableAiRunRepository());
  return sqliteRepositoryPromise;
}
