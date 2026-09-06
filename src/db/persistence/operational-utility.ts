/**
 * Operational utility persistence.
 *
 * One bounded contract for the small operational surfaces that used to reach
 * into `@/db` directly from their route handlers: the GitHub retained-list
 * purge, the duplicate/recurring maintenance cleanup, the streaming export,
 * the connector feature snapshot, the external bug-report intake, and the
 * public-demo initialization marker.
 *
 * The contract deliberately exposes named subports only. There is no raw
 * query, statement, or transaction escape hatch: every atomicity requirement
 * (cleanup, bug report) is expressed as a single command the adapter runs
 * inside one backend transaction, so a route can never compose its own
 * multi-statement unit of work.
 */

/** Connector fields the retained-list purge needs to validate ownership. */
export interface RetainedPurgeConnector {
  readonly id: string;
  readonly type: string;
  readonly settings: unknown;
  readonly syncedLists: unknown;
}

/** Source-list row identity used by the retained-list purge. */
export interface RetainedPurgeSourceList {
  readonly id: string;
  readonly sourceId: string;
}

export interface RetainedSourceListSnapshot {
  readonly connector: RetainedPurgeConnector | null;
  readonly sourceList: RetainedPurgeSourceList | null;
}

export interface RetainedSourceListRepository {
  /**
   * Loads the connector and source-list rows for a retained purge. Both may be
   * absent; the caller distinguishes "connector not found" from "source list
   * not found" and enforces the GitHub-only and unselected-list rules.
   */
  loadSnapshot(input: {
    readonly connectorId: string;
    readonly sourceListId: string;
  }): Promise<RetainedSourceListSnapshot>;
  /** Task ids retained for a source list, ordered by id for determinism. */
  listRetainedTaskIds(input: {
    readonly connectorId: string;
    readonly sourceListSourceId: string;
  }): Promise<readonly string[]>;
  /**
   * Deletes the source-list row itself. Called only after every local task
   * delete for the list has succeeded.
   */
  deleteSourceList(input: {
    readonly connectorId: string;
    readonly sourceListId: string;
  }): Promise<void>;
}

export interface MaintenanceCleanupResult {
  /** Number of `(sourceId, connectorInstanceId)` groups with more than one row. */
  readonly duplicateGroupsFound: number;
  readonly tasksRemoved: number;
  readonly recurringInstancesRemoved: number;
  readonly openRecurringInstancesRemoved: number;
}

export interface TaskMaintenanceRepository {
  /**
   * Removes duplicate source rows and redundant recurring instances inside a
   * single backend transaction, deleting dependent rows before their tasks and
   * reporting counts only after the transaction commits.
   *
   * Winner ordering:
   * - source duplicates: `lastSyncedAt` DESC, `updatedAt` DESC, `id` ASC;
   * - completed recurring: `completedAt ?? updatedAt` DESC, `id` ASC;
   * - open recurring: nearest non-null `dueDate` ASC (nulls last),
   *   `updatedAt` DESC, `id` ASC.
   *
   * Tasks whose metadata is not a JSON object are never grouped and never
   * deleted by the recurring phases.
   */
  runDuplicateCleanup(): Promise<MaintenanceCleanupResult>;
}

export type OperationalExportRecord = Record<string, unknown>;

export interface ExportKeysetQuery {
  /** Exclusive `id` cursor; omitted for the first page. */
  readonly afterId?: string;
  readonly limit: number;
}

export interface ExportTaskTagCursor {
  readonly taskId: string;
  readonly tagId: string;
}

export interface ExportTaskTagQuery {
  /** Exclusive `(taskId, tagId)` cursor matching the declared ordering. */
  readonly after?: ExportTaskTagCursor;
  readonly limit: number;
}

/**
 * Deterministic keyset export readers. Every reader orders by its declared key
 * and returns at most `limit` rows; the caller derives the next cursor from the
 * last row of a full page.
 */
export interface OperationalExportRepository {
  listTasksPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
  listNotificationsPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
  listTagsPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
  listTaskTagsPage(query: ExportTaskTagQuery): Promise<OperationalExportRecord[]>;
  listHubProjectsPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
  /** Non-deleted connectors, projected to the export's public columns. */
  listConnectorsPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
  listSyncLogPage(query: ExportKeysetQuery): Promise<OperationalExportRecord[]>;
}

export interface ConnectorFeatureSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly capabilities: unknown;
  readonly settings: unknown;
}

export interface ConnectorFeatureRepository {
  /**
   * Enabled, non-deleted connectors ordered by `createdAt` then `id` so the
   * feature snapshot is stable across backends and requests.
   */
  listActiveConnectors(): Promise<readonly ConnectorFeatureSnapshot[]>;
}

export interface BugReportTagInput {
  readonly slug: string;
  readonly name: string;
  readonly color: string;
  /** Id used only when the slug does not already exist. */
  readonly newTagId: string;
}

export interface BugReportTaskInput {
  readonly id: string;
  readonly sourceId: string;
  readonly connectorType: string;
  readonly connectorInstanceId: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastSyncedAt: string;
  readonly metadata: Record<string, unknown>;
}

export interface BugReportCommand {
  readonly task: BugReportTaskInput;
  /** Canonical and app tags, applied in order. */
  readonly tags: readonly BugReportTagInput[];
}

export interface BugReportResult {
  readonly taskId: string;
  readonly tagIds: readonly string[];
}

export interface BugReportRepository {
  /**
   * Creates the report task and all of its tag associations in one backend
   * transaction: a partially tagged report is never observable.
   */
  create(command: BugReportCommand): Promise<BugReportResult>;
}

export interface PublicDemoRuntimeRepository {
  /** Cheap connectivity check performed before demo data is reset. */
  ensureReady(): Promise<void>;
  /** Records the typed public-demo seed marker. */
  markSeeded(seededAt: string): Promise<void>;
}

export interface OperationalUtilityPersistence {
  readonly retainedSourceLists: RetainedSourceListRepository;
  readonly maintenance: TaskMaintenanceRepository;
  readonly exports: OperationalExportRepository;
  readonly features: ConnectorFeatureRepository;
  readonly bugReports: BugReportRepository;
  readonly publicDemo: PublicDemoRuntimeRepository;
}

/**
 * A task row as the cleanup phases see it. Adapters read these columns inside
 * their cleanup transaction and hand them to the shared planners below so both
 * backends pick byte-identical winners.
 */
export interface CleanupTaskCandidate {
  readonly id: string;
  readonly title: string | null;
  readonly sourceListId: string | null;
  readonly connectorInstanceId: string;
  readonly dueDate: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string | null;
  /** Raw metadata exactly as stored: text, JSON value, or null. */
  readonly metadata: unknown;
}

export interface DuplicateTaskCandidate {
  readonly id: string;
  readonly lastSyncedAt: string | null;
  readonly updatedAt: string | null;
}

/**
 * Parses stored task metadata into an object. Malformed text, JSON scalars,
 * and arrays all yield `null` so such rows are skipped rather than grouped.
 */
export function parseCleanupMetadata(raw: unknown): Record<string, unknown> | null {
  const value = typeof raw === 'string'
    ? (() => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    })()
    : raw;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compareText(left: string | null, right: string | null): number {
  return (left ?? '').localeCompare(right ?? '');
}

function recurringGroupKey(task: CleanupTaskCandidate): string {
  return [
    (task.title ?? '').trim().toLowerCase(),
    task.sourceListId ?? '',
    task.connectorInstanceId,
  ].join('::');
}

function groupRecurring(
  tasks: readonly CleanupTaskCandidate[],
): CleanupTaskCandidate[][] {
  const groups = new Map<string, CleanupTaskCandidate[]>();
  for (const task of tasks) {
    const metadata = parseCleanupMetadata(task.metadata);
    if (!metadata?.recurrence) continue;
    const key = recurringGroupKey(task);
    const group = groups.get(key);
    if (group) group.push(task);
    else groups.set(key, [task]);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Ids to delete for one `(sourceId, connectorInstanceId)` duplicate group.
 * Winner: `lastSyncedAt` DESC, `updatedAt` DESC, `id` ASC.
 */
export function planDuplicateDeletions(
  rows: readonly DuplicateTaskCandidate[],
): string[] {
  return [...rows]
    .sort((left, right) => (
      compareText(right.lastSyncedAt, left.lastSyncedAt)
      || compareText(right.updatedAt, left.updatedAt)
      || left.id.localeCompare(right.id)
    ))
    .slice(1)
    .map((row) => row.id);
}

/**
 * Ids to delete across completed recurring groups.
 * Winner: `completedAt ?? updatedAt` DESC, then `id` ASC.
 */
export function planCompletedRecurringDeletions(
  tasks: readonly CleanupTaskCandidate[],
): string[] {
  return groupRecurring(tasks).flatMap((group) => [...group]
    .sort((left, right) => (
      compareText(right.completedAt ?? right.updatedAt, left.completedAt ?? left.updatedAt)
      || left.id.localeCompare(right.id)
    ))
    .slice(1)
    .map((task) => task.id));
}

/**
 * Ids to delete across open recurring groups.
 * Winner: nearest non-null `dueDate` ASC (nulls last), `updatedAt` DESC, `id` ASC.
 */
export function planOpenRecurringDeletions(
  tasks: readonly CleanupTaskCandidate[],
): string[] {
  return groupRecurring(tasks).flatMap((group) => [...group]
    .sort((left, right) => {
      if (left.dueDate !== right.dueDate) {
        if (!left.dueDate) return 1;
        if (!right.dueDate) return -1;
        const byDueDate = left.dueDate.localeCompare(right.dueDate);
        if (byDueDate !== 0) return byDueDate;
      }
      return compareText(right.updatedAt, left.updatedAt)
        || left.id.localeCompare(right.id);
    })
    .slice(1)
    .map((task) => task.id));
}

