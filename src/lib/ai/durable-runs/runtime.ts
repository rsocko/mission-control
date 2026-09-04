import { resolveDatabaseBackend } from '@/db/runtime-backend';
import type { DurableAiRunRepository } from './repository';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

interface DurableAiRunRuntimeRegistry {
  sqliteRepositoryPromise: Promise<DurableAiRunRepository> | null;
  postgresRepository: DurableAiRunRepository | null;
}

const REGISTRY_KEY = 'mission-control.durable-ai-run-runtime-registry';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): DurableAiRunRuntimeRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    sqliteRepositoryPromise: null,
    postgresRepository: null,
  }));
}

export function registerPostgresDurableAiRunRepository(
  repository: DurableAiRunRepository,
): void {
  assertPersistenceCompositionPublicationAllowed();
  const runtime = registry();
  if (runtime.postgresRepository && runtime.postgresRepository !== repository) {
    throw new Error('PostgreSQL durable AI run repository is already registered');
  }
  runtime.postgresRepository = repository;
}

export function clearPostgresDurableAiRunRepository(
  expectedRepository?: DurableAiRunRepository,
): void {
  const runtime = registry();
  if (expectedRepository && runtime.postgresRepository !== expectedRepository) return;
  runtime.postgresRepository = null;
}

export function getRegisteredSqliteDurableAiRunRepository():
  | Promise<DurableAiRunRepository>
  | null {
  return registry().sqliteRepositoryPromise;
}

export function clearSqliteDurableAiRunRepository(
  expectedRepository: Promise<DurableAiRunRepository>,
): void {
  const runtime = registry();
  if (runtime.sqliteRepositoryPromise !== expectedRepository) return;
  runtime.sqliteRepositoryPromise = null;
}

export async function getDurableAiRunRepository(): Promise<DurableAiRunRepository> {
  assertPersistenceCompositionAccessAllowed();
  const runtime = registry();
  if (resolveDatabaseBackend() === 'postgres') {
    if (!runtime.postgresRepository) {
      throw new Error('PostgreSQL durable AI run repository has not been registered');
    }
    return runtime.postgresRepository;
  }
  runtime.sqliteRepositoryPromise ??= import('./sqlite-adapter')
    .then(({ SqliteDurableAiRunRepository }) => new SqliteDurableAiRunRepository());
  return runtime.sqliteRepositoryPromise;
}
