import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { DurableAiRunRepository } from './repository';

let sqliteRepositoryPromise: Promise<DurableAiRunRepository> | null = null;
let postgresRepository: DurableAiRunRepository | null = null;

export function registerPostgresDurableAiRunRepository(
  repository: DurableAiRunRepository,
): void {
  if (postgresRepository && postgresRepository !== repository) {
    throw new Error('PostgreSQL durable AI run repository is already registered');
  }
  postgresRepository = repository;
}

export function clearPostgresDurableAiRunRepository(): void {
  postgresRepository = null;
}

export async function getDurableAiRunRepository(): Promise<DurableAiRunRepository> {
  if (resolveDatabaseBackend() === 'postgres') {
    if (!postgresRepository) {
      throw new Error('PostgreSQL durable AI run repository has not been registered');
    }
    return postgresRepository;
  }
  sqliteRepositoryPromise ??= import('./sqlite-adapter')
    .then(({ SqliteDurableAiRunRepository }) => new SqliteDurableAiRunRepository());
  return sqliteRepositoryPromise;
}
