/**
 * Versioned projection adapters for every enabled Mission Control entity kind.
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
import { semanticSensitivityRank } from '../contracts';
import type {
  SemanticAlertSource,
  SemanticHoustonSummarySource,
  SemanticProjectSource,
  SemanticSourceEntityType,
  SemanticSourceRecord,
  SemanticTagSource,
  SemanticTaskSource,
  SemanticTriageItemSource,
} from '../source/contracts';
import {
  computeContentFingerprint,
  computeSourceRevision,
  latestTimestamp,
  normalizeBodyField,
  normalizeBoundedBodyField,
  normalizeKeywords,
  normalizeMetadata,
  normalizeTitleField,
  toIsoTimestamp,
} from './normalize';

/** Bump when the task projection's shape or normalization changes. */
export const TASK_PROJECTION_VERSION = 2;
export const PROJECT_PROJECTION_VERSION = 1;
export const TAG_PROJECTION_VERSION = 1;
export const TRIAGE_ITEM_PROJECTION_VERSION = 1;

/** Bump when the alert projection's shape or normalization changes. */
export const ALERT_PROJECTION_VERSION = 2;
export const HOUSTON_SUMMARY_PROJECTION_VERSION = 1;

/**
 * The index-wide projection version. Must be >= every per-kind constant; the
 * assertion below fails the build the moment a kind is bumped in isolation.
 */
export const SEMANTIC_PROJECTION_VERSION = 3;

const PER_KIND_PROJECTION_VERSIONS: Readonly<Record<SemanticSourceEntityType, number>> = {
  task: TASK_PROJECTION_VERSION,
  project: PROJECT_PROJECTION_VERSION,
  tag: TAG_PROJECTION_VERSION,
  'triage-item': TRIAGE_ITEM_PROJECTION_VERSION,
  alert: ALERT_PROJECTION_VERSION,
  'houston-summary': HOUSTON_SUMMARY_PROJECTION_VERSION,
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
  const connectorTypes = ['mission-control', source.connectorType];
  const { projectionVersion, sensitivity } = sourceIdentity(
    'task',
    connectorTypes,
    options,
  );

  const title = normalizeTitleField(source.title);
  const body = normalizeBodyField(source.description);
  const keywords = normalizeKeywords([
    ...source.tags,
    ...source.projects,
    source.status,
    source.microStatus,
    source.planningHorizon,
    source.sourceListName,
    source.connectorType,
  ]);
  const metadata = normalizeMetadata({
    connectorType: source.connectorType,
    connectorTypes: normalizeKeywords(connectorTypes).join(','),
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
    projectIdsResolvedFromAuthority: true,
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
      projects: [...source.projects].sort(),
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

function sourceIdentity(
  entityType: SemanticSourceEntityType,
  connectorTypes: string[],
  options: SemanticProjectionOptions,
): { projectionVersion: number; sensitivity: SemanticSensitivity } {
  const normalizedConnectorTypes = normalizeKeywords(connectorTypes);
  const sensitivities = (normalizedConnectorTypes.length > 0
    ? normalizedConnectorTypes
    : ['mission-control'])
    .map((connectorType) => options.resolveSensitivity({ entityType, connectorType }));
  return {
    projectionVersion: options.projectionVersion ?? SEMANTIC_PROJECTION_VERSION,
    sensitivity: sensitivities.reduce((mostRestrictive, candidate) =>
      semanticSensitivityRank(candidate) < semanticSensitivityRank(mostRestrictive)
        ? candidate
        : mostRestrictive
    ),
  };
}

function finalizeProjection(input: {
  entityType: SemanticSourceEntityType;
  entityId: string;
  title: string;
  body: string;
  keywords: string[];
  metadata: Record<string, SemanticDocumentMetadataValue>;
  sourceSnapshot: Record<string, unknown>;
  sourceUpdatedAt: string;
  projectionVersion: number;
  sensitivity: SemanticSensitivity;
  retainUntil?: string | null;
}): SemanticIndexDocument {
  const retainUntil = input.retainUntil ?? null;
  return {
    entityType: input.entityType,
    entityId: input.entityId,
    title: input.title,
    body: input.body,
    keywords: input.keywords,
    metadata: input.metadata,
    sourceRevision: computeSourceRevision(input.sourceSnapshot),
    contentFingerprint: computeContentFingerprint({
      entityType: input.entityType,
      entityId: input.entityId,
      projectionVersion: input.projectionVersion,
      title: input.title,
      body: input.body,
      keywords: input.keywords,
      metadata: input.metadata,
      sensitivity: input.sensitivity,
      retainUntil,
    }),
    projectionVersion: input.projectionVersion,
    sensitivity: input.sensitivity,
    retainUntil,
    sourceUpdatedAt: input.sourceUpdatedAt,
  };
}

export function projectProject(
  source: SemanticProjectSource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const connectorTypes = ['mission-control', ...source.representativeTaskConnectorTypes];
  const identity = sourceIdentity('project', connectorTypes, options);
  const title = normalizeTitleField(source.name);
  const body = normalizeBodyField([
    source.description,
    source.representativeTasks.length
      ? `Representative tasks: ${source.representativeTasks.join('; ')}`
      : null,
  ].filter(Boolean).join('\n'));
  const keywords = normalizeKeywords([
    ...source.tags, source.status, source.statusOverride, source.category,
  ]);
  const metadata = normalizeMetadata({
    connectorType: 'mission-control',
    connectorTypes: normalizeKeywords(connectorTypes).join(','),
    status: source.status,
    statusOverride: source.statusOverride,
    category: source.category,
    hidden: source.hidden,
    taskCount: source.taskCount,
    targetDate: toIsoTimestamp(source.targetDate) ?? source.targetDate ?? null,
    navigationTarget: `/projects/${encodeURIComponent(source.id)}`,
  });
  return finalizeProjection({
    entityType: 'project',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    sourceSnapshot: {
      ...source,
      tags: [...source.tags].sort(),
      representativeTasks: [...source.representativeTasks],
      representativeTaskConnectorTypes: [...source.representativeTaskConnectorTypes].sort(),
    },
    sourceUpdatedAt: latestTimestamp([source.updatedAt, source.completedAt], source.createdAt),
    ...identity,
  });
}

export function projectTag(
  source: SemanticTagSource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const connectorType = source.source || 'mission-control';
  const connectorTypes = [connectorType, ...source.representativeTaskConnectorTypes];
  const identity = sourceIdentity('tag', connectorTypes, options);
  const title = normalizeTitleField(source.name);
  const body = normalizeBoundedBodyField(
    source.representativeTasks.length
      ? `Used by: ${source.representativeTasks.join('; ')}`
      : null,
    600,
  );
  const keywords = normalizeKeywords([source.slug, source.type, source.source]);
  const metadata = normalizeMetadata({
    connectorType,
    connectorTypes: normalizeKeywords(connectorTypes).join(','),
    slug: source.slug,
    type: source.type,
    source: source.source,
    confirmed: source.confirmed,
    unifiedInto: source.unifiedInto,
    usageCount: source.usageCount,
    navigationTarget: `/tags?tag=${encodeURIComponent(source.id)}`,
  });
  return finalizeProjection({
    entityType: 'tag',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    sourceSnapshot: {
      ...source,
      representativeTasks: [...source.representativeTasks],
      representativeTaskConnectorTypes: [...source.representativeTaskConnectorTypes].sort(),
    },
    sourceUpdatedAt: source.createdAt,
    ...identity,
  });
}

export function projectTriageItem(
  source: SemanticTriageItemSource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const identity = sourceIdentity('triage-item', [source.sourcePlatform], options);
  const title = normalizeTitleField(source.title);
  const body = normalizeBoundedBodyField(
    [source.aiSummary, source.description].filter(Boolean).join('\n'),
    1_200,
  );
  const keywords = normalizeKeywords([
    ...source.aiCategories,
    source.sourcePlatform,
    source.contentType,
    source.status,
    source.aiUrgency,
  ]);
  const metadata = normalizeMetadata({
    connectorType: source.sourcePlatform,
    sourcePlatform: source.sourcePlatform,
    contentType: source.contentType,
    status: source.status,
    urgency: source.aiUrgency,
    relevanceScore: source.aiRelevanceScore,
    snoozedUntil: toIsoTimestamp(source.snoozedUntil),
    navigationTarget: `/triage?id=${encodeURIComponent(source.id)}`,
  });
  return finalizeProjection({
    entityType: 'triage-item',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    sourceSnapshot: { ...source, aiCategories: [...source.aiCategories].sort() },
    sourceUpdatedAt: latestTimestamp([source.ingestedAt], source.capturedAt),
    ...identity,
  });
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
  // Alerts may contain connector payload details. Keep only the short summary
  // needed for retrieval; the authoritative notification remains the detail view.
  const body = normalizeBoundedBodyField(source.body, 600);
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
    navigationTarget: `/notifications?id=${encodeURIComponent(source.id)}`,
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

export function projectHoustonSummary(
  source: SemanticHoustonSummarySource,
  options: SemanticProjectionOptions,
): SemanticIndexDocument {
  const projectionVersion = options.projectionVersion ?? SEMANTIC_PROJECTION_VERSION;
  const policySensitivity = options.resolveSensitivity({
    entityType: 'houston-summary',
    connectorType: 'houston',
  });
  const sensitivity = semanticSensitivityRank(source.sensitivity)
    < semanticSensitivityRank(policySensitivity)
    ? source.sensitivity
    : policySensitivity;
  const title = normalizeTitleField(source.title);
  const body = normalizeBoundedBodyField([
    source.summary,
    source.decisions.length ? `Decisions: ${source.decisions.join('; ')}` : null,
    source.commitments.length ? `Commitments: ${source.commitments.join('; ')}` : null,
  ].filter(Boolean).join('\n'), 1_600);
  const keywords = normalizeKeywords([
    ...source.topics,
    ...source.linkedEntities.map((entity) => entity.label),
    ...source.linkedEntities.map((entity) => `${entity.type}:${entity.id}`),
  ]);
  const metadata = normalizeMetadata({
    connectorType: 'houston',
    connectorTypes: 'houston,mission-control',
    authorizationScope: source.authorizationScope,
    navigationTarget: `/ai?memory=${encodeURIComponent(source.id)}`,
    linkedTaskIds: source.linkedEntities
      .filter((entity) => entity.type === 'task').map((entity) => entity.id).join(','),
    linkedProjectIds: source.linkedEntities
      .filter((entity) => entity.type === 'project').map((entity) => entity.id).join(','),
    linkedTagIds: source.linkedEntities
      .filter((entity) => entity.type === 'tag').map((entity) => entity.id).join(','),
  });
  return finalizeProjection({
    entityType: 'houston-summary',
    entityId: source.id,
    title,
    body,
    keywords,
    metadata,
    sourceSnapshot: {
      kind: 'houston-summary',
      id: source.id,
      authorizationScope: source.authorizationScope,
      title: source.title,
      summary: source.summary,
      decisions: source.decisions,
      commitments: source.commitments,
      topics: source.topics,
      linkedEntities: source.linkedEntities,
      sensitivity: source.sensitivity,
      retainUntil: source.retainUntil,
      excludedAt: source.excludedAt,
      updatedAt: source.updatedAt,
    },
    sourceUpdatedAt: source.updatedAt,
    projectionVersion,
    sensitivity,
    retainUntil: source.retainUntil,
  });
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
    case 'project':
      return projectProject(source, options);
    case 'tag':
      return projectTag(source, options);
    case 'triage-item':
      return projectTriageItem(source, options);
    case 'alert':
      return projectAlert(source, options);
    case 'houston-summary':
      return projectHoustonSummary(source, options);
  }
}

/**
 * The text handed to the embedding provider. Kept separate from the document so
 * a change to embedding input alone is an explicit, reviewable decision.
 */
export const SEMANTIC_EMBEDDING_FIELD_WEIGHTS = {
  title: 3,
  keywords: 2,
  body: 1,
} as const;

export function buildEmbeddingText(document: SemanticIndexDocument): string {
  const weighted = [
    ...Array.from({ length: SEMANTIC_EMBEDDING_FIELD_WEIGHTS.title }, () => document.title),
    ...Array.from(
      { length: SEMANTIC_EMBEDDING_FIELD_WEIGHTS.keywords },
      () => document.keywords.join(', '),
    ),
    document.body,
  ];
  return weighted
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n');
}

export function projectionVersionFor(entityType: SemanticEntityType): number | null {
  return PER_KIND_PROJECTION_VERSIONS[entityType];
}
