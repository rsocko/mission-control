import type {
  GitHubLinkedSourceLookupInputRow,

  GitHubLinkedSourcePersistWrite,
} from '@/db/persistence/github-identity';
import { digestExternalIdentifier } from './identifier-digest';
import type {
  GitHubIdentityModeSnapshot,
  GitHubStableResolution,
} from './stable-identity-types';
import type { ExternalIdentityEvidence } from './types';
import { getGitHubIdentityRepository } from './worker-persistence';

const MAX_BATCH_SIZE = 500;

export type GitHubLinkedSourceEvidenceState =
  | 'verified'
  | 'missing'
  | 'inaccessible'
  | 'partial';

export interface GitHubLinkedSourceIdentityCandidate {
  candidateKey: string;
  linkedSourceId: string;
  taskId: string;
  sourceId: string;
  evidence?: ExternalIdentityEvidence;
  evidenceState?: GitHubLinkedSourceEvidenceState;
}

export interface GitHubLinkedSourceIdentityWrite {
  linkedSourceId: string;
  sourceId: string;
  evidence?: ExternalIdentityEvidence;
}

export interface GitHubLinkedSourceIdentityWriteResult {
  linkedSourceId: string;
  state: 'associated' | 'collision' | 'unbound';
}


export async function persistGitHubLinkedSourceIdentityBatch(
  connectorInstanceId: string,
  writes: readonly GitHubLinkedSourceIdentityWrite[],
  modeSnapshot?: GitHubIdentityModeSnapshot,
): Promise<readonly GitHubLinkedSourceIdentityWriteResult[]> {
  assertBatchSize(writes.length);
  if (writes.length === 0) return [];
  if (
    modeSnapshot
    && modeSnapshot.connectorInstanceId !== connectorInstanceId
  ) {
    throw new Error('Linked-source identity writes do not match the frozen connector');
  }

  const normalized: GitHubLinkedSourcePersistWrite[] = writes.map((write) => {
    const evidence = write.evidence;
    const hasEvidence = evidence !== undefined;
    const identity = evidence?.entity.identity;
    const identityValid = Boolean(
      identity && identity.provider === 'github' && identity.entityType === 'issue',
    );
    // `canonicalLegacySourceId` validates the issue number and throws on invalid
    // GitHub issue evidence, mirroring the original in-transaction throw.
    const canonicalSourceId = hasEvidence && identityValid
      ? canonicalLegacySourceId(evidence!)
      : '';
    const locator = evidence?.entity.locator;
    return {
      linkedSourceId: write.linkedSourceId,
      hasEvidence,
      identityValid,
      provider: identity?.provider ?? '',
      hostKey: identity?.hostKey ?? '',
      entityType: identity?.entityType ?? '',
      stableId: identity?.stableId ?? '',
      ownerKey: locator?.owner.toLowerCase() ?? '',
      repositoryKey: locator?.repository.toLowerCase() ?? '',
      issueNumber: locator?.issueNumber ?? null,
      canonicalSourceId,
      observedAt: evidence?.entity.observedAt ?? '',
    };
  });

  const identity = await getGitHubIdentityRepository();
  const results = await identity.persistLinkedSourceIdentityBatch({
    connectorInstanceId,
    modeSnapshot,
    writes: normalized,
  });
  return results.map((result) => ({
    linkedSourceId: result.linkedSourceId,
    state: result.state,
  }));
}

export async function resolveGitHubLinkedSourceIdentityBatch(
  connectorInstanceId: string,
  candidates: readonly GitHubLinkedSourceIdentityCandidate[],
): Promise<{
  resolutions: ReadonlyMap<string, GitHubStableResolution>;
  lookupMs: number;
  queryCount: number;
}> {
  assertBatchSize(candidates.length);
  if (candidates.length === 0) {
    return { resolutions: new Map(), lookupMs: 0, queryCount: 0 };
  }
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (keys.has(candidate.candidateKey)) {
      throw new Error(`Duplicate GitHub linked-source candidate: ${candidate.candidateKey}`);
    }
    keys.add(candidate.candidateKey);
  }

  const namespaces = candidates
    .filter((candidate) => candidate.evidence)
    .map((candidate) => candidate.evidence!.entity.identity);
  if (namespaces.some((identity) => (
    identity.provider !== 'github'
    || identity.entityType !== 'issue'
    || identity.hostKey !== namespaces[0]?.hostKey
  ))) {
    throw new Error('GitHub linked-source lookup batches must share one host-scoped issue namespace');
  }

  const hostKey = namespaces[0]?.hostKey ?? '';
  const inputRows: GitHubLinkedSourceLookupInputRow[] = candidates.map((candidate) => {
    const observation = candidate.evidence?.entity;
    return {
      candidateKey: candidate.candidateKey,
      linkedSourceId: candidate.linkedSourceId,
      stableId: observation?.identity.stableId ?? null,
      ownerKey: observation?.locator.owner.toLowerCase() ?? null,
      repositoryKey: observation?.locator.repository.toLowerCase() ?? null,
      issueNumber: observation?.locator.issueNumber ?? null,
    };
  });

  const identity = await getGitHubIdentityRepository();
  const startedAt = performance.now();
  const rows = await identity.lookupLinkedSourceIdentityBatch({
    connectorInstanceId,
    hostKey,
    rows: inputRows,
  });
  const lookupMs = Math.max(0, Math.round(performance.now() - startedAt));
  const rowByKey = new Map(rows.map((row) => [row.candidateKey, row]));
  const resolutions = new Map<string, GitHubStableResolution>();

  for (const candidate of candidates) {
    const row = rowByKey.get(candidate.candidateKey);
    if (!row) throw new Error(`GitHub linked source disappeared: ${candidate.linkedSourceId}`);
    const evidenceState = candidate.evidenceState ?? (candidate.evidence ? 'verified' : 'missing');
    const stableEntityId = row.stableEntityId;
    const linkedEntityMismatch = stableEntityId !== null
      && row.linkedEntityId !== null
      && row.linkedEntityId !== stableEntityId;
    const linkedSourceMismatch = row.stableLinkedSourceId !== null
      && row.stableLinkedSourceId !== candidate.linkedSourceId;
    const collision = linkedEntityMismatch || linkedSourceMismatch;
    const safeInitialAssociation = stableEntityId !== null
      && row.linkedEntityId === null
      && row.stableLinkedSourceId === null
      && row.pathEntityId === stableEntityId;
    const selectedLocalIds = evidenceState === 'verified'
      ? (
          row.stableTaskId
            ? [row.stableTaskId]
            : safeInitialAssociation
              ? [row.linkedTaskId]
              : []
        )
      : (row.linkedEntityId && row.linkedTaskId ? [row.linkedTaskId] : []);
    const observation = candidate.evidence?.entity;
    const locatorChanged = Boolean(
      observation
      && row.currentOwnerKey !== null
      && (
        row.currentOwnerKey !== observation.locator.owner.toLowerCase()
        || row.currentRepositoryKey !== observation.locator.repository.toLowerCase()
        || row.currentIssueNumber !== (observation.locator.issueNumber ?? null)
      )
    );
    const pathReused = Boolean(
      stableEntityId
      && row.pathEntityId
      && row.pathEntityId !== stableEntityId
    );
    resolutions.set(candidate.candidateKey, {
      selectedLocalIds,
      action: selectedLocalIds.length > 0 ? 'present' : 'none',
      evidence: collision ? 'collision' : evidenceState,
      externalEntityId: stableEntityId ?? row.linkedEntityId ?? undefined,
      stableIdDigest: observation
        ? digestExternalIdentifier(observation.identity.stableId)
        : undefined,
      locatorRevision: row.locatorRevision ?? undefined,
      locatorChanged,
      pathReused,
      lookupMs,
    });
  }

  return { resolutions, lookupMs, queryCount: 1 };
}

function canonicalLegacySourceId(evidence: ExternalIdentityEvidence): string {
  const locator = evidence.entity.locator;
  if (!Number.isSafeInteger(locator.issueNumber) || (locator.issueNumber ?? 0) <= 0) {
    throw new Error('GitHub linked-source evidence requires a positive issue number');
  }
  return `${locator.owner}/${locator.repository}:${locator.issueNumber}`;
}

function assertBatchSize(size: number): void {
  if (size > MAX_BATCH_SIZE) {
    throw new Error(`GitHub linked-source batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }
}
