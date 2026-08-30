/**
 * Pure, driver-free value helpers shared by the Layer 3B GitHub recovery
 * contract, both adapters, and the orchestrating services.
 *
 * Nothing here may touch a database, a driver, or the network.
 */

import { createHash } from 'node:crypto';

/** Deterministic canonical JSON: object keys sorted, arrays order-preserving. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 of the canonical JSON encoding of `value`. */
export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/** SHA-256 of a raw string (used for stable/node identifiers). */
export function identifierDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function compareCanonical(left: unknown, right: unknown): number {
  return canonicalJson(left).localeCompare(canonicalJson(right));
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    try {
      return asStringArray(JSON.parse(value));
    } catch {
      return [];
    }
  }
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function samePath(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function repositoryPath(owner: string, repository: string): string {
  return `${owner}/${repository}`;
}

/** Reads `settings.apiOrigin` without materializing the rest of the object. */
export function readApiOrigin(settings: unknown): string | null {
  const value = asRecord(settings).apiOrigin;
  return typeof value === 'string' ? value : null;
}

const MAX_BACKUP_AGE_MS = 24 * 60 * 60_000;

/**
 * Validates a pre-verified backup attestation without touching the filesystem.
 * Shared by the repoint and bulk-transfer preflights so both backends apply the
 * same freshness and integrity rules to externally produced evidence.
 */
export function isBackupAttestationReady(
  proof: { sha256?: unknown; sizeBytes?: unknown; integrityCheck?: unknown; verifiedAt?: unknown } | undefined,
  now: Date,
  options: { allowFutureVerification?: boolean } = {},
): boolean {
  if (!proof) return false;
  const verifiedAt = Date.parse(String(proof.verifiedAt));
  if (!Number.isFinite(verifiedAt)) return false;
  if (proof.integrityCheck !== 'ok') return false;
  if (typeof proof.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.sha256)) return false;
  if (typeof proof.sizeBytes !== 'number' || proof.sizeBytes <= 0) return false;
  const ageMs = now.getTime() - verifiedAt;
  if (options.allowFutureVerification) {
    return Math.abs(ageMs) <= MAX_BACKUP_AGE_MS;
  }
  return ageMs >= 0 && ageMs <= MAX_BACKUP_AGE_MS;
}

export const BACKUP_ATTESTATION_MAX_AGE_MS = MAX_BACKUP_AGE_MS;
