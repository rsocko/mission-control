import type {
  GitHubIdentityBatchResolution,
  GitHubIdentityBatchResolutionInput,
  GitHubIdentityOutcome,
  GitHubIdentityReason,
  GitHubIdentityResolutionCandidate,
  GitHubIdentityResolutionDecision,
} from './stable-identity-types';

const MAX_BATCH_SIZE = 500;

function selectedId(ids: readonly string[]): string | null {
  const unique = [...new Set(ids)].sort();
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Decides one candidate from NodeID evidence alone. Locator matches never
 * select a row; they only prove that a local row exists whose NodeID binding is
 * missing or contradictory, which must block instead of silently duplicating.
 */
function decideOutcome(
  candidate: GitHubIdentityResolutionCandidate,
): { outcome: GitHubIdentityOutcome; reason: GitHubIdentityReason } {
  const stableIds = [...new Set(candidate.stable.selectedLocalIds)];
  const locatorIds = [...new Set(candidate.locatorMatchedLocalIds ?? [])];
  if (candidate.stable.pathReused) {
    return { outcome: 'path_reuse', reason: 'locator_owned_by_other_entity' };
  }
  if (candidate.stable.evidence === 'collision' || stableIds.length > 1) {
    return { outcome: 'collision', reason: 'multiple_stable_bindings' };
  }
  if (candidate.stable.evidence === 'inaccessible') {
    return { outcome: 'inaccessible', reason: 'access_denied' };
  }
  if (candidate.stable.evidence === 'partial') {
    return { outcome: 'partial_fetch', reason: 'fetch_incomplete' };
  }
  if (candidate.stable.evidence === 'missing') {
    return { outcome: 'missing_stable_id', reason: 'missing_stable_evidence' };
  }
  if (locatorIds.length > 1) {
    return { outcome: 'collision', reason: 'multiple_locator_matches' };
  }
  if (stableIds.length === 0 && locatorIds.length === 1) {
    return { outcome: 'unbound_local_row', reason: 'local_row_missing_stable_binding' };
  }
  if (candidate.stable.locatorChanged && stableIds.length === 1) {
    return { outcome: 'locator_change', reason: 'current_locator_changed' };
  }
  return { outcome: 'resolved', reason: 'stable_binding_match' };
}

function appliedDecision(
  outcome: GitHubIdentityOutcome,
  stableId: string | null,
  candidate: GitHubIdentityResolutionCandidate,
): Pick<
  GitHubIdentityResolutionDecision,
  'appliedSource' | 'selectedLocalId' | 'selectedAction' | 'reason'
> | null {
  if (outcome !== 'resolved' && outcome !== 'locator_change') return null;
  if (
    stableId !== null
    && candidate.stable.bindingState !== undefined
    && (
      candidate.stable.bindingState !== 'active'
      || !candidate.stable.bindingRevision
      || candidate.stable.locatorRevision === undefined
    )
  ) {
    return {
      appliedSource: 'blocked',
      selectedLocalId: null,
      selectedAction: 'none',
      reason: 'binding_not_active',
    };
  }
  return {
    appliedSource: 'stable',
    selectedLocalId: stableId,
    selectedAction: candidate.stable.action,
    reason: outcome === 'locator_change'
      ? 'current_locator_changed'
      : 'stable_binding_match',
  };
}

export function resolveGitHubIdentityBatch(
  input: GitHubIdentityBatchResolutionInput,
): GitHubIdentityBatchResolution {
  if (input.candidates.length > MAX_BATCH_SIZE) {
    throw new Error(`GitHub identity resolution batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }
  const seen = new Set<string>();
  const candidates = [...input.candidates].sort((left, right) =>
    left.surface.localeCompare(right.surface)
      || left.candidateKey.localeCompare(right.candidateKey));
  const decisions = candidates.map((candidate) => {
    const key = `${candidate.surface}\0${candidate.candidateKey}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate GitHub identity candidate: ${candidate.candidateKey}`);
    }
    seen.add(key);
    if (
      candidate.stable.stableIdDigest !== undefined
      && !/^[a-f0-9]{64}$/.test(candidate.stable.stableIdDigest)
    ) {
      throw new Error('GitHub identity candidates require a lowercase SHA-256 stable ID digest');
    }
    const lookupMs = candidate.stable.lookupMs ?? 0;
    if (!Number.isSafeInteger(lookupMs) || lookupMs < 0) {
      throw new Error('GitHub identity lookup durations must be non-negative integers');
    }

    const stableId = selectedId(candidate.stable.selectedLocalIds);
    const locatorId = selectedId(candidate.locatorMatchedLocalIds ?? []);
    const result = decideOutcome(candidate);
    const applied = appliedDecision(result.outcome, stableId, candidate) ?? {
      appliedSource: 'blocked' as const,
      selectedLocalId: null,
      selectedAction: 'none' as const,
      reason: result.reason,
    };
    return Object.freeze({
      candidateKey: candidate.candidateKey,
      surface: candidate.surface,
      localTaskId: candidate.localTaskId ?? null,
      localSourceListId: candidate.localSourceListId ?? null,
      externalEntityId: candidate.stable.externalEntityId ?? null,
      outcome: result.outcome,
      ...applied,
      locatorMatchSuperseded: applied.appliedSource === 'stable'
        && locatorId !== null
        && locatorId !== stableId,
      stableIdDigest: candidate.stable.stableIdDigest ?? null,
      locatorRevision: candidate.stable.locatorRevision ?? null,
      bindingRevision: candidate.stable.bindingRevision ?? null,
      lookupMs,
    } satisfies GitHubIdentityResolutionDecision);
  });
  const outcomeCounts: Partial<Record<GitHubIdentityOutcome, number>> = {};
  for (const decision of decisions) {
    outcomeCounts[decision.outcome] = (outcomeCounts[decision.outcome] ?? 0) + 1;
  }
  return Object.freeze({
    modeSnapshot: input.modeSnapshot,
    decisions: Object.freeze(decisions),
    outcomeCounts: Object.freeze(outcomeCounts),
  });
}

export function createGitHubIdentityCacheGeneration(
  snapshot: Pick<
    GitHubIdentityBatchResolutionInput['modeSnapshot'],
    'connectorInstanceId' | 'effectiveMode' | 'modeRevision'
  >,
): string {
  return `${snapshot.connectorInstanceId}:${snapshot.effectiveMode}:${snapshot.modeRevision}`;
}
