/**
 * Backend-neutral persistence port for the sync-managed GitHub Projects V2
 * hub-project upsert and authoritative `task_projects` association
 * reconciliation.
 *
 * The adapters (`createSqliteGitHubProjectRepositories`,
 * `createPostgresGitHubProjectRepositories`) own every driver detail and are the
 * sole authority on the fenced reconciliation transaction. Nothing in this file
 * may reference `better-sqlite3`, `pg`, or Drizzle types.
 *
 * `src/lib/sync/execution-pipeline.ts` orchestrates this port, keeps every pure
 * computation (project identity digest, emoji-stripped name, stable-vs-locator
 * routing, blocked-project filtering, completeness assertion), and freezes the
 * identity fence values the adapter re-checks with SQL inside the transaction.
 *
 * Atomicity: `reconcileSyncManagedProjects` reconciles each project in exactly
 * one transaction per adapter — the hub-project upsert and the `task_projects`
 * link inserts/deletes commit together. The frozen identity fence (epoch
 * revision + per-decision binding/locator revisions) is re-checked with SQL at
 * the start of each project transaction so no async identity callback runs
 * inside the write. Deletion of stale links only happens for `authoritative`
 * (complete) observations, so a partial project observation never removes
 * existing associations.
 */

/**
 * One frozen decision-currency check. Mirrors the values the identity runtime
 * derives from an applied stable decision so the adapter can re-verify the
 * binding + current locator revision inside the transaction.
 */
export interface GitHubProjectDecisionCheck {
  bindingType: 'task' | 'source_list';
  localId: string;
  externalEntityId: string;
  bindingRevision: string;
  locatorRevision: number;
}

/** The frozen identity fence re-checked with SQL inside each transaction. */
export interface GitHubProjectIdentityFence {
  modeRevision: number;
  checks: readonly GitHubProjectDecisionCheck[];
}

/**
 * One sync-managed project to reconcile. All identity/routing decisions are
 * pre-computed by the domain layer; `resolveIdentityDigest` is a synchronous
 * pure callback invoked inside the transaction once the existing digest is read.
 */
export interface GitHubProjectReconciliation {
  number: number;
  /** Emoji-stripped project title used as the hub-project name. */
  name: string;
  description: string | null;
  url: string;
  /**
   * True only for complete authoritative observations. When false, stale links
   * are never deleted (partial observations must not prune associations).
   */
  authoritative: boolean;
  taskSourceIds: readonly string[];
  /**
   * When stable routing is used, the resolved stable task ids for this project.
   * `useStableRouting` selects between stable-id and source-id task routing.
   */
  stableTaskIds?: readonly string[];
  useStableRouting: boolean;
  /**
   * Pure digest derivation. Receives the existing hub-project digest (if any)
   * and returns the canonical digest, throwing when the stable identity drifted.
   */
  resolveIdentityDigest: (existingDigest: string | undefined) => string;
}

export interface ReconcileSyncManagedProjectsInput {
  connectorInstanceId: string;
  now: string;
  /** Frozen identity fence; re-checked with SQL inside each transaction. */
  identityFence?: GitHubProjectIdentityFence;
  projects: readonly GitHubProjectReconciliation[];
}

export interface GitHubProjectPersistence {
  /**
   * Upserts each sync-managed hub project and reconciles its authoritative
   * `task_projects` associations. Each project is one transaction that re-checks
   * the frozen identity fence before writing and fails closed on drift.
   */
  reconcileSyncManagedProjects(
    input: ReconcileSyncManagedProjectsInput,
  ): Promise<void>;
}
