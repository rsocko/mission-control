import type { PersistenceJson } from './contracts';

/**
 * Shared, backend-neutral value codecs for text/JSON columns.
 *
 * These exist because several SQLite adapters independently re-implemented
 * the same "string-or-object JSON decode" and "deterministic canonical JSON"
 * logic. Extraction here is deliberately narrow: only the exact-duplicate
 * behavior is centralized, and every call site that now delegates to this
 * module has been verified to produce byte-identical output for every input
 * it previously accepted. Conversion happens only at adapter/import
 * boundaries - domain code keeps working with `PersistenceJson` and `boolean`
 * values, never with driver-specific text/blob encodings.
 */

// ─── Canonical JSON serialization ───────────────────────────────────────────

/**
 * Deterministic, order-independent serialization of a JSON-like value: object
 * keys are sorted recursively (array order is preserved, since order is
 * meaningful there). Used both for content hashing/digests and for comparing
 * a stored document against an incoming one without treating a harmless
 * key-reordering (e.g. from a `jsonb` round-trip, which does not preserve key
 * order) as a change.
 *
 * `undefined` - whether at the top level or as an object property value - is
 * treated as JSON `null` would be, matching `JSON.stringify`'s own handling
 * of `undefined` object properties (which are omitted) while still producing
 * a defined string result for a bare `undefined` input.
 */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

// ─── Lenient JSON decode (never throws) ─────────────────────────────────────

/**
 * Decodes a value that may already be a plain object, or may be its
 * JSON-encoded text form (as legacy SQLite `TEXT` columns store it), falling
 * back to `{}` for anything else - including malformed JSON, arrays, and
 * primitives. Never throws.
 */
export function decodeLenientJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * Decodes a value that may already be an array, or may be its JSON-encoded
 * text form, falling back to `[]` for anything else. Never throws.
 */
export function decodeLenientJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ─── Strict JSON decode (throws with a caller-provided message) ────────────

export interface StrictJsonObjectErrors {
  /** Thrown when the stored text does not parse as JSON at all. */
  invalidJson: string;
  /** Thrown when the parsed value is not a plain (non-array) JSON object. */
  notAnObject: string;
}

/**
 * Decodes a value that may already be a plain object, or may be its
 * JSON-encoded text form, throwing a caller-supplied error for either an
 * unparseable string or a value that is not a plain object once parsed. This
 * is the common prefix shared by every strict, throwing persistence-payload
 * parser (event outbox, notification delivery, notification enrichment):
 * each of those layers its own field-level validation on top of the object
 * this returns.
 */
export function decodeStrictJsonObject(
  value: unknown,
  errors: StrictJsonObjectErrors,
): Record<string, unknown> {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error(errors.invalidJson);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(errors.notAnObject);
  }
  return parsed as Record<string, unknown>;
}

// ─── SQL NULL vs. JSON null ──────────────────────────────────────────────────

/**
 * A decoded slot for a nullable JSON-encoded text column, distinguishing the
 * three states a persisted value can be in:
 *
 * - `sql-null`: the column itself has no value (the driver returned `null`
 *   for the row/field, not a stored empty string or the four-character text
 *   `"null"`).
 * - `json-null`: the column stores JSON text whose decoded value is the JSON
 *   literal `null` (e.g. the persisted text is exactly `"null"`).
 * - `json-value`: the column stores JSON text that decodes to any other
 *   `PersistenceJson` value.
 *
 * Both `sql-null` and `json-null` are legitimate, distinct "no value" states
 * that would otherwise collapse into the same JS `null` if the raw column
 * value were parsed without first checking whether it was present at all;
 * carrying the distinction as a discriminated union keeps that boundary
 * decision explicit and testable, instead of silently conflating "this row
 * has no stored value" with "this row explicitly stores JSON `null`".
 */
export type CanonicalJsonSlot =
  | { kind: 'sql-null' }
  | { kind: 'json-null' }
  | { kind: 'json-value'; value: PersistenceJson };

/**
 * Decodes a nullable JSON-encoded text column. `raw` must be exactly what the
 * driver returned for that column: `null` for SQL NULL, or the stored JSON
 * text otherwise (including the four-character text `"null"` for an
 * explicitly persisted JSON null).
 */
export function decodeCanonicalJsonSlot(raw: string | null): CanonicalJsonSlot {
  if (raw === null) return { kind: 'sql-null' };
  const value = JSON.parse(raw) as PersistenceJson;
  return value === null ? { kind: 'json-null' } : { kind: 'json-value', value };
}

/** Encodes a {@link CanonicalJsonSlot} back to what a driver should store. */
export function encodeCanonicalJsonSlot(slot: CanonicalJsonSlot): string | null {
  if (slot.kind === 'sql-null') return null;
  if (slot.kind === 'json-null') return 'null';
  return JSON.stringify(slot.value);
}

// ─── SQLite boolean (0/1 integer column <-> boolean) ────────────────────────

/**
 * Decodes a SQLite `INTEGER` column used as a boolean flag. `better-sqlite3`
 * returns such columns as the number `0`/`1` (or `bigint` if the driver's
 * `safeIntegers` mode is enabled); any other truthy/falsy numeric value is
 * treated by its truthiness, matching SQLite's own `IS TRUE`/`IS FALSE`
 * semantics for non-zero integers.
 */
export function decodeSqliteBoolean(value: number | bigint | null | undefined): boolean {
  return Boolean(value);
}

/** Encodes a boolean as the `0`/`1` integer SQLite stores for a boolean flag. */
export function encodeSqliteBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}
