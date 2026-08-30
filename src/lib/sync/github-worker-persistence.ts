import type { GitHubDependencyPersistence } from '@/db/persistence/github-dependencies';
import type { GitHubHierarchyPersistence } from '@/db/persistence/github-hierarchy';
import type { GitHubProjectPersistence } from '@/db/persistence/github-projects';
import type { GitHubRecoveryPersistence } from '@/db/persistence/github-recovery';
import type { GitHubWorkerRepositories } from '@/db/persistence/github-worker';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

/**
 * Resolves the backend-neutral GitHub worker persistence composition for the
 * sync worker. `@/db/runtime` registers the PostgreSQL composition atomically
 * and `@/lib/persistence/worker-runtime` builds the SQLite one lazily, so these
 * accessors never touch a driver or a raw database handle.
 */
async function getGitHubWorkerRepositories(): Promise<GitHubWorkerRepositories> {
  return (await getWorkerPersistenceRepositories()).github;
}

export async function getGitHubDependencyRepository(): Promise<GitHubDependencyPersistence> {
  return (await getGitHubWorkerRepositories()).dependencies;
}

export async function getGitHubHierarchyRepository(): Promise<GitHubHierarchyPersistence> {
  return (await getGitHubWorkerRepositories()).hierarchy;
}

export async function getGitHubProjectRepository(): Promise<GitHubProjectPersistence> {
  return (await getGitHubWorkerRepositories()).projects;
}

/**
 * The Layer 3B recovery composition (native transfer, historical succession,
 * bulk transfer, repository repoint). Absent or partial compositions cannot be
 * represented, so an unsupported backend fails closed here before any remote
 * GitHub effect is attempted.
 */
export async function getGitHubRecoveryRepository(): Promise<GitHubRecoveryPersistence> {
  return (await getGitHubWorkerRepositories()).recovery;
}
