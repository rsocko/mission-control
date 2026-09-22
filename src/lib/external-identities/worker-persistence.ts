import type {
  GitHubIdentityPersistence,
  GitHubWriteFencePersistence,
} from '@/db/persistence/github-identity';
import type { GitHubIdentityOperatorPersistence } from '@/db/persistence/github-identity-operator';
import type { GitHubTransferIdentityPersistence } from '@/db/persistence/github-transfer-identity';
import type { GitHubWorkerRepositories } from '@/db/persistence/github-worker';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/**
 * Resolves the backend-neutral GitHub durable-identity and write-fence ports
 * from the shared worker persistence composition. The composition is registered
 * atomically by `@/db/runtime` (PostgreSQL) or built lazily from the SQLite
 * adapters by `@/lib/persistence/worker-runtime`, so this module never touches a
 * driver or a raw database handle.
 */
export async function getGitHubWorkerRepositories(): Promise<GitHubWorkerRepositories> {
  return (await getWorkerPersistenceRepositories()).github;
}

/** Convenience accessor for the identity port. */
export async function getGitHubIdentityRepository(): Promise<GitHubIdentityPersistence> {
  return (await getGitHubWorkerRepositories()).identity;
}

/** Convenience accessor for the write-fence port. */
export async function getGitHubWriteFenceRepository(): Promise<GitHubWriteFencePersistence> {
  return (await getGitHubWorkerRepositories()).writeFence;
}

/** Convenience accessor for the atomic task + identity transfer bridge. */
export async function getGitHubTransferIdentityRepository(): (
  Promise<GitHubTransferIdentityPersistence>
) {
  return (await getGitHubWorkerRepositories()).transferIdentity;
}

/**
 * Convenience accessor for the operator/recovery port covering identity
 * backfill/status, manual exception mutation, unknown-outcome resolution, and
 * interrupted write-cycle recovery. These are pre-existing, previously audited
 * worker exclusions: the PostgreSQL adapter fails closed with
 * `UnsupportedGitHubWorkerOperationError` before any remote effect.
 */
export async function getGitHubIdentityOperatorRepository(): (
  Promise<GitHubIdentityOperatorPersistence>
) {
  return (await getGitHubWorkerRepositories()).operator;
}
