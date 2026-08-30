import type { ExternalBindingType } from '@/db/schema';
import type {
  GitHubStableLookupInputRow,
  GitHubStableLookupRow,
} from '@/db/persistence/github-identity';
import type { GitHubStableResolution } from './stable-identity-types';
import { digestExternalIdentifier } from './identifier-digest';
import type { ExternalIdentityEvidence } from './types';
import { getGitHubIdentityRepository } from './worker-persistence';

const MAX_BATCH_SIZE = 500;

export interface GitHubStableLookupCandidate {
  candidateKey: string;
  bindingType: ExternalBindingType;
  evidence?: ExternalIdentityEvidence;
  applicableLocalIds?: ReadonlySet<string>;
}

export interface GitHubStableLookupResult {
  resolutions: ReadonlyMap<string, GitHubStableResolution>;
  lookupMs: number;
  queryCount: number;
}

type LookupRow = GitHubStableLookupRow;

export async function resolveGitHubStableIdentityBatch(
  connectorInstanceId: string,
  candidates: readonly GitHubStableLookupCandidate[],
): Promise<GitHubStableLookupResult> {
  if (candidates.length > MAX_BATCH_SIZE) {
    throw new Error(`GitHub stable lookup batch exceeds the maximum of ${MAX_BATCH_SIZE}`);
  }
  const resolutions = new Map<string, GitHubStableResolution>();
  const withEvidence = candidates.filter((candidate) => candidate.evidence !== undefined);
  for (const candidate of candidates) {
    if (resolutions.has(candidate.candidateKey)) {
      throw new Error(`Duplicate GitHub stable lookup candidate: ${candidate.candidateKey}`);
    }
    if (!candidate.evidence) {
      resolutions.set(candidate.candidateKey, {
        selectedLocalIds: [],
        action: 'none',
        evidence: 'missing',
      });
    }
  }
  if (withEvidence.length === 0) {
    return { resolutions, lookupMs: 0, queryCount: 0 };
  }

  const namespace = namespaceFor(withEvidence[0]);
  const stableIdentityCounts = new Map<string, number>();
  for (const candidate of withEvidence) {
    const stableId = candidate.evidence!.entity.identity.stableId;
    stableIdentityCounts.set(stableId, (stableIdentityCounts.get(stableId) ?? 0) + 1);
  }
  for (const candidate of withEvidence.slice(1)) {
    const current = namespaceFor(candidate);
    if (
      current.provider !== namespace.provider
      || current.hostKey !== namespace.hostKey
      || current.entityType !== namespace.entityType
      || current.bindingType !== namespace.bindingType
    ) {
      throw new Error('GitHub stable lookup batches must share one namespace and binding type');
    }
  }

  const inputRows: GitHubStableLookupInputRow[] = withEvidence.map((candidate) => {
    const observation = candidate.evidence!.entity;
    return {
      candidateKey: candidate.candidateKey,
      stableId: observation.identity.stableId,
      ownerKey: observation.locator.owner.toLowerCase(),
      repositoryKey: observation.locator.repository.toLowerCase(),
      issueNumber: observation.locator.issueNumber ?? null,
    };
  });

  const identity = await getGitHubIdentityRepository();
  const startedAt = performance.now();
  const rows = await identity.lookupStableIdentityBatch({
    connectorInstanceId,
    namespace,
    rows: inputRows,
  });
  const lookupMs = Math.max(0, Math.round(performance.now() - startedAt));

  const rowsByCandidate = new Map<string, LookupRow[]>();
  for (const row of rows) {
    const current = rowsByCandidate.get(row.candidateKey);
    if (current) current.push(row);
    else rowsByCandidate.set(row.candidateKey, [row]);
  }

  for (const candidate of withEvidence) {
    const observation = candidate.evidence!.entity;
    const candidateRows = rowsByCandidate.get(candidate.candidateKey) ?? [];
    const entityRow = candidateRows.find((row) => row.externalEntityId !== null);
    const selectedLocalIds = candidateRows
      .map((row) => candidate.applicableLocalIds === undefined
        ? row.localId
        : row.bindingLocalId && candidate.applicableLocalIds.has(row.bindingLocalId)
          ? row.bindingLocalId
          : null)
      .filter((localId): localId is string => localId !== null)
      .filter((localId, index, values) => values.indexOf(localId) === index)
      .sort();
    const hasCollision = candidateRows.some((row) => row.bindingState === 'collision')
      || selectedLocalIds.length > 1;
    const locatorChanged = entityRow?.currentOwnerKey !== null && (
      entityRow?.currentOwnerKey !== observation.locator.owner.toLowerCase()
      || entityRow.currentRepositoryKey !== observation.locator.repository.toLowerCase()
      || entityRow.currentIssueNumber !== (observation.locator.issueNumber ?? null)
    );
    const pathReused = candidateRows.some((row) =>
      row.pathEntityId !== null
      && (
        row.externalEntityId === null
        || row.pathEntityId !== row.externalEntityId
      ));
    if ((stableIdentityCounts.get(observation.identity.stableId) ?? 0) > 1) {
      resolutions.set(candidate.candidateKey, {
        selectedLocalIds,
        action: 'none',
        evidence: 'collision',
        externalEntityId: entityRow?.externalEntityId ?? undefined,
        stableIdDigest: digestExternalIdentifier(observation.identity.stableId),
        locatorRevision: entityRow?.locatorRevision ?? undefined,
        bindingRevision: entityRow?.bindingRevision ?? undefined,
        bindingState: entityRow?.bindingState as
          | 'shadow'
          | 'active'
          | 'collision'
          | 'retired'
          | undefined,
        lookupMs,
      });
      continue;
    }
    resolutions.set(candidate.candidateKey, {
      selectedLocalIds,
      action: selectedLocalIds.length === 0 ? 'create' : 'update',
      evidence: hasCollision ? 'collision' : 'verified',
      externalEntityId: entityRow?.externalEntityId ?? undefined,
      stableIdDigest: digestExternalIdentifier(observation.identity.stableId),
      locatorRevision: entityRow?.locatorRevision ?? undefined,
      bindingRevision: entityRow?.bindingRevision ?? undefined,
      bindingState: entityRow?.bindingState as
        | 'shadow'
        | 'active'
        | 'collision'
        | 'retired'
        | undefined,
      locatorChanged,
      pathReused,
      lookupMs,
    });
  }

  return { resolutions, lookupMs, queryCount: 1 };
}

function namespaceFor(candidate: GitHubStableLookupCandidate): {
  provider: string;
  hostKey: string;
  entityType: string;
  bindingType: ExternalBindingType;
} {
  const identity = candidate.evidence!.entity.identity;
  return {
    provider: identity.provider,
    hostKey: identity.hostKey,
    entityType: identity.entityType,
    bindingType: candidate.bindingType,
  };
}
