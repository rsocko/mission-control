import { eq } from 'drizzle-orm';
import db from '@/db';
import { githubIdentityControls } from '@/db/schema';
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
 * This read stays Drizzle-bound: it is a thin wrapper over the
 * `*InTransaction` helper and is still called synchronously by SQLite-only
 * legacy reconciliation modules (`repoint-service`, `bulk-transfer-service`,
 * `identity-status`) that are out of scope for this migration layer. The
 * backend-neutral equivalent is exposed on the persistence port as
 * `GitHubIdentityPersistence.getModeSnapshot`, which the adapters and the
 * migrated write-fence/runtime flows re-check inside their own transactions.
 */
export function getGitHubIdentityModeSnapshot(
  connectorInstanceId: string,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  return getGitHubIdentityModeSnapshotInTransaction(db, connectorInstanceId, capturedAt);
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
