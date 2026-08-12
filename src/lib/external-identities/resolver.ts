import type {
  GitHubIdentityBatchResolution,
  GitHubIdentityBatchResolutionInput,
  GitHubIdentityResolutionCandidate,
  GitHubIdentityResolutionDecision,
} from './comparison-types';

const MAX_BATCH_SIZE = 500;

function selectedId(ids: readonly string[]): string | null {
  const unique = [...new Set(ids)].sort();
  return unique.length === 1 ? unique[0] : null;
}

function decideOutcome(candidate: GitHubIdentityResolutionCandidate): Pick<
  GitHubIdentityResolutionDecision,
  'outcome' | 'reason'
> {
  const legacyIds = [...new Set(candidate.legacy.selectedLocalIds)];
  const stableIds = [...new Set(candidate.stable.selectedLocalIds)];
  if (candidate.stable.pathReused) {
    return { outcome: 'path_reuse', reason: 'locator_owned_by_other_entity' };
  }
  if (legacyIds.length > 1) {
    return { outcome: 'collision', reason: 'multiple_legacy_candidates' };
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
    return {
      outcome: legacyIds.length === 1 ? 'legacy_fallback' : 'missing_stable_id',
      reason: legacyIds.length === 1 ? 'legacy_only' : 'missing_stable_evidence',
    };
  }

  const legacyId = selectedId(legacyIds);
  const stableId = selectedId(stableIds);
  if (
    candidate.stable.locatorChanged
    && stableId !== null
    && (legacyId === null || legacyId === stableId)
  ) {
    return { outcome: 'locator_change', reason: 'current_locator_changed' };
  }
  if (legacyId !== stableId || candidate.legacy.action !== candidate.stable.action) {
    return { outcome: 'stable_legacy_disagree', reason: 'selected_ids_differ' };
  }
  return { outcome: 'agreement', reason: 'exact_match' };
}

function appliedDecision(
  mode: GitHubIdentityBatchResolutionInput['modeSnapshot']['effectiveMode'],
  outcome: GitHubIdentityResolutionDecision['outcome'],
  legacyId: string | null,
  stableId: string | null,
  candidate: GitHubIdentityResolutionCandidate,
): Pick<GitHubIdentityResolutionDecision, 'appliedSource' | 'selectedLocalId' | 'selectedAction'> {
  if (mode !== 'stable') {
    return {
      appliedSource: legacyId === null && candidate.legacy.selectedLocalIds.length > 1
        ? 'blocked'
        : 'legacy',
      selectedLocalId: legacyId,
      selectedAction: candidate.legacy.action,
    };
  }
  if (
    stableId !== null
    && candidate.stable.bindingState !== undefined
    && (
      candidate.stable.bindingState !== 'active'
      || !candidate.stable.bindingRevision
      || candidate.stable.locatorRevision === undefined
    )
  ) {
    return { appliedSource: 'blocked', selectedLocalId: null, selectedAction: 'none' };
  }
  if (outcome === 'agreement' || outcome === 'locator_change') {
    return {
      appliedSource: 'stable',
      selectedLocalId: stableId,
      selectedAction: candidate.stable.action,
    };
  }
  return { appliedSource: 'blocked', selectedLocalId: null, selectedAction: 'none' };
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
    if (seen.has(key)) throw new Error(`Duplicate GitHub identity candidate: ${candidate.candidateKey}`);
    seen.add(key);
    if (
      candidate.stable.stableIdDigest !== undefined
      && !/^[a-f0-9]{64}$/.test(candidate.stable.stableIdDigest)
    ) {
      throw new Error('GitHub identity candidates require a lowercase SHA-256 stable ID digest');
    }
    for (const value of [candidate.legacy.lookupMs ?? 0, candidate.stable.lookupMs ?? 0]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error('GitHub identity lookup durations must be non-negative integers');
      }
    }

    const legacyId = selectedId(candidate.legacy.selectedLocalIds);
    const stableId = selectedId(candidate.stable.selectedLocalIds);
    const result = decideOutcome(candidate);
    return Object.freeze({
      candidateKey: candidate.candidateKey,
      surface: candidate.surface,
      localTaskId: candidate.localTaskId ?? null,
      localSourceListId: candidate.localSourceListId ?? null,
      externalEntityId: candidate.stable.externalEntityId ?? null,
      legacySelectedLocalId: legacyId,
      stableSelectedLocalId: stableId,
      legacyAction: candidate.legacy.action,
      stableAction: candidate.stable.action,
      ...result,
      ...appliedDecision(
        input.modeSnapshot.effectiveMode,
        result.outcome,
        legacyId,
        stableId,
        candidate,
      ),
      stableIdDigest: candidate.stable.stableIdDigest ?? null,
      locatorRevision: candidate.stable.locatorRevision ?? null,
      bindingRevision: candidate.stable.bindingRevision ?? null,
      legacyLookupMs: candidate.legacy.lookupMs ?? 0,
      stableLookupMs: candidate.stable.lookupMs ?? 0,
    } satisfies GitHubIdentityResolutionDecision);
  });
  const outcomeCounts: Partial<Record<GitHubIdentityResolutionDecision['outcome'], number>> = {};
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
