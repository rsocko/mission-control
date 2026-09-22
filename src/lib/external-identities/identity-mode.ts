import { eq } from 'drizzle-orm';
import { githubIdentityControls } from '@/db/schema';
import { getGitHubIdentityRepository } from './worker-persistence';
import {
  GITHUB_IDENTITY_MODE,
  type GitHubIdentityModeSnapshot,
} from './stable-identity-types';
import type { ExternalIdentityTransaction } from './service';

/**
 * GitHub identity is permanently NodeID-first, so there is no mode to select
 * and no rollback to locator identity. The snapshot only carries the durable
 * identity epoch (`mode_revision`) that fences in-flight write cycles, write
 * leases, and queued sync jobs against a connector being re-provisioned.
 *
 * This is a backend-neutral async wrapper over
 * `GitHubIdentityPersistence.getModeSnapshot`, obtained through the L01
 * worker-persistence composition root. The SQLite adapter answers it with the
 * exact query the `*InTransaction` helper below performs (re-used verbatim
 * inside the adapter's own transaction); the PostgreSQL adapter answers it
 * genuinely async against its own schema.
 */
export async function getGitHubIdentityModeSnapshot(
  connectorInstanceId: string,
  capturedAt = new Date().toISOString(),
): Promise<GitHubIdentityModeSnapshot> {
  return (await getGitHubIdentityRepository()).getModeSnapshot(connectorInstanceId, capturedAt);
}

export function getGitHubIdentityModeSnapshotInTransaction(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  const control = database.select({
    modeRevision: githubIdentityControls.modeRevision,
  }).from(githubIdentityControls)
    .where(eq(githubIdentityControls.connectorInstanceId, connectorInstanceId))
    .limit(1)
    .get();
  return Object.freeze({
    connectorInstanceId,
    effectiveMode: GITHUB_IDENTITY_MODE,
    modeRevision: control?.modeRevision ?? 0,
    capturedAt,
  });
}

/**
 * Ensures a GitHub connector has an identity epoch. New connectors start at
 * revision 1 so their first write cycle has a durable fence token.
 */
export function ensureGitHubIdentityControlsInTransaction(
  database: ExternalIdentityTransaction,
  connectorInstanceId: string,
  now: string,
): void {
  database.insert(githubIdentityControls).values({
    connectorInstanceId,
    modeRevision: 1,
    updatedAt: now,
  }).onConflictDoNothing().run();
}

export function assertGitHubIdentityModeSnapshotInTransaction(
  database: ExternalIdentityTransaction,
  snapshot: GitHubIdentityModeSnapshot,
): void {
  const current = getGitHubIdentityModeSnapshotInTransaction(
    database,
    snapshot.connectorInstanceId,
    snapshot.capturedAt,
  );
  if (current.modeRevision !== snapshot.modeRevision) {
    throw new Error(
      `GitHub identity revision changed from ${snapshot.modeRevision} to ${current.modeRevision}`,
    );
  }
}
