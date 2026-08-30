/**
 * Versioned projection adapters for the two entity kinds this phase indexes.
 *
 * A projection adapter is a **pure function** from an authoritative source
 * snapshot to a `SemanticIndexDocument`. It performs no I/O, resolves no
 * configuration, and never reads the clock — every non-deterministic input is
 * passed in. That is what lets the worker reread a source row and rebuild a
 * byte-identical projection to compare fingerprints against.
 *
 * ## Projection versions
 *
 * A `SemanticIndexIdentity` carries exactly one `projectionVersion`, and both
 * document and vector writes are rejected unless they match it. The index-wide
 * version is therefore the contract, and the per-kind constants below exist to
 * document *why* it has its current value: bumping any per-kind version must
 * bump `SEMANTIC_PROJECTION_VERSION`, which forces a new index identity and a
 * staged rebuild rather than an in-place rewrite of a mixed corpus.
 */

import type {
  SemanticDocumentMetadataValue,
  SemanticEntityType,
  SemanticIndexDocument,
  SemanticSensitivity,
} from '../contracts';
import type {
  SemanticAlertSource,
  SemanticSourceEntityType,
  SemanticSourceRecord,
  SemanticTaskSource,
} from '../source/contracts';
import {
  computeContentFingerprint,
  computeSourceRevision,
  latestTimestamp,
  normalizeBodyField,
  normalizeKeywords,
  normalizeMetadata,
  normalizeTitleField,
  toIsoTimestamp,
} from './normalize';

/** Bump when the task projection's shape or normalization changes. */
export const TASK_PROJECTION_VERSION = 1;

/** Bump when the alert projection's shape or normalization changes. */
export const ALERT_PROJECTION_VERSION = 1;

/**
 * The index-wide projection version. Must be >= every per-kind constant; the
 * assertion below fails the build the moment a kind is bumped in isolation.
 */
export const SEMANTIC_PROJECTION_VERSION = 1;

const PER_KIND_PROJECTION_VERSIONS: Readonly<Record<SemanticSourceEntityType, number>> = {
  task: TASK_PROJECTION_VERSION,
  alert: ALERT_PROJECTION_VERSION,
};

/**
 * Resolves the sensitivity tier for a source record. Supplied by the caller so
 * projections stay pure; the production implementation delegates to the AI
 * routing policy in `src/lib/semantic-index/sensitivity.ts`.
 */
export type SemanticSensitivityResolver = (input: {
  entityType: SemanticSourceEntityType;
  connectorType: string;
}) => SemanticSensitivity;

export interface SemanticProjectionOptions {
  resolveSensitivity: SemanticSensitivityResolver;
  /** Index-wide projection version; defaults to `SEMANTIC_PROJECTION_VERSION`. */
  projectionVersion?: number;
}

function assertProjectionVersionCoverage(): void {
  for (const [kind, version] of Object.entries(PER_KIND_PROJECTION_VERSIONS)) {
    if (version > SEMANTIC_PROJECTION_VERSION) {
      throw new Error(
        `Projection version for ${kind} is ${version} but SEMANTIC_PROJECTION_VERSION is `
        + `${SEMANTIC_PROJECTION_VERSION}; bump the index-wide version so a new identity is built`,
      );
    }
  }
}

assertProjectionVersionCoverage();

// ─── Task ───────────────────────────────────────────────────────────────────

/**
 * Projects a task.
 *
 * `sourceUpdatedAt` is `updatedAt` widened by `completedAt`, because completing
 * a task through some sync paths stamps only the completion time; taking the
 * later of the two keeps the guard monotonic.
 */
export function projectTask(
  source: SemanticTaskSource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const projectionVersion = options.projectionVersion ?? SEMANTIC_PROJECTION_VERSION;
  const sensitivity = options.resolveSensitivity({
    entityType: 'task',
    connectorType: source.connectorType,
  });

  const title = normalizeTitleField(source.title);
  const body = normalizeBodyField(source.description);
  const keywords = normalizeKeywords([
    ...source.tags,
    source.status,
    source.microStatus,
    source.planningHorizon,
    source.sourceListName,
    source.connectorType,
  ]);
  const metadata = normalizeMetadata({
    connectorType: source.connectorType,
    status: source.status,
    statusReason: source.statusReason,
    microStatus: source.microStatus,
    priority: source.priority,
    planningHorizon: source.planningHorizon,
    localDisposition: source.localDisposition,
    effort: source.effort,
    dueDate: toIsoTimestamp(source.dueDate) ?? source.dueDate ?? null,
    sourceListName: source.sourceListName,
    parentId: source.parentId,
    isChecklistItem: source.isChecklistItem,
    createdAt: toIsoTimestamp(source.createdAt),
    completedAt: toIsoTimestamp(source.completedAt),
  } satisfies Record<string, SemanticDocumentMetadataValue | undefined>);

  const sourceUpdatedAt = latestTimestamp(
    [source.updatedAt, source.completedAt],
    source.createdAt,
  );

  return {
    entityType: 'task',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    projectionVersion,
    sensitivity,
    // Tasks have no intrinsic retention deadline: they live until the domain
    // deletes them, at which point a delete intent tombstones the document.
    retainUntil: null,
    sourceUpdatedAt,
    sourceRevision: computeSourceRevision({
      kind: 'task',
      id: source.id,
      title: source.title,
      description: source.description,
      status: source.status,
      statusReason: source.statusReason,
      microStatus: source.microStatus,
      priority: source.priority,
      planningHorizon: source.planningHorizon,
      localDisposition: source.localDisposition,
      effort: source.effort,
      dueDate: source.dueDate,
      connectorType: source.connectorType,
      sourceListName: source.sourceListName,
      parentId: source.parentId,
      isChecklistItem: source.isChecklistItem,
      createdAt: source.createdAt,
      updatedAt: source.updatedAt,
      completedAt: source.completedAt,
      tags: [...source.tags].sort(),
    }),
    contentFingerprint: computeContentFingerprint({
      entityType: 'task',
      entityId: source.id,
      projectionVersion,
      title,
      body,
      keywords,
      metadata,
      sensitivity,
      retainUntil: null,
    }),
  };
}

// ─── Alert ──────────────────────────────────────────────────────────────────

/**
 * Projects an alert (Mission Control's `notifications` row).
 *
 * `notifications` carries no `updated_at`, so the monotonic stamp is the latest
 * of every activity timestamp the projection reads. `expiresAt` becomes
 * `retainUntil`, which is what makes retention cleanup meaningful for alerts.
 */
export function projectAlert(
  source: SemanticAlertSource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const projectionVersion = options.projectionVersion ?? SEMANTIC_PROJECTION_VERSION;
  const sensitivity = options.resolveSensitivity({
    entityType: 'alert',
    connectorType: source.connectorType,
  });

  const title = normalizeTitleField(source.title);
  const body = normalizeBodyField(source.body);
  const keywords = normalizeKeywords([
    source.level,
    source.category,
    source.connectorType,
    source.disposition,
    source.sourceState,
  ]);
  const metadata = normalizeMetadata({
    connectorType: source.connectorType,
    level: source.level,
    category: source.category,
    state: source.state,
    readState: source.readState,
    disposition: source.disposition,
    sourceState: source.sourceState,
    isActionable: source.isActionable,
    receivedAt: toIsoTimestamp(source.receivedAt),
    relatedTaskId: source.relatedTaskId,
    relatedProjectId: source.relatedProjectId,
  } satisfies Record<string, SemanticDocumentMetadataValue | undefined>);

  const retainUntil = toIsoTimestamp(source.expiresAt);
  const sourceUpdatedAt = latestTimestamp(
    [
      source.receivedAt,
      source.sortAt,
      source.lastSourceActivityAt,
      source.readAt,
      source.handledAt,
      source.resolvedAt,
      source.archivedAt,
      source.dismissedAt,
    ],
    source.receivedAt,
  );

  return {
    entityType: 'alert',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    projectionVersion,
    sensitivity,
    retainUntil,
    sourceUpdatedAt,
    sourceRevision: computeSourceRevision({
      kind: 'alert',
      id: source.id,
      title: source.title,
      body: source.body,
      level: source.level,
      category: source.category,
      state: source.state,
      readState: source.readState,
      disposition: source.disposition,
      sourceState: source.sourceState,
      connectorType: source.connectorType,
      isActionable: source.isActionable,
      receivedAt: source.receivedAt,
      sortAt: source.sortAt,
      expiresAt: source.expiresAt,
      lastSourceActivityAt: source.lastSourceActivityAt,
      readAt: source.readAt,
      handledAt: source.handledAt,
      resolvedAt: source.resolvedAt,
      archivedAt: source.archivedAt,
      dismissedAt: source.dismissedAt,
      relatedTaskId: source.relatedTaskId,
      relatedProjectId: source.relatedProjectId,
    }),
    contentFingerprint: computeContentFingerprint({
      entityType: 'alert',
      entityId: source.id,
      projectionVersion,
      title,
      body,
      keywords,
      metadata,
      sensitivity,
      retainUntil,
    }),
  };
}

// ─── Registry ───────────────────────────────────────────────────────────────

/**
 * Projects any supported source record. Exhaustive over
 * `SemanticSourceEntityType`, so adding a kind is a compile error until it has
 * an adapter.
 */
export function projectSource(
  source: SemanticSourceRecord,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  switch (source.entityType) {
    case 'task':
      return projectTask(source, options);
    case 'alert':
      return projectAlert(source, options);
  }
}

/**
 * The text handed to the embedding provider. Kept separate from the document so
 * a change to embedding input alone is an explicit, reviewable decision.
 */
export function buildEmbeddingText(document: SemanticIndexDocument): string {
  return [document.title, document.keywords.join(', '), document.body]
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

export function projectionVersionFor(entityType: SemanticEntityType): number | null {
  return entityType === 'task' || entityType === 'alert'
    ? PER_KIND_PROJECTION_VERSIONS[entityType]
    : null;
}
