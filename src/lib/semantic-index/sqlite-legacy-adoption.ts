/**
 * Legacy `search_embeddings` **assessment and candidate iteration**.
 *
 * This module does not adopt anything. It reads the legacy table that older
 * installations created at runtime, before retrieval moved onto the durable
 * index (`src/lib/search/semantic.ts` no longer creates, writes, or reads it):
 *
 *   id, entity_type, entity_id, embedding (JSON text),
 *   updated_at, provider, model, source_sort_at
 *
 * and answers two questions for a future integration phase:
 *
 * 1. `assessLegacyCohorts` — how many rows exist per (provider, model), and how
 *    many of them are actually eligible, with a reason for every rejection.
 * 2. `iterateLegacyAdoptionCandidates` — a conservative, keyset-paginated
 *    iterator of fully-validated rows that integration can import inside its own
 *    transaction.
 *
 * Eligibility is evaluated **per row**, never sampled. A row is eligible only
 * when all of the following hold:
 *
 * - its provider/model match the target identity exactly;
 * - its entity kind maps onto a supported `SemanticEntityType`;
 * - its embedding parses to an array of exactly `dimensions` finite numbers
 *   with a non-zero norm; and
 * - it is fresh: `source_sort_at IS NOT NULL`. Where the legacy triggers still
 *   exist they null that column whenever the source row's indexed text
 *   changes, so a null means the stored vector no longer matches its source.
 *   No new trigger is ever created, and a database that never had them simply
 *   yields no eligible rows.
 *
 * Nothing here writes, and nothing here claims a row has been adopted.
 *
 * ## Why nothing is adopted (issue #1664, phase 3 decision)
 *
 * Adoption is deliberately **not** performed. A legacy `search_embeddings` row
 * carries only `(entity_type, entity_id, embedding, provider, model,
 * source_sort_at)`. A `semantic_vectors` row is only meaningful when it points
 * at a `semantic_documents` row and names the exact `documentVersion`,
 * `sourceRevision`, `contentFingerprint`, and `projectionVersion` it embedded.
 * None of those four values exist in the legacy table, and none can be derived:
 *
 * - `contentFingerprint` is a hash of the *new* normalized projection, which
 *   the legacy row was never built from — the legacy embedding text was
 *   `title + truncate(body, 200)`, with no keywords, metadata, or sensitivity.
 *   Two different projections would therefore share one fingerprint, and the
 *   worker's "skip re-embedding when the fingerprint matches" rule would
 *   permanently skip re-embedding content that was never embedded.
 * - `sourceRevision` cannot be reconstructed from `source_sort_at` alone.
 * - `sensitivity` was never recorded, so an adopted vector could silently claim
 *   a tier its content does not have.
 *
 * Synthesizing any of those would be fabricating metadata, and the fabrication
 * would be indistinguishable from real data forever after. So legacy rows are
 * left untouched: reconciliation sees each entity as `missing`/`incompatible`
 * and re-embeds it through the ordinary intent path, which produces a document
 * and a vector that are actually consistent with each other. The helpers below
 * remain because an *assessment* of the legacy corpus is still useful for
 * operators sizing that first backfill.
 */

import type Database from 'better-sqlite3';
import { normalizeSemanticEntityType, type SemanticEntityType } from './contracts';
import { computeNorm, parseEmbedding } from './validation';

type SqliteDatabase = Database.Database;

export type LegacyIneligibilityReason =
  | 'unsupported-entity-type'
  | 'unparsable-embedding'
  | 'dimension-mismatch'
  | 'non-finite-embedding'
  | 'zero-norm-embedding'
  | 'stale-source';

export interface LegacyCohort {
  provider: string;
  model: string;
  /** Total legacy rows in this (provider, model) cohort. */
  total: number;
  /** Rows that passed every validation above. */
  eligible: number;
  ineligible: number;
  /** Ineligible counts keyed by reason; only non-zero reasons appear. */
  ineligibleByReason: Partial<Record<LegacyIneligibilityReason, number>>;
  /**
   * Distinct embedding lengths actually observed in this cohort. More than one
   * entry means the cohort is not a single vector space and must not be adopted
   * wholesale.
   */
  observedDimensions: number[];
}

export interface LegacyCohortAssessment {
  tableExists: boolean;
  cohorts: LegacyCohort[];
  totalRows: number;
  eligibleRows: number;
}

export interface LegacyAdoptionTarget {
  provider: string;
  model: string;
  dimensions: number;
}

export interface LegacyAdoptionCandidate {
  legacyId: string;
  entityType: SemanticEntityType;
  entityId: string;
  embedding: Float32Array;
  norm: number;
  provider: string;
  model: string;
  dimensions: number;
  /** Legacy freshness marker; non-null for every candidate returned. */
  sourceSortAt: string;
  updatedAt: string;
}

interface LegacyRow {
  id: string;
  entityType: string;
  entityId: string;
  embedding: string;
  updatedAt: string;
  provider: string;
  model: string;
  sourceSortAt: string | null;
}

export function legacyEmbeddingsTableExists(db: SqliteDatabase): boolean {
  const row = db.prepare(`
    SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'search_embeddings'
  `).get();
  return row !== undefined;
}

/**
 * Classifies one legacy row against a target vector space.
 * Returns the validated candidate, or the reason it is not adoptable.
 */
export function classifyLegacyRow(
  row: LegacyRow,
  target: Pick<LegacyAdoptionTarget, 'dimensions'>,
): { candidate: LegacyAdoptionCandidate } | { reason: LegacyIneligibilityReason; length: number | null } {
  const entityType = normalizeSemanticEntityType(row.entityType);
  if (!entityType) return { reason: 'unsupported-entity-type', length: null };

  let rawLength: number | null = null;
  try {
    const parsedRaw: unknown = JSON.parse(row.embedding);
    if (Array.isArray(parsedRaw)) rawLength = parsedRaw.length;
  } catch {
    rawLength = null;
  }

  const embedding = parseEmbedding(row.embedding);
  if (!embedding) {
    // `parseEmbedding` rejects both malformed JSON and non-finite members;
    // `rawLength` tells the two apart without re-implementing the parser.
    return {
      reason: rawLength === null ? 'unparsable-embedding' : 'non-finite-embedding',
      length: rawLength,
    };
  }
  if (embedding.length !== target.dimensions) {
    return { reason: 'dimension-mismatch', length: embedding.length };
  }
  const norm = computeNorm(embedding);
  if (!Number.isFinite(norm) || norm === 0) {
    return { reason: 'zero-norm-embedding', length: embedding.length };
  }
  if (row.sourceSortAt === null) {
    return { reason: 'stale-source', length: embedding.length };
  }

  return {
    candidate: {
      legacyId: row.id,
      entityType,
      entityId: row.entityId,
      embedding,
      norm,
      provider: row.provider,
      model: row.model,
      dimensions: embedding.length,
      sourceSortAt: row.sourceSortAt,
      updatedAt: row.updatedAt,
    },
  };
}

const LEGACY_COLUMNS = `
  id,
  entity_type AS entityType,
  entity_id AS entityId,
  embedding,
  updated_at AS updatedAt,
  COALESCE(provider, '') AS provider,
  COALESCE(model, '') AS model,
  source_sort_at AS sourceSortAt
`;

/**
 * Assesses every legacy row — no sampling — and reports per-cohort eligibility.
 *
 * `expectedDimensions` maps a (provider, model) cohort to the dimension count a
 * candidate index identity would declare. A cohort without an expectation is
 * measured against the dimension count that the majority of its own rows use,
 * which surfaces mixed-dimension cohorts instead of hiding them.
 *
 * Read-only, and safe to call whether or not the legacy table exists. Rows are
 * streamed with `iterate()` so a large legacy table is never fully materialized.
 */
export function assessLegacyCohorts(
  db: SqliteDatabase,
  expectedDimensions: Record<string, number> = {},
): LegacyCohortAssessment {
  if (!legacyEmbeddingsTableExists(db)) {
    return { tableExists: false, cohorts: [], totalRows: 0, eligibleRows: 0 };
  }

  interface Accumulator {
    provider: string;
    model: string;
    total: number;
    lengths: Map<number, number>;
    rows: LegacyRow[];
  }

  const cohortKey = (provider: string, model: string) => `${provider}\u0000${model}`;
  const accumulators = new Map<string, Accumulator>();

  const statement = db.prepare(`SELECT ${LEGACY_COLUMNS} FROM search_embeddings`);
  for (const row of statement.iterate() as IterableIterator<LegacyRow>) {
    const key = cohortKey(row.provider, row.model);
    let accumulator = accumulators.get(key);
    if (!accumulator) {
      accumulator = { provider: row.provider, model: row.model, total: 0, lengths: new Map(), rows: [] };
      accumulators.set(key, accumulator);
    }
    accumulator.total += 1;
    accumulator.rows.push(row);
    const parsed = parseEmbedding(row.embedding);
    if (parsed) accumulator.lengths.set(parsed.length, (accumulator.lengths.get(parsed.length) ?? 0) + 1);
  }

  const cohorts: LegacyCohort[] = [];
  let totalRows = 0;
  let eligibleRows = 0;

  for (const accumulator of accumulators.values()) {
    const expected = expectedDimensions[cohortKey(accumulator.provider, accumulator.model)]
      ?? expectedDimensions[accumulator.model]
      ?? dominantLength(accumulator.lengths);

    const ineligibleByReason: Partial<Record<LegacyIneligibilityReason, number>> = {};
    let eligible = 0;

    for (const row of accumulator.rows) {
      // An unknown dimension count means no row can be validated; classify all
      // of them as dimension mismatches rather than guessing.
      const classified = expected === null
        ? { reason: 'dimension-mismatch' as const, length: null }
        : classifyLegacyRow(row, { dimensions: expected });
      if ('candidate' in classified) {
        eligible += 1;
        continue;
      }
      ineligibleByReason[classified.reason] = (ineligibleByReason[classified.reason] ?? 0) + 1;
    }

    totalRows += accumulator.total;
    eligibleRows += eligible;
    cohorts.push({
      provider: accumulator.provider,
      model: accumulator.model,
      total: accumulator.total,
      eligible,
      ineligible: accumulator.total - eligible,
      ineligibleByReason,
      observedDimensions: [...accumulator.lengths.keys()].sort((a, b) => a - b),
    });
  }

  cohorts.sort((a, b) => (a.provider === b.provider
    ? a.model.localeCompare(b.model)
    : a.provider.localeCompare(b.provider)));

  return { tableExists: true, cohorts, totalRows, eligibleRows };
}

function dominantLength(lengths: Map<number, number>): number | null {
  let best: number | null = null;
  let bestCount = 0;
  for (const [length, count] of lengths) {
    if (count > bestCount || (count === bestCount && best !== null && length < best)) {
      best = length;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Conservatively iterates fully-validated adoption candidates for one target
 * vector space, in stable `id` order using keyset pagination.
 *
 * The caller drives the transaction: each batch is read outside any write, so an
 * integration phase can import a batch, commit, and resume from the returned
 * cursor without holding a long-lived lock. Rejected rows are simply skipped —
 * this function never mutates the legacy table.
 */
export function* iterateLegacyAdoptionCandidates(
  db: SqliteDatabase,
  target: LegacyAdoptionTarget,
  options: { batchSize?: number; after?: string } = {},
): Generator<LegacyAdoptionCandidate, void, undefined> {
  if (!legacyEmbeddingsTableExists(db)) return;

  const batchSize = Math.max(1, Math.min(options.batchSize ?? 200, 1_000));
  let cursor = options.after ?? '';

  const statement = db.prepare(`
    SELECT ${LEGACY_COLUMNS}
    FROM search_embeddings
    WHERE COALESCE(provider, '') = ?
      AND COALESCE(model, '') = ?
      AND source_sort_at IS NOT NULL
      AND id > ?
    ORDER BY id ASC
    LIMIT ?
  `);

  for (;;) {
    const rows = statement.all(target.provider, target.model, cursor, batchSize) as LegacyRow[];
    if (rows.length === 0) return;
    for (const row of rows) {
      cursor = row.id;
      const classified = classifyLegacyRow(row, target);
      if ('candidate' in classified) yield classified.candidate;
    }
    if (rows.length < batchSize) return;
  }
}
