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
 * Houston summaries are authoritative minimized records. Raw conversation
 * messages never cross this port.
 */

import type { SemanticEntityType } from '../contracts';

/** Entity kinds with an authoritative source adapter. */
export type SemanticSourceEntityType = SemanticEntityType;

export const SEMANTIC_SOURCE_ENTITY_TYPES: readonly SemanticSourceEntityType[] = [
  'task',
  'project',
  'tag',
  'triage-item',
  'alert',
  'houston-summary',
] as const;

export function isSemanticSourceEntityType(
  value: SemanticEntityType,
): value is SemanticSourceEntityType {
  return SEMANTIC_SOURCE_ENTITY_TYPES.includes(value);
}

/**
 * A task exactly as the projection needs it. Field names mirror the domain
 * schema so an adapter is a column projection, not a translation layer.
 */
export interface SemanticTaskSource {
  entityType: 'task';
  semanticEligible: true;
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
  /** Project names joined through `task_projects`. */
  projects: string[];
}

export interface SemanticProjectSource {
  entityType: 'project';
  semanticEligible: boolean;
  id: string;
  name: string;
  description: string | null;
  status: string;
  statusOverride: string | null;
  hidden: boolean;
  category: string | null;
  targetDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  /** Stable, bounded representative task titles in ascending task-id order. */
  representativeTasks: string[];
  representativeTaskConnectorTypes: string[];
  taskCount: number;
  latestTaskUpdatedAt: string | null;
}

export interface SemanticTagSource {
  entityType: 'tag';
  semanticEligible: boolean;
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  confirmed: boolean;
  createdAt: string;
  unifiedInto: string | null;
  usageCount: number;
  /** Stable, bounded examples in ascending task-id order. */
  representativeTasks: string[];
  representativeTaskConnectorTypes: string[];
  latestTaskUpdatedAt: string | null;
}

export interface SemanticTriageItemSource {
  entityType: 'triage-item';
  semanticEligible: boolean;
  id: string;
  sourcePlatform: string;
  title: string;
  description: string | null;
  contentType: string;
  capturedAt: string;
  ingestedAt: string;
  status: string;
  snoozedUntil: string | null;
  aiSummary: string | null;
  aiCategories: string[];
  aiRelevanceScore: number;
  aiUrgency: string;
}

/**
 * An alert/notification exactly as the projection needs it. `notifications` has
 * no `updated_at`, so the projection derives its monotonic stamp from the
 * activity timestamps this record exposes.
 */
export interface SemanticAlertSource {
  entityType: 'alert';
  semanticEligible: boolean;
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

export interface SemanticHoustonSummarySource {
  entityType: 'houston-summary';
  semanticEligible: boolean;
  id: string;
  authorizationScope: string;
  title: string;
  summary: string;
  decisions: string[];
  commitments: string[];
  topics: string[];
  linkedEntities: Array<{
    type: 'task' | 'project' | 'tag';
    id: string;
    label: string;
  }>;
  sensitivity: 'local-only' | 'restricted' | 'standard';
  retainUntil: string;
  excludedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type SemanticSourceRecord =
  | SemanticTaskSource
  | SemanticProjectSource
  | SemanticTagSource
  | SemanticTriageItemSource
  | SemanticAlertSource
  | SemanticHoustonSummarySource;

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
