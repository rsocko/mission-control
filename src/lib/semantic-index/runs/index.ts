/**
 * Durable, resumable maintenance runs: backfill, reconciliation, cleanup.
 *
 * Every run is a **slice** executor: it is handed a claimed `SemanticRun` and a
 * budget, it does bounded work, it checkpoints, and it either completes or
 * yields the lease back with its checkpoint intact. Nothing here loops
 * unbounded, and nothing here holds a lease it is not heartbeating.
 *
 * Checkpoints are stable entity-id cursors (`{"kind":"task","after":"t-42"}`),
 * so a resumed run never rescans a page it already processed and never skips
 * one because rows were inserted or deleted underneath it.
 */

import { semanticIndexLogger } from '@/lib/logger';
import type {
  SemanticIndexIdentity,
  SemanticIndexRepository,
  SemanticRun,
} from '../contracts';
import type { SemanticWorkerConfig } from '../config';
import type { SemanticIndexService } from '../service';
import {
  SEMANTIC_SOURCE_ENTITY_TYPES,
  type SemanticSourceEntityType,
  type SemanticSourcePort,
} from '../source/contracts';

export interface SemanticRunContext {
  run: SemanticRun;
  identity: SemanticIndexIdentity;
  owner: string;
  signal: AbortSignal;
  /** Absolute wall-clock deadline for this slice. */
  deadlineMs: number;
}

export interface SemanticRunSliceResult {
  status: 'completed' | 'yielded' | 'aborted';
  processed: number;
  skipped: number;
  failed: number;
  checkpoint: string | null;
  detail?: Record<string, number | string>;
}

export interface SemanticRunDependencies {
  repository: SemanticIndexRepository;
  source: SemanticSourcePort;
  service: SemanticIndexService;
  config: SemanticWorkerConfig;
  now: () => string;
}

// ─── Checkpoints ────────────────────────────────────────────────────────────

interface KindCursor {
  kind: SemanticSourceEntityType;
  after: string | null;
}

/**
 * Parses a checkpoint. An unrecognized or corrupt checkpoint restarts the run
 * from the beginning rather than silently skipping entities — re-running is
 * idempotent, skipping is not.
 */
export function parseKindCursor(checkpoint: string | null): KindCursor {
  const fallback: KindCursor = { kind: SEMANTIC_SOURCE_ENTITY_TYPES[0], after: null };
  if (!checkpoint) return fallback;
  try {
    const parsed = JSON.parse(checkpoint) as Partial<KindCursor>;
    const kind = SEMANTIC_SOURCE_ENTITY_TYPES.find((candidate) => candidate === parsed.kind);
    if (!kind) return fallback;
    return { kind, after: typeof parsed.after === 'string' ? parsed.after : null };
  } catch {
    return fallback;
  }
}

export function serializeKindCursor(cursor: KindCursor | null): string | null {
  return cursor === null ? null : JSON.stringify(cursor);
}

function nextKind(kind: SemanticSourceEntityType): SemanticSourceEntityType | null {
  const index = SEMANTIC_SOURCE_ENTITY_TYPES.indexOf(kind);
  return index >= 0 && index + 1 < SEMANTIC_SOURCE_ENTITY_TYPES.length
    ? SEMANTIC_SOURCE_ENTITY_TYPES[index + 1]
    : null;
}

// ─── Backfill ───────────────────────────────────────────────────────────────

/**
 * Walks every source entity of every supported kind in stable id order and
 * publishes an upsert intent for each.
 *
 * Backfill deliberately reuses the *same* intent path as live writes: it never
 * writes documents or vectors itself, so there is exactly one implementation of
 * "how an entity becomes indexed" and no second code path to keep in sync.
 * Enqueueing is idempotent, so a resumed or repeated backfill converges.
 */
export async function runBackfillSlice(
  context: SemanticRunContext,
  deps: SemanticRunDependencies,
): Promise<SemanticRunSliceResult> {
  let cursor = parseKindCursor(context.run.checkpoint);
  let processed = 0;
  let skipped = 0;

  for (;;) {
    if (context.signal.aborted) {
      return {
        status: 'aborted', processed, skipped, failed: 0, checkpoint: serializeKindCursor(cursor),
      };
    }
    if (Date.now() >= context.deadlineMs) {
      return {
        status: 'yielded', processed, skipped, failed: 0, checkpoint: serializeKindCursor(cursor),
      };
    }

    const page = await deps.source.listIds(cursor.kind, {
      afterId: cursor.after,
      limit: deps.config.runPageSize,
    });

    for (const entityId of page.ids) {
      const result = await deps.service.publish({
        kind: 'upsert',
        entityType: cursor.kind,
        entityId,
        indexId: context.identity.id,
        requestedAt: deps.now(),
      });
      if (result.status === 'published') processed += 1;
      else skipped += 1;
    }

    if (page.nextCursor !== null) {
      cursor = { kind: cursor.kind, after: page.nextCursor };
      continue;
    }

    const following = nextKind(cursor.kind);
    if (!following) {
      return { status: 'completed', processed, skipped, failed: 0, checkpoint: null };
    }
    cursor = { kind: following, after: null };
  }
}

// ─── Reconciliation ─────────────────────────────────────────────────────────

export type SemanticDrift =
  /** A live source entity with no live document. */
  | 'missing'
  /** A document whose revision no longer matches the source. */
  | 'stale'
  /** A document with no vector, or a vector from a different vector space. */
  | 'incompatible'
  /** A live document whose source entity is gone. */
  | 'orphaned'
  /** A live document past its retention deadline. */
  | 'retention-expired';

export interface SemanticReconciliationCounts {
  scanned: number;
  missing: number;
  stale: number;
  incompatible: number;
  orphaned: number;
  retentionExpired: number;
  enqueued: number;
}

/**
 * Compares the authoritative source against the index and enqueues repair work.
 *
 * Reconciliation walks source ids (not documents) so a *missing* document is
 * detectable, and joins the document/vector state for the same id window so
 * *stale*, *incompatible*, *orphaned*, and *retention-expired* states fall out
 * of one bounded pass. Repairs are enqueued as ordinary intents; reconciliation
 * never writes documents or vectors directly.
 */
export async function runReconcileSlice(
  context: SemanticRunContext,
  deps: SemanticRunDependencies,
): Promise<SemanticRunSliceResult> {
  let cursor = parseKindCursor(context.run.checkpoint);
  const counts: SemanticReconciliationCounts = {
    scanned: 0,
    missing: 0,
    stale: 0,
    incompatible: 0,
    orphaned: 0,
    retentionExpired: 0,
    enqueued: 0,
  };

  const finish = (status: SemanticRunSliceResult['status'], checkpoint: string | null) => ({
    status,
    processed: counts.enqueued,
    skipped: counts.scanned - counts.enqueued,
    failed: 0,
    checkpoint,
    detail: {
      scanned: counts.scanned,
      missing: counts.missing,
      stale: counts.stale,
      incompatible: counts.incompatible,
      orphaned: counts.orphaned,
      retentionExpired: counts.retentionExpired,
    },
  } satisfies SemanticRunSliceResult);

  for (;;) {
    if (context.signal.aborted) return finish('aborted', serializeKindCursor(cursor));
    if (Date.now() >= context.deadlineMs) return finish('yielded', serializeKindCursor(cursor));

    const now = deps.now();
    const sourcePage = await deps.source.list(cursor.kind, {
      afterId: cursor.after,
      limit: deps.config.runPageSize,
    });
    const documentPage = await deps.repository.listDocuments({
      indexId: context.identity.id,
      entityType: cursor.kind,
      afterEntityId: cursor.after,
      limit: deps.config.runPageSize,
      includeDeleted: false,
    });

    // The two cursors advance independently, so the comparison window is the
    // id range both pages actually cover. Anything past that boundary belongs
    // to a later page and must not be judged yet.
    const sourceCeiling = sourcePage.nextCursor;
    const documentCeiling = documentPage.length === deps.config.runPageSize
      ? documentPage[documentPage.length - 1].entityId
      : null;
    const windowCeiling = sourceCeiling === null
      ? documentCeiling
      : documentCeiling === null
        ? sourceCeiling
        : (sourceCeiling < documentCeiling ? sourceCeiling : documentCeiling);

    const inWindow = (entityId: string) => windowCeiling === null || entityId <= windowCeiling;
    const documents = new Map(
      documentPage.filter((document) => inWindow(document.entityId))
        .map((document) => [document.entityId, document]),
    );
    const sourceRecords = sourcePage.records.filter((record) => inWindow(record.id));
    const sourceIdSet = new Set(sourceRecords.map((record) => record.id));

    for (const record of sourceRecords) {
      const entityId = record.id;
      counts.scanned += 1;
      const document = documents.get(entityId);
      let drift: SemanticDrift | null = null;

      if (!document) {
        drift = 'missing';
        counts.missing += 1;
      } else if (document.projectionVersion !== context.identity.projectionVersion) {
        drift = 'incompatible';
        counts.incompatible += 1;
      } else if (document.retainUntil !== null && document.retainUntil <= now) {
        // Cleanup tombstones it; reconciliation only reports it so the counter
        // and the cleanup run cannot disagree about what is expired.
        counts.retentionExpired += 1;
      } else if (
        // Reproject the live snapshot: this is the only way to notice that a
        // stored document drifted from its source because a publish was lost.
        deps.service.project(record, context.identity.projectionVersion).sourceRevision
        !== document.sourceRevision
      ) {
        drift = 'stale';
        counts.stale += 1;
      } else if (!document.vector) {
        drift = 'incompatible';
        counts.incompatible += 1;
      } else if (
        document.vector.provider !== context.identity.provider
        || document.vector.model !== context.identity.model
        || document.vector.dimensions !== context.identity.dimensions
        || document.vector.projectionVersion !== context.identity.projectionVersion
      ) {
        drift = 'incompatible';
        counts.incompatible += 1;
      } else if (
        document.vector.documentVersion !== document.version
        || document.vector.sourceRevision !== document.sourceRevision
        || document.vector.contentFingerprint !== document.contentFingerprint
      ) {
        drift = 'stale';
        counts.stale += 1;
      }

      if (drift) {
        const published = await deps.service.publish({
          kind: 'upsert',
          entityType: cursor.kind,
          entityId,
          indexId: context.identity.id,
          requestedAt: now,
        });
        if (published.status === 'published') counts.enqueued += 1;
      }
    }

    // Orphans: documents in this window with no matching source row. The
    // existence probe is a single bounded query, not one read per document.
    const documentOnlyIds = [...documents.keys()]
      .filter((entityId) => !sourceIdSet.has(entityId));
    if (documentOnlyIds.length > 0) {
      const existing = await deps.source.listExisting(cursor.kind, documentOnlyIds);
      for (const entityId of documentOnlyIds) {
        counts.scanned += 1;
        if (existing.has(entityId)) continue;
        counts.orphaned += 1;
        const published = await deps.service.publish({
          kind: 'delete',
          entityType: cursor.kind,
          entityId,
          indexId: context.identity.id,
          requestedAt: now,
        });
        if (published.status === 'published') counts.enqueued += 1;
      }
    }

    if (windowCeiling !== null) {
      cursor = { kind: cursor.kind, after: windowCeiling };
      continue;
    }

    const following = nextKind(cursor.kind);
    if (!following) return finish('completed', null);
    cursor = { kind: following, after: null };
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

export interface SemanticCleanupCounts {
  documentsExpired: number;
  vectorsRemoved: number;
  documentsPurged: number;
  intentsPruned: number;
  identitiesRemoved: number;
}

/**
 * Retention and garbage collection, in dependency order:
 *
 * 1. tombstone documents past `retainUntil` (and drop their vectors);
 * 2. hard-delete tombstones older than the tombstone retention window;
 * 3. prune terminal intent history; and
 * 4. remove `retired`/`failed` identities older than the identity retention
 *    window. The active identity is never eligible, and the repository refuses
 *    to remove it even if asked.
 *
 * Each step is bounded per slice, so cleanup on a large corpus makes steady
 * progress instead of holding one long transaction.
 */
export async function runCleanupSlice(
  context: SemanticRunContext,
  deps: SemanticRunDependencies,
): Promise<SemanticRunSliceResult> {
  const now = deps.now();
  const nowMs = new Date(now).getTime();
  const counts: SemanticCleanupCounts = {
    documentsExpired: 0,
    vectorsRemoved: 0,
    documentsPurged: 0,
    intentsPruned: 0,
    identitiesRemoved: 0,
  };

  const expired = await deps.repository.expireDocuments({
    now,
    limit: deps.config.runPageSize,
  });
  counts.documentsExpired = expired.documentsExpired;
  counts.vectorsRemoved = expired.vectorsRemoved;

  if (!context.signal.aborted) {
    counts.documentsPurged = await deps.repository.purgeDeletedDocuments({
      before: new Date(nowMs - deps.config.tombstoneRetentionMs).toISOString(),
      limit: deps.config.runPageSize,
    });
  }

  if (!context.signal.aborted) {
    counts.intentsPruned = await deps.repository.pruneIntents(
      new Date(nowMs - deps.config.intentHistoryRetentionMs).toISOString(),
    );
  }

  if (!context.signal.aborted) {
    const identityCleanup = await deps.repository.cleanupIdentities({
      before: new Date(nowMs - deps.config.identityRetentionMs).toISOString(),
      now,
    });
    counts.identitiesRemoved = identityCleanup.identitiesRemoved;
  }

  const processed = counts.documentsExpired
    + counts.documentsPurged
    + counts.intentsPruned
    + counts.identitiesRemoved;

  semanticIndexLogger.info({
    event: 'semantic_cleanup_slice',
    runId: context.run.id,
    indexId: context.identity.id,
    ...counts,
  }, 'Semantic index cleanup slice completed');

  // Retention work is naturally repeated on a schedule rather than resumed, so
  // a slice always completes; the next scheduled run picks up whatever the
  // per-slice bound left behind.
  return {
    status: context.signal.aborted ? 'aborted' : 'completed',
    processed,
    skipped: 0,
    failed: 0,
    checkpoint: null,
    detail: { ...counts },
  };
}

// ─── Dispatch ───────────────────────────────────────────────────────────────

export function runSlice(
  context: SemanticRunContext,
  deps: SemanticRunDependencies,
): Promise<SemanticRunSliceResult> {
  switch (context.run.kind) {
    case 'backfill':
      return runBackfillSlice(context, deps);
    case 'reconcile':
      return runReconcileSlice(context, deps);
    case 'cleanup':
      return runCleanupSlice(context, deps);
  }
}

/** Stable run idempotency key: one run per (index, kind, window). */
export function runIdempotencyKey(
  indexId: string,
  kind: SemanticRun['kind'],
  window: string,
): string {
  return `${indexId}\u0000${kind}\u0000${window}`;
}
