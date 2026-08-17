import { sqlite } from '@/db';
import type { ExternalBindingType } from '@/db/schema';
import { syncLogger } from '@/lib/logger';
import type {
  GitHubIdentityAction,
  GitHubIdentityModeSnapshot,
  GitHubIdentityResolutionCandidate,
  GitHubIdentityResolutionDecision,
  GitHubIdentitySurface,
  GitHubStableResolution,
} from './stable-identity-types';
import { resolveGitHubStableIdentityBatch } from './stable-lookup';
import type { ExternalIdentityEvidence } from './types';
import { resolveGitHubIdentityBatch } from './resolver';
import { getGitHubIdentityModeSnapshot } from './identity-mode';
import {
  resolveGitHubLinkedSourceIdentityBatch,
  type GitHubLinkedSourceIdentityCandidate,
} from './linked-source-identity';

const LOOKUP_CHUNK_SIZE = 500;

export interface GitHubStableIdentityCandidate {
  candidateKey: string;
  /**
   * Local rows the caller matched through the mutable locator (`source_id`).
   * Used only as a safety guard — never as an identity fallback.
   */
  locatorMatchedLocalIds?: readonly string[];
  /** Action to apply when the NodeID binding resolves to a local row. */
  boundAction?: GitHubIdentityAction;
  /** Action to apply when the NodeID resolves to no local row. */
  unboundAction?: GitHubIdentityAction;
  applicableStableLocalIds?: ReadonlySet<string>;
  evidence?: ExternalIdentityEvidence;
  localTaskId?: string;
  localSourceListId?: string;
}

export interface GitHubStableResolvedCandidate {
  candidateKey: string;
  locatorMatchedLocalIds?: readonly string[];
  localTaskId?: string;
  localSourceListId?: string;
  stable: GitHubStableResolution;
}

export interface GitHubStableIdentityRuntimeOptions {
  connectorInstanceId: string;
  jobId?: string;
  modeSnapshot: GitHubIdentityModeSnapshot;
  syncKind: 'full' | 'incremental';
}

/**
 * Resolves GitHub NodeID bindings for one sync or write scope.
 *
 * The runtime is deliberately evidence-free: it creates no comparison run, no
 * comparison record, and no sub-issue population row. It only resolves
 * `external_entity_bindings` through `external_entities.stable_id`, fences
 * applied decisions against the current binding and locator revisions, and
 * blocks callers when NodeID evidence is missing or unverified.
 */
export class GitHubStableIdentityRuntime {
  readonly modeSnapshot: GitHubIdentityModeSnapshot;
  readonly syncKind: 'full' | 'incremental';
  private readonly connectorInstanceId: string;
  private readonly jobId?: string;
  private readonly resolvedStableLocalIds = new Set<string>();
  private readonly blockedReasons = new Set<string>();
  private pageCount = 0;
  private queryCount = 0;
  private completed = false;

  constructor(options: GitHubStableIdentityRuntimeOptions) {
    if (options.modeSnapshot.connectorInstanceId !== options.connectorInstanceId) {
      throw new Error('GitHub identity mode snapshot belongs to another connector');
    }
    this.connectorInstanceId = options.connectorInstanceId;
    this.jobId = options.jobId;
    this.modeSnapshot = options.modeSnapshot;
    this.syncKind = options.syncKind;
  }

  markNetworkPage(): void {
    this.assertRunning();
    this.pageCount++;
  }

  /** Fails closed when the connector identity epoch moved under a running scope. */
  assertCurrentMode(): void {
    this.assertRunning();
    const current = getGitHubIdentityModeSnapshot(this.connectorInstanceId);
    if (current.modeRevision !== this.modeSnapshot.modeRevision) {
      throw new Error('GitHub identity runtime revision is stale');
    }
  }

  /**
   * Re-reads the binding and locator revisions behind every applied decision so
   * a concurrent rename, transfer, or rebind cannot be written through a stale
   * resolution.
   */
  assertDecisionsCurrent(
    decisions: Iterable<GitHubIdentityResolutionDecision>,
  ): void {
    this.assertCurrentMode();
    for (const decision of decisions) {
      if (
        decision.appliedSource !== 'stable'
        || !decision.selectedLocalId
        || !decision.externalEntityId
        || !decision.bindingRevision
        || decision.locatorRevision === null
      ) continue;
      const bindingType = decision.surface === 'source_list' ? 'source_list' : 'task';
      const current = sqlite.prepare(`
        SELECT 1
        FROM external_entity_bindings AS binding
        INNER JOIN external_entity_locators AS locator
          ON locator.external_entity_id = binding.external_entity_id
          AND locator.valid_to IS NULL
        WHERE binding.connector_instance_id = ?
          AND binding.binding_type = ?
          AND binding.local_id = ?
          AND binding.external_entity_id = ?
          AND binding.state = 'active'
          AND binding.verified_at = ?
          AND locator.locator_revision = ?
        LIMIT 1
      `).get(
        this.connectorInstanceId,
        bindingType,
        decision.selectedLocalId,
        decision.externalEntityId,
        decision.bindingRevision,
        decision.locatorRevision,
      );
      if (!current) throw new Error('GitHub stable decision binding or locator is stale');
    }
  }

  hasResolvedStableLocalId(localId: string): boolean {
    return this.resolvedStableLocalIds.has(localId);
  }

  /**
   * Records that a surface could not be resolved from NodeID evidence. The code
   * is bounded so it is safe to log; nothing durable is written.
   */
  markBlocked(reasonCode: string): void {
    this.assertRunning();
    if (!/^[a-z0-9_]{3,100}$/.test(reasonCode)) {
      throw new Error('GitHub identity block reason must be a bounded machine code');
    }
    this.blockedReasons.add(reasonCode);
  }

  get blockedReasonCodes(): readonly string[] {
    return [...this.blockedReasons].sort();
  }

  resolveBatch(
    surface: GitHubIdentitySurface,
    bindingType: ExternalBindingType,
    candidates: readonly GitHubStableIdentityCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const lookup = resolveGitHubStableIdentityBatch(
      this.connectorInstanceId,
      candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        bindingType,
        evidence: candidate.evidence,
        applicableLocalIds: candidate.applicableStableLocalIds,
      })),
    );
    this.queryCount += lookup.queryCount;
    return this.applyDecisions(surface, candidates.map((candidate) => {
      const stable = lookup.resolutions.get(candidate.candidateKey);
      if (!stable) throw new Error(`Stable resolution is missing for ${candidate.candidateKey}`);
      return toResolvedCandidate(candidate, stable);
    }));
  }

  /**
   * Resolves candidates that may repeat the same NodeID so the lookup runs once
   * per distinct entity. Duplicate candidate keys and conflicting local scopes
   * are rejected rather than silently merged.
   */
  resolveDeduplicatedBatch(
    surface: GitHubIdentitySurface,
    bindingType: ExternalBindingType,
    candidates: readonly GitHubStableIdentityCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const seenCandidates = new Set<string>();
    const representativeByLookupKey = new Map<string, GitHubStableIdentityCandidate>();
    for (const candidate of candidates) {
      if (seenCandidates.has(candidate.candidateKey)) {
        throw new Error(`Duplicate GitHub identity candidate: ${candidate.candidateKey}`);
      }
      seenCandidates.add(candidate.candidateKey);
      if (candidate.evidence) {
        const lookupKey = stableLookupDedupKey(bindingType, candidate.evidence);
        const representative = representativeByLookupKey.get(lookupKey);
        if (
          representative
          && !sameLocalIdScope(
            representative.applicableStableLocalIds,
            candidate.applicableStableLocalIds,
          )
        ) {
          throw new Error(
            `Deduplicated GitHub identity candidates have different local ID scopes: ${
              candidate.candidateKey
            }`,
          );
        }
        if (!representative) representativeByLookupKey.set(lookupKey, candidate);
      }
    }

    const stableByLookupKey = new Map<string, GitHubStableResolution>();
    const representatives = [...representativeByLookupKey.entries()];
    for (let index = 0; index < representatives.length; index += LOOKUP_CHUNK_SIZE) {
      const chunk = representatives.slice(index, index + LOOKUP_CHUNK_SIZE);
      const lookup = resolveGitHubStableIdentityBatch(
        this.connectorInstanceId,
        chunk.map(([lookupKey, candidate]) => ({
          candidateKey: lookupKey,
          bindingType,
          evidence: candidate.evidence,
          applicableLocalIds: candidate.applicableStableLocalIds,
        })),
      );
      this.queryCount += lookup.queryCount;
      for (const [lookupKey] of chunk) {
        const stable = lookup.resolutions.get(lookupKey);
        if (!stable) throw new Error(`Stable resolution is missing for ${lookupKey}`);
        stableByLookupKey.set(lookupKey, stable);
      }
    }

    const decisions: GitHubIdentityResolutionDecision[] = [];
    for (let index = 0; index < candidates.length; index += LOOKUP_CHUNK_SIZE) {
      const chunk = candidates.slice(index, index + LOOKUP_CHUNK_SIZE);
      decisions.push(...this.applyDecisions(surface, chunk.map((candidate) => {
        const stable = candidate.evidence
          ? stableByLookupKey.get(stableLookupDedupKey(bindingType, candidate.evidence))
          : { selectedLocalIds: [], action: 'none' as const, evidence: 'missing' as const };
        if (!stable) {
          throw new Error(`Stable resolution is missing for ${candidate.candidateKey}`);
        }
        return toResolvedCandidate(candidate, stable);
      })));
    }
    return decisions;
  }

  /** Applies candidates whose NodeID evidence the caller already resolved. */
  applyResolvedBatch(
    surface: GitHubIdentitySurface,
    candidates: readonly GitHubStableResolvedCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    return this.applyDecisions(surface, candidates);
  }

  resolveLinkedSourceBatch(
    candidates: readonly GitHubLinkedSourceIdentityCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertRunning();
    if (candidates.length === 0) return [];
    const lookup = resolveGitHubLinkedSourceIdentityBatch(
      this.connectorInstanceId,
      candidates,
    );
    this.queryCount += lookup.queryCount;
    const decisions = this.applyDecisions('linked_source', candidates.map((candidate) => {
      const stable = lookup.resolutions.get(candidate.candidateKey);
      if (!stable) {
        throw new Error(`Stable linked-source resolution is missing for ${candidate.candidateKey}`);
      }
      return {
        candidateKey: candidate.candidateKey,
        locatorMatchedLocalIds: [candidate.taskId],
        localTaskId: candidate.taskId,
        stable,
      };
    }));
    for (const decision of decisions) {
      if (decision.appliedSource !== 'stable') {
        this.markBlocked(`linked_source_${decision.outcome}`);
      }
    }
    return decisions;
  }

  /**
   * Closes the runtime scope. Nothing durable is written; the summary is logged
   * so a blocked sync is visible without an evidence table.
   */
  complete(state: 'succeeded' | 'failed' | 'cancelled', errorCode?: string): void {
    if (this.completed) return;
    this.completed = true;
    const blocked = this.blockedReasonCodes;
    if (state === 'succeeded' && blocked.length === 0) return;
    syncLogger.warn({
      connectorId: this.connectorInstanceId,
      jobId: this.jobId,
      syncKind: this.syncKind,
      modeRevision: this.modeSnapshot.modeRevision,
      pageCount: this.pageCount,
      queryCount: this.queryCount,
      state,
      errorCode: errorCode ?? blocked[0] ?? null,
      blockedReasonCodes: blocked.slice(0, 20),
    }, 'GitHub stable identity scope closed with blocked surfaces');
  }

  private applyDecisions(
    surface: GitHubIdentitySurface,
    candidates: readonly GitHubStableResolvedCandidate[],
  ): readonly GitHubIdentityResolutionDecision[] {
    this.assertCurrentMode();
    const result = resolveGitHubIdentityBatch({
      modeSnapshot: this.modeSnapshot,
      candidates: candidates.map((candidate) => ({
        candidateKey: candidate.candidateKey,
        surface,
        localTaskId: candidate.localTaskId,
        localSourceListId: candidate.localSourceListId,
        locatorMatchedLocalIds: candidate.locatorMatchedLocalIds,
        stable: candidate.stable,
      } satisfies GitHubIdentityResolutionCandidate)),
    });
    for (const decision of result.decisions) {
      if (decision.appliedSource === 'stable' && decision.selectedLocalId) {
        this.resolvedStableLocalIds.add(decision.selectedLocalId);
      }
    }
    return result.decisions;
  }

  private assertRunning(): void {
    if (this.completed) throw new Error('GitHub stable identity runtime is already complete');
  }
}

function toResolvedCandidate(
  candidate: GitHubStableIdentityCandidate,
  stable: GitHubStableResolution,
): GitHubStableResolvedCandidate {
  return {
    candidateKey: candidate.candidateKey,
    locatorMatchedLocalIds: candidate.locatorMatchedLocalIds,
    localTaskId: candidate.localTaskId,
    localSourceListId: candidate.localSourceListId,
    stable: {
      ...stable,
      action: stable.selectedLocalIds.length > 0
        ? candidate.boundAction ?? 'update'
        : candidate.unboundAction ?? 'create',
    },
  };
}

function stableLookupDedupKey(
  bindingType: ExternalBindingType,
  evidence: ExternalIdentityEvidence,
): string {
  const { identity, locator } = evidence.entity;
  return JSON.stringify([
    bindingType,
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
    locator.owner.toLowerCase(),
    locator.repository.toLowerCase(),
    locator.issueNumber ?? null,
  ]);
}

function sameLocalIdScope(
  left: ReadonlySet<string> | undefined,
  right: ReadonlySet<string> | undefined,
): boolean {
  if (left === right) return true;
  if (!left || !right || left.size !== right.size) return false;
  return [...left].every((localId) => right.has(localId));
}
