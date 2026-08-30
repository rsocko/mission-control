/**
 * The authoritative-source read port for the semantic index.
 *
 * The index worker never reads domain tables directly. It reads *through* this
 * port, which both the SQLite and PostgreSQL adapters implement identically, so
 * a single worker implementation is correct on either backend and the core
 * worker/service code contains no driver-specific SQL.
 *
 * The port is intentionally tiny and read-only:
 *
 * - `get`         — the latest snapshot of one entity (the reread the worker
 *                   performs immediately before writing a projection);
 * - `listIds`     — a bounded, keyset-paginated id page in stable id order,
 *                   which is exactly the checkpoint shape a resumable backfill
 *                   persists; and
 * - `listExisting`— an existence probe for a bounded id batch, so reconciliation
 *                   can find orphaned documents without an N+1 read.
 *
 * Only the two kinds this phase indexes are modelled: `task` and `alert` (the
 * canonical name for Mission Control's `notifications` table).
 */

import type { SemanticEntityType } from '../contracts';

/** Entity kinds with a projection adapter in this phase. */
export type SemanticSourceEntityType = Extract<SemanticEntityType, 'task' | 'alert'>;

export const SEMANTIC_SOURCE_ENTITY_TYPES: readonly SemanticSourceEntityType[] = [
  'task',
  'alert',
] as const;

export function isSemanticSourceEntityType(
  value: SemanticEntityType,
): value is SemanticSourceEntityType {
  return value === 'task' || value === 'alert';
}

/**
 * A task exactly as the projection needs it. Field names mirror the domain
 * schema so an adapter is a column projection, not a translation layer.
 */
export interface SemanticTaskSource {
  entityType: 'task';
  id: string;
  title: string;
  description: string | null;
  status: string;
  statusReason: string | null;
  microStatus: string | null;
  priority: string;
  planningHorizon: string | null;
  localDisposition: string;
  effort: number | null;
  dueDate: string | null;
  connectorType: string;
  sourceListName: string | null;
  parentId: string | null;
  isChecklistItem: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Tag names joined through `task_tags`, in whatever order the join yields. */
  tags: string[];
}

/**
 * An alert/notification exactly as the projection needs it. `notifications` has
 * no `updated_at`, so the projection derives its monotonic stamp from the
 * activity timestamps this record exposes.
 */
export interface SemanticAlertSource {
  entityType: 'alert';
  id: string;
  title: string;
  body: string | null;
  level: string;
  category: string;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  connectorType: string;
  isActionable: boolean;
  receivedAt: string;
  sortAt: string;
  expiresAt: string | null;
  lastSourceActivityAt: string | null;
  readAt: string | null;
  handledAt: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  dismissedAt: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
}

export type SemanticSourceRecord = SemanticTaskSource | SemanticAlertSource;

export interface SemanticSourceIdPage {
  /** Entity ids in ascending id order. */
  ids: string[];
  /** The id to resume after, or `null` when the kind is exhausted. */
  nextCursor: string | null;
}

export interface SemanticSourceRecordPage {
  /** Full snapshots in ascending id order. */
  records: SemanticSourceRecord[];
  /** The id to resume after, or `null` when the kind is exhausted. */
  nextCursor: string | null;
}

export interface SemanticSourcePort {
  get(
    entityType: SemanticSourceEntityType,
    entityId: string,
  ): Promise<SemanticSourceRecord | null>;
  /**
   * One bounded page of ids in ascending `id` order, strictly after `afterId`.
   * Ascending id order is stable under concurrent inserts and deletes, which is
   * what makes a checkpointed backfill resumable without re-reading pages.
   */
  listIds(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceIdPage>;
  /**
   * One bounded page of full snapshots, same ordering as `listIds`.
   *
   * Reconciliation needs content — not just ids — to tell whether a stored
   * document still matches its source, and a page read is one query where a
   * per-id `get` would be N+1.
   */
  list(
    entityType: SemanticSourceEntityType,
    input: { afterId?: string | null; limit: number },
  ): Promise<SemanticSourceRecordPage>;
  /** The subset of `entityIds` that still exist. Bounded by the caller. */
  listExisting(
    entityType: SemanticSourceEntityType,
    entityIds: string[],
  ): Promise<Set<string>>;
}
