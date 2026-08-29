import { sqlite } from '@/db';
import type { ExternalBindingType } from '@/db/schema';
import type { GitHubStableResolution } from './stable-identity-types';
import { digestExternalIdentifier } from './service';
import type { ExternalIdentityEvidence } from './types';

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

interface LookupRow {
  candidateKey: string;
  externalEntityId: string | null;
  bindingLocalId: string | null;
  localId: string | null;
  bindingState: string | null;
  bindingRevision: string | null;
  locatorRevision: number | null;
  currentOwnerKey: string | null;
  currentRepositoryKey: string | null;
  currentIssueNumber: number | null;
  pathEntityId: string | null;
}

export function resolveGitHubStableIdentityBatch(
  connectorInstanceId: string,
  candidates: readonly GitHubStableLookupCandidate[],
): GitHubStableLookupResult {
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

  const valuesSql = withEvidence.map(() => '(?, ?, ?, ?, ?)').join(', ');
  const params: Array<string | number | null> = [];
  for (const candidate of withEvidence) {
    const observation = candidate.evidence!.entity;
    params.push(
      candidate.candidateKey,
      observation.identity.stableId,
      observation.locator.owner.toLowerCase(),
      observation.locator.repository.toLowerCase(),
      observation.locator.issueNumber ?? null,
    );
  }
  params.push(
    namespace.provider,
    namespace.hostKey,
    namespace.entityType,
    connectorInstanceId,
    namespace.bindingType,
    namespace.provider,
    namespace.hostKey,
  );

  const startedAt = performance.now();
  const rows = sqlite.prepare(`
    WITH incoming(candidate_key, stable_id, owner_key, repository_key, issue_number) AS (
      VALUES ${valuesSql}
    )
    SELECT
      incoming.candidate_key AS candidateKey,
      entity.id AS externalEntityId,
      binding.local_id AS bindingLocalId,
      CASE
        WHEN binding.binding_type = 'task' AND local_task.id IS NOT NULL
          THEN binding.local_id
        WHEN binding.binding_type = 'source_list' AND local_source_list.id IS NOT NULL
          THEN binding.local_id
        ELSE NULL
      END AS localId,
      binding.state AS bindingState,
      binding.verified_at AS bindingRevision,
      current_locator.locator_revision AS locatorRevision,
      current_locator.owner_key AS currentOwnerKey,
      current_locator.repository_key AS currentRepositoryKey,
      current_locator.issue_number AS currentIssueNumber,
      path_locator.external_entity_id AS pathEntityId
    FROM incoming
    LEFT JOIN external_entities AS entity
      ON entity.provider = ?
      AND entity.host_key = ?
      AND entity.entity_type = ?
      AND entity.stable_id = incoming.stable_id
    LEFT JOIN external_entity_bindings AS binding
      ON binding.external_entity_id = entity.id
      AND binding.connector_instance_id = ?
      AND binding.binding_type = ?
      AND binding.state != 'retired'
    LEFT JOIN tasks AS local_task
      ON binding.binding_type = 'task'
      AND local_task.id = binding.local_id
      AND local_task.connector_instance_id = binding.connector_instance_id
    LEFT JOIN source_lists AS local_source_list
      ON binding.binding_type = 'source_list'
      AND local_source_list.id = binding.local_id
      AND local_source_list.connector_instance_id = binding.connector_instance_id
    LEFT JOIN external_entity_locators AS current_locator
      ON current_locator.external_entity_id = entity.id
      AND current_locator.valid_to IS NULL
    LEFT JOIN external_entity_locators AS path_locator
      ON path_locator.provider = ?
      AND path_locator.host_key = ?
      AND path_locator.owner_key = incoming.owner_key
      AND path_locator.repository_key = incoming.repository_key
      AND path_locator.valid_to IS NULL
      AND (
        path_locator.issue_number = incoming.issue_number
        OR (path_locator.issue_number IS NULL AND incoming.issue_number IS NULL)
      )
    ORDER BY incoming.candidate_key COLLATE BINARY, binding.local_id COLLATE BINARY
  `).all(...params) as LookupRow[];
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
