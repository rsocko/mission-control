/**
 * Backend-neutral persistence port for GitHub sub-issue hierarchy
 * reconciliation.
 *
 * The adapters (`createSqliteGitHubHierarchyRepositories`,
 * `createPostgresGitHubHierarchyRepositories`) own every driver detail and are
 * the sole authority on the fenced-apply transaction. Nothing in this file may
 * reference `better-sqlite3`, `pg`, or Drizzle types.
 *
 * `src/lib/sync/github-hierarchy-reconciliation.ts` orchestrates these methods,
 * keeps every pure computation (population digest, identity fingerprint, desired
 * parent/depth derivation), and translates the discriminated results into the
 * bounded machine reason codes it reports.
 *
 * Atomicity: `applyReconciliation` is exactly one transaction in each adapter.
 * It re-reads the connector task population, re-reads the terminal-inaccessible
 * exception events, re-derives the historical task-transfer succession set, and
 * hands those durable rows to a synchronous pure callback that re-checks the
 * population count + digest, the identity fingerprint, and the frozen identity
 * epoch before returning the parent/depth/metadata updates to apply.
 *
 * Historical task-transfer succession state (`github_identity_task_transfer_
 * reconciliations`) is revalidated against current task bindings and locators
 * by both adapters before a source task is excluded.
 */

/** Task identity columns the population reads scope to a connector. */
export interface GitHubHierarchyTaskIdentityRow {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  connectorType: string;
  isChecklistItem: boolean;
  metadata: unknown;
}

/** The full task columns the fenced apply re-reads and mutates. */
export interface GitHubHierarchyTaskRow extends GitHubHierarchyTaskIdentityRow {
  parentId: string | null;
  depth: number;
}

/** A non-retired task stable binding joined to its external entity identity. */
export interface GitHubHierarchyStableBindingRow {
  localTaskId: string;
  provider: string;
  hostKey: string;
  entityType: string;
  stableId: string;
}

/** A terminal-inaccessible exception event (latest-first per `localId`). */
export interface GitHubHierarchyExceptionEventRow {
  id: number;
  localId: string;
  action: 'accept' | 'revoke';
}

/** The durable identity epoch fields the hierarchy fence compares. */
export interface GitHubHierarchyIdentitySnapshot {
  connectorInstanceId: string;
  modeRevision: number;
}

/** A single parent/depth/metadata update to apply to a task row. */
export interface GitHubHierarchyTaskUpdate {
  taskId: string;
  parentId: string | null;
  depth: number;
  /** New metadata object, present only when `metadata.githubParent` changed. */
  metadata?: Record<string, unknown>;
}

export type GitHubHierarchyReconcileVerdict =
  | { fenced: true }
  | { fenced: false; updates: readonly GitHubHierarchyTaskUpdate[] };

/** The durable rows the reconcile callback re-checks inside the transaction. */
export interface GitHubHierarchyReconcileContext {
  identitySnapshot: GitHubHierarchyIdentitySnapshot;
  tasks: readonly GitHubHierarchyTaskRow[];
  exceptionEvents: readonly GitHubHierarchyExceptionEventRow[];
  supersededHistoricalTaskIds: ReadonlySet<string>;
}

export interface GitHubHierarchyApplyResult {
  applied: boolean;
  updated: number;
  fenced: boolean;
}

export interface GitHubHierarchyPersistence {
  /** Durable identity epoch snapshot for the frozen-context fence. */
  getIdentityModeSnapshot(
    connectorInstanceId: string,
  ): Promise<GitHubHierarchyIdentitySnapshot>;

  /** Task identity rows for the connector (population candidates). */
  listConnectorTaskIdentities(
    connectorInstanceId: string,
  ): Promise<GitHubHierarchyTaskIdentityRow[]>;

  /** Non-retired task stable bindings joined to their external entities. */
  listTaskStableBindings(
    connectorInstanceId: string,
  ): Promise<GitHubHierarchyStableBindingRow[]>;

  /** Terminal-inaccessible exception events, ordered latest-first. */
  listTerminalInaccessibleExceptions(
    connectorInstanceId: string,
  ): Promise<GitHubHierarchyExceptionEventRow[]>;

  /**
   * Historical task-transfer succession task ids to exclude from the population.
   *
   * Both adapters reproduce the proven-succession filtering and ignore records
   * whose proof digest, current binding, or current locator no longer matches.
   */
  provenSupersededTaskIds(
    connectorInstanceId: string,
    observedEndpointTaskIds: readonly string[],
  ): Promise<string[]>;

  /**
   * The fenced apply transaction. Re-reads the population, exception events, and
   * succession set, then invokes the synchronous pure `reconcile` callback to
   * re-check every fence and produce the updates to apply.
   */
  applyReconciliation(input: {
    connectorInstanceId: string;
    observedEndpointTaskIds: readonly string[];
    reconcile: (
      context: GitHubHierarchyReconcileContext,
    ) => GitHubHierarchyReconcileVerdict;
  }): Promise<GitHubHierarchyApplyResult>;
}
