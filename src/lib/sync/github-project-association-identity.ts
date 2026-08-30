import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import type { GitHubStableIdentityRuntime } from '@/lib/external-identities/stable-identity-runtime';
import type { GitHubIdentityResolutionDecision } from '@/lib/external-identities/stable-identity-types';
import { digestExternalIdentifier } from '@/lib/external-identities/identifier-digest';
import type {
  GitHubProjectDecisionCheck,
  GitHubProjectIdentityFence,
} from '@/db/persistence/github-projects';

export interface GitHubProjectAssociationIdentityInput {
  project: { id: string; number: number };
  membershipState?: 'complete' | 'partial' | 'inaccessible';
  taskSourceIds: readonly string[];
  taskIdentityEvidence?: readonly {
    sourceId: string;
    evidence: ExternalIdentityEvidence;
  }[];
}

export interface GitHubProjectAssociationLocalTask {
  id: string;
  sourceId: string;
}

export interface GitHubProjectAssociationIdentityResult {
  decisions: readonly GitHubIdentityResolutionDecision[];
  stableProjectTaskIds: ReadonlyMap<number, ReadonlySet<string>>;
  blockedStableProjects: ReadonlySet<number>;
}

export async function resolveGitHubProjectAssociations(
  runtime: GitHubStableIdentityRuntime,
  associations: readonly GitHubProjectAssociationIdentityInput[],
  localTasks: readonly GitHubProjectAssociationLocalTask[],
): Promise<GitHubProjectAssociationIdentityResult> {
  assertUniqueGitHubProjectIdentities(associations);
  const localBySourceId = new Map(localTasks.map((task) => [task.sourceId, task.id]));
  const applicableStableLocalIds = new Set(localTasks.map((task) => task.id));
  const projectByCandidateKey = new Map<string, number>();
  const evidenceByStableIdentity = new Map<string, string>();
  const evidenceBySourceId = new Map<string, string>();
  const candidates = associations.flatMap((association) => {
    const associationEvidenceBySourceId = collectAssociationEvidence(
      association,
      evidenceByStableIdentity,
      evidenceBySourceId,
    );
    return [...new Set(association.taskSourceIds)].map((sourceId) => {
      const localId = localBySourceId.get(sourceId);
      const candidateKey = `project:${association.project.number}:${sourceId}`;
      projectByCandidateKey.set(candidateKey, association.project.number);
      return {
        candidateKey,
        locatorMatchedLocalIds: localId ? [localId] : [],
        boundAction: 'present' as const,
        unboundAction: 'none' as const,
        applicableStableLocalIds,
        evidence: associationEvidenceBySourceId.get(sourceId),
        localTaskId: localId,
      };
    });
  });
  const decisions = await runtime.resolveDeduplicatedBatch(
    'project_association',
    'task',
    candidates,
  );
  const stableProjectTaskIds = new Map<number, Set<string>>();
  const blockedStableProjects = new Set<number>();

  for (const decision of decisions) {
    const projectNumber = projectByCandidateKey.get(decision.candidateKey);
    if (projectNumber === undefined) {
      throw new Error(`GitHub project association decision has no project scope: ${
        decision.candidateKey
      }`);
    }
    if (decision.appliedSource !== 'stable' || !decision.selectedLocalId) {
      blockedStableProjects.add(projectNumber);
      continue;
    }
    const selected = stableProjectTaskIds.get(projectNumber) ?? new Set<string>();
    selected.add(decision.selectedLocalId);
    stableProjectTaskIds.set(projectNumber, selected);
  }

  return {
    decisions,
    stableProjectTaskIds,
    blockedStableProjects,
  };
}

export function assertUniqueGitHubProjectIdentities(
  associations: readonly { project: { id: string; number: number } }[],
): void {
  const stableIdByNumber = new Map<number, string>();
  const seenStableIds = new Set<string>();
  for (const association of associations) {
    const { id, number } = association.project;
    if (!id) {
      throw new Error(`GitHub Project ${number} has no stable identity`);
    }
    const existingStableId = stableIdByNumber.get(number);
    if (existingStableId !== undefined && existingStableId !== id) {
      throw new Error(`GitHub Project ${number} resolves to multiple stable identities`);
    }
    if (seenStableIds.has(id)) {
      throw new Error(`GitHub Project ${number} has multiple association rows`);
    }
    stableIdByNumber.set(number, id);
    seenStableIds.add(id);
  }
}

export function assertCompleteGitHubProjectAssociations(
  associations: readonly GitHubProjectAssociationIdentityInput[],
): void {
  const incomplete = associations.find(
    (association) => association.membershipState !== 'complete',
  );
  if (!incomplete) return;
  throw new Error(
    `GitHub Project ${incomplete.project.number} membership observation is ${
      incomplete.membershipState ?? 'unknown'
    }`,
  );
}

export function resolveGitHubProjectIdentityDigest(
  project: { id: string; number: number },
  existingDigest?: string,
): string {
  if (!project.id) {
    throw new Error(`GitHub Project ${project.number} has no stable identity`);
  }
  const digest = digestExternalIdentifier(project.id);
  if (existingDigest !== undefined && existingDigest !== digest) {
    throw new Error(
      `GitHub Project ${project.number} stable identity does not match its Hub Project`,
    );
  }
  return digest;
}

/**
 * Freezes the identity fence values for the project reconciliation port. It
 * mirrors `GitHubStableIdentityRuntime.assertDecisionsCurrent`'s check-building
 * so the project adapter can re-verify each stable decision's binding and
 * current locator revision with SQL *inside* its transaction, replacing the
 * async identity callback that previously ran outside the write.
 */
export function buildGitHubProjectIdentityFence(
  modeRevision: number,
  decisions: Iterable<GitHubIdentityResolutionDecision>,
): GitHubProjectIdentityFence {
  const checks: GitHubProjectDecisionCheck[] = [];
  for (const decision of decisions) {
    if (
      decision.appliedSource !== 'stable'
      || !decision.selectedLocalId
      || !decision.externalEntityId
      || !decision.bindingRevision
      || decision.locatorRevision === null
    ) continue;
    checks.push({
      bindingType: decision.surface === 'source_list' ? 'source_list' : 'task',
      localId: decision.selectedLocalId,
      externalEntityId: decision.externalEntityId,
      bindingRevision: decision.bindingRevision,
      locatorRevision: decision.locatorRevision,
    });
  }
  return { modeRevision, checks };
}

function collectAssociationEvidence(
  association: GitHubProjectAssociationIdentityInput,
  evidenceByStableIdentity: Map<string, string>,
  evidenceBySourceId: Map<string, string>,
): Map<string, ExternalIdentityEvidence> {
  const associationEvidenceBySourceId = new Map<string, ExternalIdentityEvidence>();
  for (const item of association.taskIdentityEvidence ?? []) {
    const stableIdentity = stableIdentityKey(item.evidence);
    const evidenceIdentity = evidenceIdentityKey(item.evidence);
    const priorIdentity = evidenceByStableIdentity.get(stableIdentity);
    const priorSourceIdentity = evidenceBySourceId.get(item.sourceId);
    const existing = associationEvidenceBySourceId.get(item.sourceId);
    if (
      (existing && evidenceIdentityKey(existing) !== evidenceIdentity)
      || (priorIdentity !== undefined && priorIdentity !== evidenceIdentity)
      || (priorSourceIdentity !== undefined && priorSourceIdentity !== evidenceIdentity)
    ) {
      throw new Error(
        `GitHub project association has conflicting stable evidence: ${
          association.project.number
        }:${item.sourceId}`,
      );
    }
    evidenceByStableIdentity.set(stableIdentity, evidenceIdentity);
    evidenceBySourceId.set(item.sourceId, evidenceIdentity);
    associationEvidenceBySourceId.set(item.sourceId, item.evidence);
  }
  return associationEvidenceBySourceId;
}

function stableIdentityKey(evidence: ExternalIdentityEvidence): string {
  const { identity } = evidence.entity;
  return JSON.stringify([
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
  ]);
}

function evidenceIdentityKey(evidence: ExternalIdentityEvidence): string {
  const { identity, locator } = evidence.entity;
  return JSON.stringify([
    identity.provider,
    identity.hostKey,
    identity.entityType,
    identity.stableId,
    locator.owner.toLowerCase(),
    locator.repository.toLowerCase(),
    locator.issueNumber ?? null,
    evidence.repository
      ? [
          evidence.repository.identity.provider,
          evidence.repository.identity.hostKey,
          evidence.repository.identity.entityType,
          evidence.repository.identity.stableId,
          evidence.repository.locator.owner.toLowerCase(),
          evidence.repository.locator.repository.toLowerCase(),
        ]
      : null,
  ]);
}
