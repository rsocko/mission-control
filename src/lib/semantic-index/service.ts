/**
 * The semantic index lifecycle service.
 *
 * This is the only place that knows how an authoritative domain write becomes a
 * durable, versioned, embedded document. It is deliberately transport-free: it
 * takes a repository, a source port, an embedding provider, and a clock, and it
 * is therefore fully testable without a database, a network, or a worker loop.
 *
 * Three responsibilities:
 *
 * 1. `ensureIdentity` — resolve (or create) the index identity for the
 *    configured embedding route. An identity names a vector space
 *    (provider, model, dimensions, projectionVersion) and cannot be created
 *    until the dimension count is actually known, so it is created from a real
 *    provider response rather than from a guess.
 * 2. `publish` — record an idempotent upsert/delete intent after the
 *    authoritative write has committed. Publishing never blocks the caller on
 *    a provider and never throws into a domain write path.
 * 3. `processIntent` — execute one intent: reread the newest source snapshot,
 *    rebuild the projection, write the versioned document, skip the embedding
 *    when the content fingerprint is unchanged, and write the vector
 *    conditionally so a delayed worker can never overwrite newer work.
 */

import { randomUUID } from 'node:crypto';
import { semanticIndexLogger } from '@/lib/logger';
import {
  SEMANTIC_WRITABLE_IDENTITY_STATUSES,
  type SemanticEntityType,
  type SemanticIndexDocument,
  type SemanticIndexIdentity,
  type SemanticIndexRepository,
  type SemanticIntent,
  type SemanticIntentKind,
  type SemanticSensitivity,
} from './contracts';
import {
  buildEmbeddingText,
  projectSource,
  SEMANTIC_PROJECTION_VERSION,
  type SemanticSensitivityResolver,
} from './projections';
import {
  isSemanticSourceEntityType,
  type SemanticSourceEntityType,
  type SemanticSourcePort,
  type SemanticSourceRecord,
} from './source/contracts';
import type { SemanticEmbeddingProvider } from './embedding-provider';

/** A fixed, content-free probe used only to learn a model's dimension count. */
const DIMENSION_PROBE_TEXT = 'mission control semantic index dimension probe';

export interface SemanticIndexServiceOptions {
  repository: SemanticIndexRepository;
  source: SemanticSourcePort;
  embeddings: SemanticEmbeddingProvider;
  resolveSensitivity: SemanticSensitivityResolver;
  projectionVersion?: number;
  now?: () => string;
  newId?: () => string;
  embeddingTimeoutMs?: number;
}

export type SemanticIdentityResolution =
  | { status: 'ready'; identity: SemanticIndexIdentity; created: boolean }
  | { status: 'unavailable'; reason: string };

export type SemanticPublishStatus = 'published' | 'skipped';

export interface SemanticPublishResult {
  status: SemanticPublishStatus;
  reason?: string;
  intentId?: string;
}

export type SemanticIntentOutcomeStatus =
  /** Terminal success. `outcome` names what actually happened. */
  | 'succeeded'
  /** Requeued for a later attempt. */
  | 'retry'
  /** Terminal failure — retrying cannot help. */
  | 'failed'
  /** Terminal policy refusal. */
  | 'denied'
  /** The worker was asked to stop; the intent was released for another pass. */
  | 'aborted'
  /** The lease was lost (expired or stolen); nothing was recorded. */
  | 'lease-lost';

export interface SemanticIntentOutcome {
  status: SemanticIntentOutcomeStatus;
  /** Short, non-sensitive detail persisted on the intent row. */
  outcome: string;
  retryAfter?: string | null;
}

function isWritable(identity: SemanticIndexIdentity): boolean {
  return SEMANTIC_WRITABLE_IDENTITY_STATUSES.includes(identity.status);
}

/**
 * Preference order when several identities share one vector space: the one
 * being served, then one ready for cutover, then one still building.
 */
const IDENTITY_PREFERENCE: Record<string, number> = {
  active: 0,
  ready: 1,
  building: 2,
};

export class SemanticIndexService {
  private readonly repository: SemanticIndexRepository;
  private readonly source: SemanticSourcePort;
  private readonly embeddings: SemanticEmbeddingProvider;
  private readonly resolveSensitivity: SemanticSensitivityResolver;
  private readonly projectionVersion: number;
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly embeddingTimeoutMs: number | undefined;

  constructor(options: SemanticIndexServiceOptions) {
    this.repository = options.repository;
    this.source = options.source;
    this.embeddings = options.embeddings;
    this.resolveSensitivity = options.resolveSensitivity;
    this.projectionVersion = options.projectionVersion ?? SEMANTIC_PROJECTION_VERSION;
    this.now = options.now ?? (() => new Date().toISOString());
    this.newId = options.newId ?? (() => randomUUID());
    this.embeddingTimeoutMs = options.embeddingTimeoutMs;
  }

  // ─── Identity ───────────────────────────────────────────────────────

  /**
   * Returns the identity for the currently configured embedding route,
   * creating it when `create` is set and the dimension count can be learned.
   *
   * The probe request carries a fixed constant string and no user content, so
   * it runs at the routing policy's natural tier for the embedding feature; no
   * document is ever embedded on the strength of that tier — each document is
   * gated by its own sensitivity at embed time.
   */
  async ensureIdentity(
    options: { create?: boolean; signal?: AbortSignal } = {},
  ): Promise<SemanticIdentityResolution> {
    const route = await this.embeddings.resolveRoute('standard');
    if (route.status !== 'ok') {
      return { status: 'unavailable', reason: route.reason };
    }

    const identities = await this.repository.listIdentities();
    const matches = identities
      .filter((identity) => identity.provider === route.route.provider
        && identity.model === route.route.model
        && identity.projectionVersion === this.projectionVersion
        && isWritable(identity))
      .sort((a, b) => (IDENTITY_PREFERENCE[a.status] ?? 9) - (IDENTITY_PREFERENCE[b.status] ?? 9));

    if (matches.length > 0) {
      return { status: 'ready', identity: matches[0], created: false };
    }
    if (options.create !== true) {
      return { status: 'unavailable', reason: 'identity-not-created' };
    }

    const probe = await this.embeddings.embed({
      text: DIMENSION_PROBE_TEXT,
      sensitivity: 'standard',
      signal: options.signal,
      timeoutMs: this.embeddingTimeoutMs,
    });
    if (probe.status !== 'ok') {
      return { status: 'unavailable', reason: `dimension-probe-${probe.reason}` };
    }
    if (probe.provider !== route.route.provider || probe.model !== route.route.model) {
      // The route moved between resolution and the probe; creating an identity
      // now would name a space the next request may not use.
      return { status: 'unavailable', reason: 'dimension-probe-route-mismatch' };
    }

    const now = this.now();
    const identity = await this.repository.createIdentity({
      id: this.newId(),
      provider: probe.provider,
      model: probe.model,
      dimensions: probe.dimensions,
      projectionVersion: this.projectionVersion,
      now,
    });
    semanticIndexLogger.info({
      event: 'semantic_identity_created',
      indexId: identity.id,
      provider: identity.provider,
      model: identity.model,
      dimensions: identity.dimensions,
      projectionVersion: identity.projectionVersion,
    }, 'Semantic index identity created');
    return { status: 'ready', identity, created: true };
  }

  /**
   * True when `identity` names the vector space the *current* configuration
   * resolves to.
   *
   * Cutover consults this rather than trusting the identity it was handed: an
   * identity built for a since-changed model must never displace the one that
   * is serving, because the query embedding is produced by the live route and
   * would not be comparable to those vectors.
   */
  async matchesConfiguredRoute(identity: SemanticIndexIdentity): Promise<boolean> {
    const route = await this.embeddings.resolveRoute('standard');
    return route.status === 'ok'
      && identity.provider === route.route.provider
      && identity.model === route.route.model
      && identity.projectionVersion === this.projectionVersion;
  }

  // ─── Publishing ─────────────────────────────────────────────────────

  /**
   * The coalescing key for an entity. Deliberately **kind-free**: an upsert and
   * a later delete for the same entity collapse into one queued row whose
   * `kind` is whichever arrived last, so the queue can never hold contradictory
   * pending work for one entity.
   */
  static idempotencyKey(
    indexId: string,
    entityType: SemanticEntityType,
    entityId: string,
  ): string {
    return `${indexId}\u0000${entityType}\u0000${entityId}`;
  }

  /**
   * Publishes an intent after an authoritative write. Returns `skipped` (never
   * throws) when there is no index identity yet, because a domain write must
   * not fail just because the index is not provisioned; reconciliation and
   * backfill pick those entities up later.
   */
  async publish(input: {
    kind: SemanticIntentKind;
    entityType: SemanticSourceEntityType;
    entityId: string;
    indexId?: string;
    requestedAt?: string;
  }): Promise<SemanticPublishResult> {
    let indexId = input.indexId;
    if (!indexId) {
      const resolved = await this.ensureIdentity();
      if (resolved.status !== 'ready') {
        return { status: 'skipped', reason: resolved.reason };
      }
      indexId = resolved.identity.id;
    }

    const now = this.now();
    const result = await this.repository.enqueueIntent({
      id: this.newId(),
      idempotencyKey: SemanticIndexService.idempotencyKey(
        indexId, input.entityType, input.entityId,
      ),
      indexId,
      kind: input.kind,
      entityType: input.entityType,
      entityId: input.entityId,
      requestedAt: input.requestedAt ?? now,
      now,
    });
    return { status: 'published', reason: result.status, intentId: result.intent.id };
  }

  publishUpsert(input: {
    entityType: SemanticSourceEntityType;
    entityId: string;
    indexId?: string;
    requestedAt?: string;
  }): Promise<SemanticPublishResult> {
    return this.publish({ ...input, kind: 'upsert' });
  }

  publishDelete(input: {
    entityType: SemanticSourceEntityType;
    entityId: string;
    indexId?: string;
    requestedAt?: string;
  }): Promise<SemanticPublishResult> {
    return this.publish({ ...input, kind: 'delete' });
  }

  // ─── Intent execution ───────────────────────────────────────────────

  /**
   * Executes one leased intent and records its terminal (or retry) state.
   *
   * The lease owner is passed explicitly and every write is guarded by it, so a
   * worker whose lease has already been recovered by another worker records
   * nothing at all (`lease-lost`) instead of clobbering the new owner's work.
   */
  async processIntent(
    intent: SemanticIntent,
    context: { owner: string; runId?: string | null; signal?: AbortSignal },
  ): Promise<SemanticIntentOutcome> {
    try {
      const outcome = await this.executeIntent(intent, context);
      return await this.recordOutcome(intent, context.owner, outcome);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      semanticIndexLogger.error({
        event: 'semantic_intent_failed',
        intentId: intent.id,
        indexId: intent.indexId,
        entityType: intent.entityType,
        kind: intent.kind,
        err: error,
      }, 'Semantic intent processing threw');
      return this.recordOutcome(intent, context.owner, {
        status: 'retry',
        outcome: `error:${message.slice(0, 200)}`,
      });
    }
  }

  private async recordOutcome(
    intent: SemanticIntent,
    owner: string,
    outcome: SemanticIntentOutcome,
  ): Promise<SemanticIntentOutcome> {
    const now = this.now();
    if (outcome.status === 'succeeded') {
      const recorded = await this.repository.completeIntent({
        id: intent.id, owner, attempt: intent.attempt, now, outcome: outcome.outcome,
      });
      return recorded ? outcome : { status: 'lease-lost', outcome: 'lease-lost' };
    }

    const recorded = await this.repository.failIntent({
      id: intent.id,
      owner,
      attempt: intent.attempt,
      error: outcome.outcome,
      now,
      denied: outcome.status === 'denied',
      terminal: outcome.status === 'failed',
      // An abort is not the intent's fault: make it immediately reclaimable so
      // the next worker pass picks it up rather than waiting out a backoff.
      retryAfter: outcome.status === 'aborted' ? now : outcome.retryAfter ?? null,
    });
    return recorded === null ? { status: 'lease-lost', outcome: 'lease-lost' } : outcome;
  }

  private async executeIntent(
    intent: SemanticIntent,
    context: { owner: string; runId?: string | null; signal?: AbortSignal },
  ): Promise<SemanticIntentOutcome> {
    const leaseFence = {
      intentId: intent.id,
      owner: context.owner,
      attempt: intent.attempt,
    };
    if (!isSemanticSourceEntityType(intent.entityType)) {
      return { status: 'failed', outcome: `unsupported-entity-type:${intent.entityType}` };
    }
    const identity = await this.repository.getIdentity(intent.indexId);
    if (!identity) {
      return { status: 'failed', outcome: 'identity-missing' };
    }
    if (!isWritable(identity)) {
      return { status: 'failed', outcome: `identity-${identity.status}` };
    }
    if (context.signal?.aborted) {
      return { status: 'aborted', outcome: 'aborted' };
    }

    // Always reread: the intent is a *notification* that something changed, not
    // a carrier of the change. Whatever the source says now is what gets
    // indexed, which is what makes duplicate and out-of-order intents harmless.
    const source = await this.source.get(intent.entityType, intent.entityId);
    if (!source) {
      return this.applyDelete(intent, intent.entityType, context.owner);
    }
    if (intent.kind === 'delete') {
      // The entity exists again. The source is authoritative, so index it
      // rather than tombstoning a live entity on the strength of a stale
      // delete notification.
      semanticIndexLogger.debug({
        event: 'semantic_delete_superseded_by_source',
        intentId: intent.id,
        entityType: intent.entityType,
      }, 'Delete intent found a live source row; upserting instead');
    }

    const document = projectSource(source, {
      resolveSensitivity: this.resolveSensitivity,
      projectionVersion: identity.projectionVersion,
    });
    if (document.retainUntil && document.retainUntil <= this.now()) {
      return this.applyDelete(
        intent,
        intent.entityType,
        context.owner,
        document.sourceUpdatedAt,
      );
    }
    const requestedSourceUpdatedAt = document.sourceUpdatedAt > intent.requestedAt
      ? document.sourceUpdatedAt
      : intent.requestedAt;
    if (!source.semanticEligible) {
      return this.applyDelete(
        intent,
        intent.entityType,
        context.owner,
        requestedSourceUpdatedAt,
      );
    }
    const now = this.now();

    const existing = await this.repository.getDocument(
      identity.id, document.entityType, document.entityId,
    );
    const contentUnchanged = existing !== null
      && existing.deletedAt === null
      && existing.contentFingerprint === document.contentFingerprint
      && existing.sourceRevision === document.sourceRevision
      && existing.projectionVersion === document.projectionVersion
      && existing.sensitivity === document.sensitivity
      && existing.retainUntil === document.retainUntil;
    const write = await this.repository.upsertDocument({
      ...document,
      sourceUpdatedAt: contentUnchanged
        ? existing.sourceUpdatedAt
        : requestedSourceUpdatedAt,
      id: existing?.id ?? this.newId(),
      indexId: identity.id,
      now,
      leaseFence,
    });
    if (write.status === 'stale' && write.reason === 'lease-lost') {
      return { status: 'lease-lost', outcome: 'lease-lost' };
    }
    if (write.status === 'stale' || !write.document) {
      return { status: 'succeeded', outcome: `document-stale:${write.reason ?? 'unknown'}` };
    }
    const stored = write.document;

    const vector = await this.repository.getVector(
      identity.id, document.entityType, document.entityId,
    );
    const expiresAt = document.retainUntil ?? null;

    const compatible = vector !== null
      && vector.contentFingerprint === document.contentFingerprint
      && vector.projectionVersion === identity.projectionVersion
      && vector.provider === identity.provider
      && vector.model === identity.model
      && vector.dimensions === identity.dimensions
      && vector.embedding.length === identity.dimensions
      && vector.sensitivity === document.sensitivity;

    if (
      compatible
      && vector.documentVersion === stored.version
      && vector.sourceRevision === document.sourceRevision
      && vector.expiresAt === expiresAt
    ) {
      return { status: 'succeeded', outcome: 'unchanged' };
    }

    let embedding: Float32Array;
    let embeddedAt: string;
    let reused: boolean;

    if (compatible) {
      // Fingerprint skip: the projected content is byte-identical, so the
      // existing vector is rebound to the new document version instead of
      // paying for an identical embedding.
      embedding = vector.embedding;
      embeddedAt = vector.embeddedAt;
      reused = true;
    } else {
      if (context.signal?.aborted) {
        return { status: 'aborted', outcome: 'aborted' };
      }
      const connectorType = document.metadata.connectorType;
      const connectorTypes = document.metadata.connectorTypes;
      const result = await this.embeddings.embed({
        text: buildEmbeddingText(document),
        sensitivity: document.sensitivity,
        sources: typeof connectorTypes === 'string' && connectorTypes
          ? connectorTypes.split(',').filter(Boolean)
          : typeof connectorType === 'string' && connectorType
            ? [connectorType]
            : [],
        expect: {
          provider: identity.provider,
          model: identity.model,
          dimensions: identity.dimensions,
        },
        signal: context.signal,
        timeoutMs: this.embeddingTimeoutMs,
      });

      if (result.status !== 'ok') {
        switch (result.status) {
          case 'denied':
            return { status: 'denied', outcome: `embedding-denied:${result.reason}` };
          case 'failed':
            return { status: 'failed', outcome: `embedding-failed:${result.reason}` };
          case 'aborted':
            return { status: 'aborted', outcome: 'aborted' };
          default:
            return {
              status: 'retry',
              outcome: `embedding-${result.status}:${result.reason}`,
              retryAfter: result.retryAfter,
            };
        }
      }
      embedding = result.embedding;
      embeddedAt = this.now();
      reused = false;
    }

    const vectorWrite = await this.repository.upsertVector({
      id: vector?.id ?? this.newId(),
      indexId: identity.id,
      documentId: stored.id,
      documentVersion: stored.version,
      entityType: document.entityType,
      entityId: document.entityId,
      sourceRevision: document.sourceRevision,
      contentFingerprint: document.contentFingerprint,
      projectionVersion: identity.projectionVersion,
      provider: identity.provider,
      model: identity.model,
      dimensions: identity.dimensions,
      sensitivity: document.sensitivity,
      embedding,
      sourceUpdatedAt: document.sourceUpdatedAt,
      embeddedAt,
      indexRunId: context.runId ?? null,
      intentId: intent.id,
      expiresAt,
      now: this.now(),
      leaseFence,
    });

    if (vectorWrite.status === 'stale' && vectorWrite.reason === 'lease-lost') {
      return { status: 'lease-lost', outcome: 'lease-lost' };
    }
    if (vectorWrite.status === 'stale') {
      // A newer document version landed while this vector was being produced.
      // Dropping it is correct: the newer work owns the entity now.
      return { status: 'succeeded', outcome: `vector-stale:${vectorWrite.reason ?? 'unknown'}` };
    }
    return {
      status: 'succeeded',
      outcome: reused ? 'rebound' : 'embedded',
    };
  }

  private async applyDelete(
    intent: SemanticIntent,
    entityType: SemanticEntityType,
    owner: string,
    sourceUpdatedAt?: string,
  ): Promise<SemanticIntentOutcome> {
    const result = await this.repository.deleteDocument({
      indexId: intent.indexId,
      entityType,
      entityId: intent.entityId,
      now: this.now(),
      sourceUpdatedAt,
      leaseFence: {
        intentId: intent.id,
        owner,
        attempt: intent.attempt,
      },
    });
    return result.status === 'lease-lost'
      ? { status: 'lease-lost', outcome: 'lease-lost' }
      : { status: 'succeeded', outcome: result.status };
  }

  /** Rebuilds the projection for a source snapshot without writing anything. */
  project(
    source: SemanticSourceRecord,
    projectionVersion = this.projectionVersion,
  ): SemanticIndexDocument {
    return projectSource(source, {
      resolveSensitivity: this.resolveSensitivity,
      projectionVersion,
    });
  }

  /** Rebuilds the projection for one entity without writing anything. */
  async projectEntity(
    entityType: SemanticSourceEntityType,
    entityId: string,
    projectionVersion = this.projectionVersion,
  ): Promise<SemanticIndexDocument | null> {
    const source = await this.source.get(entityType, entityId);
    return source ? this.project(source, projectionVersion) : null;
  }

  /** Exposed so runs can report which tier a connector resolves to. */
  sensitivityFor(entityType: SemanticSourceEntityType, connectorType: string): SemanticSensitivity {
    return this.resolveSensitivity({ entityType, connectorType });
  }
}
