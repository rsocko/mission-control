/**
 * Deterministic normalization, truncation, and fingerprinting shared by every
 * projection adapter.
 *
 * Everything here is pure and synchronous. Two processes on two machines
 * projecting the same source snapshot must produce byte-identical output — that
 * is what makes `contentFingerprint` a trustworthy "skip re-embedding" signal
 * and what keeps a document written by the web process indistinguishable from
 * one written by the worker.
 */

import { createHash } from 'node:crypto';
import type {
  SemanticDocumentMetadataValue,
  SemanticEntityType,
  SemanticSensitivity,
} from '../contracts';

/** Hard caps. Projections are retrieval surfaces, not archives. */
export const SEMANTIC_TITLE_MAX_LENGTH = 300;
export const SEMANTIC_BODY_MAX_LENGTH = 2_000;
export const SEMANTIC_KEYWORD_MAX_LENGTH = 64;
export const SEMANTIC_MAX_KEYWORDS = 24;

/**
 * Collapses all Unicode whitespace runs (including newlines) to single spaces
 * and trims. Applied to titles and keywords, where internal line structure
 * carries no meaning.
 */
export function normalizeInline(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/gu, ' ').trim();
}

/**
 * Collapses horizontal whitespace and runs of blank lines while preserving
 * single line breaks, so a task description keeps its paragraph structure
 * without letting trailing spaces change the fingerprint.
 */
export function normalizeBlock(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/\r\n?/gu, '\n')
    .split('\n')
    .map((line) => line.replace(/[^\S\n]+/gu, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

/**
 * Truncates on a UTF-16 code-unit boundary that never splits a surrogate pair,
 * appending a single ellipsis. Deterministic for a given input and limit.
 */
export function truncateStable(value: string, maxLength: number): string {
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  let cut = maxLength - 1;
  const code = value.charCodeAt(cut - 1);
  // A high surrogate at the boundary would otherwise be orphaned.
  if (cut > 0 && code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return `${value.slice(0, cut).trimEnd()}…`;
}

export function normalizeTitleField(value: string | null | undefined): string {
  return truncateStable(normalizeInline(value), SEMANTIC_TITLE_MAX_LENGTH);
}

export function normalizeBodyField(value: string | null | undefined): string {
  return truncateStable(normalizeBlock(value), SEMANTIC_BODY_MAX_LENGTH);
}

export function normalizeBoundedBodyField(
  value: string | null | undefined,
  maxLength: number,
): string {
  return truncateStable(normalizeBlock(value), Math.min(maxLength, SEMANTIC_BODY_MAX_LENGTH));
}

/**
 * Lower-cases, de-duplicates, and sorts keywords so ordering differences in the
 * source (tag join order, for instance) never change the fingerprint.
 */
export function normalizeKeywords(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const keyword = truncateStable(
      normalizeInline(value).toLowerCase(),
      SEMANTIC_KEYWORD_MAX_LENGTH,
    );
    if (keyword) seen.add(keyword);
  }
  return [...seen].sort().slice(0, SEMANTIC_MAX_KEYWORDS);
}

/**
 * Drops `undefined` entries and orders keys, so metadata built by different
 * code paths serializes identically.
 */
export function normalizeMetadata(
  metadata: Record<string, SemanticDocumentMetadataValue | undefined>,
): Record<string, SemanticDocumentMetadataValue> {
  const normalized: Record<string, SemanticDocumentMetadataValue> = {};
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value === undefined) continue;
    normalized[key] = typeof value === 'string' ? normalizeInline(value) : value;
  }
  return normalized;
}

function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return '\u0000null';
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export interface SemanticFingerprintInput {
  entityType: SemanticEntityType;
  entityId: string;
  projectionVersion: number;
  title: string;
  body: string;
  keywords: string[];
  metadata: Record<string, SemanticDocumentMetadataValue>;
  sensitivity: SemanticSensitivity;
  retainUntil: string | null;
}

/**
 * SHA-256 over the canonicalized **normalized projection**.
 *
 * Deliberately excludes `sourceRevision` and `sourceUpdatedAt`: a source row
 * that was touched without changing any projected content must produce the same
 * fingerprint so the worker can skip a paid embedding call. Sensitivity and
 * retention *are* included, because a change to either has to produce a new
 * vector (or none at all).
 */
export function computeContentFingerprint(input: SemanticFingerprintInput): string {
  return sha256(canonicalize({
    v: input.projectionVersion,
    t: input.entityType,
    i: input.entityId,
    title: input.title,
    body: input.body,
    keywords: input.keywords,
    metadata: input.metadata,
    sensitivity: input.sensitivity,
    retainUntil: input.retainUntil,
  }));
}

/**
 * SHA-256 over the **raw source snapshot**, truncated to 32 hex characters.
 *
 * Mission Control's domain tables carry no etag, so the revision is derived
 * from every source field the projection reads — including timestamps. Any
 * source mutation that could affect the projection therefore yields a new
 * revision, which is what the conditional vector write compares against.
 */
export function computeSourceRevision(snapshot: Record<string, unknown>): string {
  return sha256(canonicalize(snapshot)).slice(0, 32);
}

/**
 * Picks the newest of a set of candidate timestamps as the monotonic source
 * mutation stamp. Invalid or absent values are ignored; when nothing is usable
 * the caller's fallback is returned so `sourceUpdatedAt` is never empty.
 */
export function latestTimestamp(
  candidates: Array<string | null | undefined>,
  fallback: string,
): string {
  let bestValue: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (!candidate) continue;
    const ms = new Date(candidate).getTime();
    if (!Number.isFinite(ms)) continue;
    if (ms > bestMs) {
      bestMs = ms;
      bestValue = candidate;
    }
  }
  return bestValue === null ? fallback : new Date(bestMs).toISOString();
}

/** Normalizes a timestamp to ISO-8601 UTC, or returns `null` when unusable. */
export function toIsoTimestamp(value: string | null | undefined): string | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
