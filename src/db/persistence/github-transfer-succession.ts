/**
 * Pure, driver-free rules for GitHub historical task-transfer succession.
 *
 * Both the SQLite legacy helper
 * (`@/lib/external-identities/task-transfer-reconciliation`) and the Layer 3B
 * adapters build and re-validate the succession proof through this module, so
 * the safety rules cannot drift between backends.
 */

import { createHash } from 'node:crypto';
import type { ExternalIdentityEvidence } from '@/lib/external-identities/types';
import { canonicalDigest } from './github-recovery-values';

export interface HistoricalTransferBinding {
  taskId: string;
  externalEntityId: string;
  stableId: string;
  hostKey: string;
  locatorSourceId: string;
}

export interface HistoricalTransferObservationValue {
  evidence: ExternalIdentityEvidence;
  title: string;
  state: string;
  stateReason: string | null;
}

export interface HistoricalTransferAudit {
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
  requestedSourceId: string;
  observation: HistoricalTransferObservationValue;
}

export function digestHistoricalProof(proof: unknown): string {
  return canonicalDigest(proof);
}

export function historicalProofDigestMatches(proof: unknown, digest: string): boolean {
  if (digestHistoricalProof(proof) === digest) return true;
  // Rows created before Layer 3B used insertion-ordered JSON. Keep those
  // immutable SQLite audit records verifiable while all new writes use the
  // JSONB-safe canonical encoding.
  return createHash('sha256').update(JSON.stringify(proof)).digest('hex') === digest;
}

export function canonicalIssueSourceId(
  owner: string,
  repository: string,
  issueNumber: number | undefined,
): string {
  if (!Number.isSafeInteger(issueNumber) || (issueNumber ?? 0) <= 0) {
    throw new Error('GitHub issue locator requires a positive issue number');
  }
  return `${owner}/${repository}:${issueNumber}`.toLowerCase();
}

export function validateHistoricalAuditRequest(request: HistoricalTransferAudit): void {
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new Error('Historical transfer reconciliation requires a non-negative mode revision');
  }
  if (request.actor.length < 1 || request.actor.length > 80) {
    throw new Error('Historical transfer reconciliation actor must be 1-80 characters');
  }
  if (request.reason.length < 3 || request.reason.length > 500) {
    throw new Error('Historical transfer reconciliation reason must be 3-500 characters');
  }
  if (request.idempotencyKey.length < 8 || request.idempotencyKey.length > 192) {
    throw new Error('Historical transfer idempotency key must be 8-192 characters');
  }
}

export function buildHistoricalTransferProof(
  request: HistoricalTransferAudit,
  source: HistoricalTransferBinding,
  successor: HistoricalTransferBinding,
): Record<string, unknown> {
  const observation = request.observation;
  const remote = observation.evidence.entity;
  if (
    source.taskId === successor.taskId
    || source.externalEntityId === successor.externalEntityId
  ) {
    throw new Error('Historical transfer reconciliation requires distinct tasks and identities');
  }
  if (source.hostKey !== successor.hostKey || remote.identity.hostKey !== source.hostKey) {
    throw new Error('Historical transfer reconciliation must stay in one GitHub host namespace');
  }
  if (
    remote.identity.provider !== 'github'
    || remote.identity.entityType !== 'issue'
    || remote.observationSource !== 'rest'
  ) {
    throw new Error('Historical transfer reconciliation requires authoritative REST issue evidence');
  }
  if (remote.identity.stableId !== successor.stableId) {
    throw new Error('Historical endpoint did not resolve to the successor stable identity');
  }
  if (remote.identity.stableId === source.stableId) {
    throw new Error('Historical endpoint still resolves to the source stable identity');
  }
  const remoteSourceId = canonicalIssueSourceId(
    remote.locator.owner,
    remote.locator.repository,
    remote.locator.issueNumber,
  );
  if (request.requestedSourceId.toLowerCase() !== source.locatorSourceId) {
    throw new Error('Historical transfer lookup did not target the source task locator');
  }
  if (remoteSourceId !== successor.locatorSourceId) {
    throw new Error('Historical endpoint canonical locator does not match the successor task');
  }
  if (remoteSourceId === source.locatorSourceId) {
    throw new Error('Historical endpoint did not move to a distinct locator');
  }

  return {
    requestedSourceId: source.locatorSourceId,
    successorSourceId: successor.locatorSourceId,
    sourceStableId: source.stableId,
    successorStableId: successor.stableId,
    observedStableId: remote.identity.stableId,
    observedAt: remote.observedAt,
    title: observation.title,
    state: observation.state,
    stateReason: observation.stateReason,
    apiUrl: remote.locator.apiUrl ?? null,
    webUrl: remote.locator.webUrl ?? null,
  };
}

export function historicalProofMatchesBindings(
  value: unknown,
  source: HistoricalTransferBinding,
  successor: HistoricalTransferBinding,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proof = value as Record<string, unknown>;
  return proof.requestedSourceId === source.locatorSourceId
    && proof.successorSourceId === successor.locatorSourceId
    && proof.sourceStableId === source.stableId
    && proof.successorStableId === successor.stableId
    && proof.observedStableId === successor.stableId;
}
