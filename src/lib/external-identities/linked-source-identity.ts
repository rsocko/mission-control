import { and, eq, inArray, isNull } from 'drizzle-orm';
import { runTransaction, sqlite } from '@/db';
import {
  externalEntities,
  externalEntityLocators,
  taskLinkedSourceEntities,
  taskLinkedSources,
} from '@/db/schema';
import { digestExternalIdentifier } from './service';
import { assertGitHubIdentityModeSnapshotInTransaction } from './identity-mode';
import type {
  GitHubIdentityModeSnapshot,
  GitHubStableResolution,
} from './stable-identity-types';
import type { ExternalIdentityEvidence } from './types';

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

interface LinkedSourceLookupRow {
  candidateKey: string;
  linkedTaskId: string;
  linkedEntityId: string | null;
  stableEntityId: string | null;
  stableLinkedSourceId: string | null;
  stableTaskId: string | null;
  locatorRevision: number | null;
  currentOwnerKey: string | null;
  currentRepositoryKey: string | null;
  currentIssueNumber: number | null;
  pathEntityId: string | null;
}

export function persistGitHubLinkedSourceIdentityBatch(
  connectorInstanceId: string,
  writes: readonly GitHubLinkedSourceIdentityWrite[],
  modeSnapshot?: GitHubIdentityModeSnapshot,
): readonly GitHubLinkedSourceIdentityWriteResult[] {
  assertBatchSize(writes.length);
  if (writes.length === 0) return [];
  if (
    modeSnapshot
    && modeSnapshot.connectorInstanceId !== connectorInstanceId
  ) {
    throw new Error('Linked-source identity writes do not match the frozen connector');
  }

  return runTransaction((tx) => {
    if (modeSnapshot) {
      assertGitHubIdentityModeSnapshotInTransaction(tx, modeSnapshot);
    }
    const linkedRows = tx.select().from(taskLinkedSources).where(and(
      eq(taskLinkedSources.connectorInstanceId, connectorInstanceId),
      eq(taskLinkedSources.connectorType, 'github-issues'),
      inArray(taskLinkedSources.id, writes.map((write) => write.linkedSourceId)),
    )).all();
    const linkedById = new Map(linkedRows.map((row) => [row.id, row]));
    const results: GitHubLinkedSourceIdentityWriteResult[] = [];

    for (const write of writes) {
      const linked = linkedById.get(write.linkedSourceId);
      if (!linked || !write.evidence) {
        results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
        continue;
      }

      const identity = write.evidence.entity.identity;
      if (
        identity.provider !== 'github'
        || identity.entityType !== 'issue'
      ) {
        results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
        continue;
      }

      const entity = tx.select({ id: externalEntities.id }).from(externalEntities).where(and(
        eq(externalEntities.provider, identity.provider),
        eq(externalEntities.hostKey, identity.hostKey),
        eq(externalEntities.entityType, identity.entityType),
        eq(externalEntities.stableId, identity.stableId),
      )).limit(1).get();
      if (!entity) {
        results.push({ linkedSourceId: write.linkedSourceId, state: 'unbound' });
        continue;
      }

      const locator = tx.select({
        ownerKey: externalEntityLocators.ownerKey,
        repositoryKey: externalEntityLocators.repositoryKey,
        issueNumber: externalEntityLocators.issueNumber,
      }).from(externalEntityLocators).where(and(
        eq(externalEntityLocators.externalEntityId, entity.id),
        isNull(externalEntityLocators.validTo),
      )).limit(1).get();
      const evidenceLocator = write.evidence.entity.locator;
      if (
        !locator
        || locator.ownerKey !== evidenceLocator.owner.toLowerCase()
        || locator.repositoryKey !== evidenceLocator.repository.toLowerCase()
        || locator.issueNumber !== (evidenceLocator.issueNumber ?? null)
      ) {
        results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
        continue;
      }

      const existingForLinked = tx.select().from(taskLinkedSourceEntities)
        .where(eq(taskLinkedSourceEntities.linkedSourceId, linked.id)).limit(1).get();
      const existingForEntity = tx.select().from(taskLinkedSourceEntities).where(and(
        eq(taskLinkedSourceEntities.connectorInstanceId, connectorInstanceId),
        eq(taskLinkedSourceEntities.externalEntityId, entity.id),
      )).limit(1).get();
      const locatorMatchesLegacy = canonicalLegacySourceId(write.evidence).toLowerCase()
        === linked.sourceId.toLowerCase();
      if (
        (existingForLinked && (
          existingForLinked.externalEntityId !== entity.id
          || existingForLinked.connectorInstanceId !== connectorInstanceId
        ))
        || (existingForEntity && existingForEntity.linkedSourceId !== linked.id)
        || (!existingForLinked && !locatorMatchesLegacy)
      ) {
        results.push({ linkedSourceId: write.linkedSourceId, state: 'collision' });
        continue;
      }

      const observedAt = write.evidence.entity.observedAt;
      // The linked-source `source_id` is a mutable locator: NodeID identity is
      // authoritative, so repoint the locator whenever GitHub reports a new one.
      const currentSourceId = canonicalLegacySourceId(write.evidence);
      if (linked.sourceId !== currentSourceId) {
        tx.update(taskLinkedSources).set({
          sourceId: currentSourceId,
        }).where(eq(taskLinkedSources.id, linked.id)).run();
      }
      tx.insert(taskLinkedSourceEntities).values({
        linkedSourceId: linked.id,
        connectorInstanceId,
        externalEntityId: entity.id,
        verifiedAt: observedAt,
        createdAt: observedAt,
        updatedAt: observedAt,
      }).onConflictDoUpdate({
        target: taskLinkedSourceEntities.linkedSourceId,
        set: {
          verifiedAt: observedAt,
          updatedAt: observedAt,
        },
      }).run();
      results.push({ linkedSourceId: write.linkedSourceId, state: 'associated' });
    }
    return results;
  });
}

export function resolveGitHubLinkedSourceIdentityBatch(
  connectorInstanceId: string,
  candidates: readonly GitHubLinkedSourceIdentityCandidate[],
): {
  resolutions: ReadonlyMap<string, GitHubStableResolution>;
  lookupMs: number;
  queryCount: number;
} {
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

  const valuesSql = candidates.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
  const params: Array<string | number | null> = [];
  for (const candidate of candidates) {
    const observation = candidate.evidence?.entity;
    params.push(
      candidate.candidateKey,
      candidate.linkedSourceId,
      observation?.identity.stableId ?? null,
      observation?.locator.owner.toLowerCase() ?? null,
      observation?.locator.repository.toLowerCase() ?? null,
      observation?.locator.issueNumber ?? null,
    );
  }
  const hostKey = namespaces[0]?.hostKey ?? '';
  params.push(
    connectorInstanceId,
    connectorInstanceId,
    'github',
    hostKey,
    'issue',
    connectorInstanceId,
    connectorInstanceId,
  );
  params.push('github', hostKey);

  const startedAt = performance.now();
  const rows = sqlite.prepare(`
    WITH incoming(
      candidate_key, linked_source_id, stable_id, owner_key, repository_key, issue_number
    ) AS (
      VALUES ${valuesSql}
    )
    SELECT
      incoming.candidate_key AS candidateKey,
      legacy_link.task_id AS linkedTaskId,
      linked_association.external_entity_id AS linkedEntityId,
      stable_entity.id AS stableEntityId,
      stable_association.linked_source_id AS stableLinkedSourceId,
      stable_link.task_id AS stableTaskId,
      current_locator.locator_revision AS locatorRevision,
      current_locator.owner_key AS currentOwnerKey,
      current_locator.repository_key AS currentRepositoryKey,
      current_locator.issue_number AS currentIssueNumber,
      path_locator.external_entity_id AS pathEntityId
    FROM incoming
    INNER JOIN task_linked_sources AS legacy_link
      ON legacy_link.id = incoming.linked_source_id
      AND legacy_link.connector_instance_id = ?
      AND legacy_link.connector_type = 'github-issues'
    LEFT JOIN task_linked_source_entities AS linked_association
      ON linked_association.linked_source_id = legacy_link.id
      AND linked_association.connector_instance_id = ?
    LEFT JOIN external_entities AS stable_entity
      ON stable_entity.provider = ?
      AND stable_entity.host_key = ?
      AND stable_entity.entity_type = ?
      AND stable_entity.stable_id = incoming.stable_id
    LEFT JOIN task_linked_source_entities AS stable_association
      ON stable_association.connector_instance_id = ?
      AND stable_association.external_entity_id = stable_entity.id
    LEFT JOIN task_linked_sources AS stable_link
      ON stable_link.id = stable_association.linked_source_id
      AND stable_link.connector_instance_id = ?
    LEFT JOIN external_entity_locators AS current_locator
      ON current_locator.external_entity_id = stable_entity.id
      AND current_locator.valid_to IS NULL
    LEFT JOIN external_entity_locators AS path_locator
      ON path_locator.provider = ?
      AND path_locator.host_key = ?
      AND path_locator.owner_key = incoming.owner_key
      AND path_locator.repository_key = incoming.repository_key
      AND path_locator.issue_number = incoming.issue_number
      AND path_locator.valid_to IS NULL
    ORDER BY incoming.candidate_key COLLATE BINARY
  `).all(...params) as LinkedSourceLookupRow[];
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
