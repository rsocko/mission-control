import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it, vi } from 'vitest';
import {
  semanticDocuments,
  semanticIndexIdentities,
  semanticIntents,
  semanticRuns,
  semanticVectors,
} from '@/db/schema/semantic-index';
import {
  assessLegacyCohorts,
  classifyLegacyRow,
  iterateLegacyAdoptionCandidates,
  legacyEmbeddingsTableExists,
} from '@/lib/semantic-index/sqlite-legacy-adoption';

const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle');

function applySemanticIndexMigration(db: Database.Database) {
  db.pragma('foreign_keys = ON');
  const sql = readFileSync(resolve(MIGRATIONS_FOLDER, '0121_semantic_index.sql'), 'utf8');
  for (const statement of sql.split('--> statement-breakpoint')) {
    if (statement.trim()) db.exec(statement);
  }
}

function insertIdentity(db: Database.Database, id: string, status: string) {
  db.prepare(`
    INSERT INTO semantic_index_identities (
      id, provider, model, dimensions, projection_version, status,
      document_count, vector_count, created_at, updated_at
    ) VALUES (?, 'openai', 'text-embedding-3-small', 3, 1, ?, 0, 0, '2026-01-01', '2026-01-01')
  `).run(id, status);
}

function insertDocument(db: Database.Database, id: string, indexId: string, entityId: string) {
  db.prepare(`
    INSERT INTO semantic_documents (
      id, index_id, entity_type, entity_id, version, title, body, keywords, metadata,
      source_revision, content_fingerprint, projection_version, sensitivity,
      retain_until, source_updated_at, created_at, updated_at
    ) VALUES (?, ?, 'task', ?, 1, 'title', 'body', '[]', '{}', 'rev-1', 'fp-1', 1,
      'standard', NULL, '2026-01-01', '2026-01-01', '2026-01-01')
  `).run(id, indexId, entityId);
}

function insertVector(db: Database.Database, id: string, indexId: string, documentId: string, entityId: string) {
  db.prepare(`
    INSERT INTO semantic_vectors (
      id, index_id, document_id, document_version, entity_type, entity_id,
      source_revision, content_fingerprint, projection_version, provider, model,
      dimensions, sensitivity, embedding, norm, source_updated_at, embedded_at,
      index_run_id, intent_id, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 1, 'task', ?, 'rev-1', 'fp-1', 1, 'openai',
      'text-embedding-3-small', 3, 'standard', '[1,0,0]', '1', '2026-01-01',
      '2026-01-01', NULL, NULL, NULL, '2026-01-01', '2026-01-01')
  `).run(id, indexId, documentId, entityId);
}

function insertIntent(db: Database.Database, id: string, indexId: string, key: string, status: string) {
  db.prepare(`
    INSERT INTO semantic_intents (
      id, idempotency_key, index_id, kind, entity_type, entity_id, requested_at,
      status, attempt, max_attempts, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'upsert', 'task', 't1', '2026-01-01', ?, 0, 5,
      '2026-01-01', '2026-01-01', '2026-01-01')
  `).run(id, key, indexId, status);
}

function insertRun(db: Database.Database, id: string, indexId: string, kind: string, key: string, status: string) {
  db.prepare(`
    INSERT INTO semantic_runs (
      id, index_id, kind, idempotency_key, status, processed_count, failed_count,
      skipped_count, attempt, max_attempts, available_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 3, '2026-01-01', '2026-01-01', '2026-01-01')
  `).run(id, indexId, kind, key, status);
}

describe('semantic index migration 0121', () => {
  it('creates every semantic index table', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table'
        AND name LIKE 'semantic_%' ORDER BY name
      `).all() as Array<{ name: string }>;

      expect(tables.map((table) => table.name)).toEqual([
        'semantic_documents',
        'semantic_index_identities',
        'semantic_intents',
        'semantic_runs',
        'semantic_vectors',
      ]);
    } finally {
      db.close();
    }
  });

  it('is registered in the drizzle journal so the migration chain applies it', async () => {    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();
    const db = new Database(':memory:');
    try {
      const { _runMigrationsIndividually } = await import('@/db');
      _runMigrationsIndividually(db, MIGRATIONS_FOLDER);
      const tables = db.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'semantic_%'
      `).all() as Array<{ name: string }>;
      expect(tables).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it('matches the drizzle SQLite schema column-for-column and index-for-index', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);

      const declared = [
        semanticIndexIdentities,
        semanticDocuments,
        semanticVectors,
        semanticIntents,
        semanticRuns,
      ];

      for (const table of declared) {
        const config = getTableConfig(table);

        const migratedColumns = (db.prepare(
          `PRAGMA table_info(${config.name})`,
        ).all() as Array<{ name: string; notnull: number }>);
        expect(migratedColumns.length, `${config.name} exists`).toBeGreaterThan(5);
        expect(
          migratedColumns.map((column) => column.name),
          `${config.name} columns`,
        ).toEqual(config.columns.map((column) => column.name));
        expect(
          migratedColumns.map((column) => column.notnull === 1),
          `${config.name} nullability`,
        ).toEqual(config.columns.map((column) => column.notNull || column.primary));

        const migratedIndexes = (db.prepare(`
          SELECT name FROM sqlite_master
          WHERE type = 'index' AND tbl_name = ? AND name NOT LIKE 'sqlite_%'
          ORDER BY name
        `).all(config.name) as Array<{ name: string }>).map((row) => row.name);
        expect(migratedIndexes, `${config.name} indexes`).toEqual(
          config.indexes.map((index) => index.config.name).sort(),
        );
      }
    } finally {
      db.close();
    }
  });

  it('permits many ready identities but only one active identity', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);

      insertIdentity(db, 'ready-1', 'ready');
      insertIdentity(db, 'ready-2', 'ready');
      insertIdentity(db, 'ready-3', 'ready');
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM semantic_index_identities WHERE status = 'ready'").get(),
      ).toEqual({ count: 3 });

      insertIdentity(db, 'active-1', 'active');
      expect(() => insertIdentity(db, 'active-2', 'active')).toThrow();
    } finally {
      db.close();
    }
  });

  it('cascades documents, vectors, intents, and runs when an identity is deleted', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      insertIdentity(db, 'idx-1', 'building');
      insertDocument(db, 'doc-1', 'idx-1', 't1');
      insertVector(db, 'vec-1', 'idx-1', 'doc-1', 't1');
      insertIntent(db, 'int-1', 'idx-1', 'key-1', 'queued');
      insertRun(db, 'run-1', 'idx-1', 'backfill', 'run-key-1', 'queued');

      db.prepare("DELETE FROM semantic_index_identities WHERE id = 'idx-1'").run();

      for (const table of ['semantic_documents', 'semantic_vectors', 'semantic_intents', 'semantic_runs']) {
        expect(
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get(),
          table,
        ).toEqual({ count: 0 });
      }
    } finally {
      db.close();
    }
  });

  it('cascades vectors when their document is deleted', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      insertIdentity(db, 'idx-1', 'building');
      insertDocument(db, 'doc-1', 'idx-1', 't1');
      insertVector(db, 'vec-1', 'idx-1', 'doc-1', 't1');

      db.prepare("DELETE FROM semantic_documents WHERE id = 'doc-1'").run();
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM semantic_vectors').get(),
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it('enforces one document and one vector per entity per identity', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      insertIdentity(db, 'idx-1', 'building');
      insertDocument(db, 'doc-1', 'idx-1', 't1');
      expect(() => insertDocument(db, 'doc-2', 'idx-1', 't1')).toThrow();

      insertVector(db, 'vec-1', 'idx-1', 'doc-1', 't1');
      expect(() => insertVector(db, 'vec-2', 'idx-1', 'doc-1', 't1')).toThrow();
    } finally {
      db.close();
    }
  });

  it('scopes the intent idempotency key to queued rows only', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      insertIdentity(db, 'idx-1', 'building');

      insertIntent(db, 'int-1', 'idx-1', 'key-1', 'queued');
      // A second queued row for the same key is rejected: that is the coalescing key.
      expect(() => insertIntent(db, 'int-2', 'idx-1', 'key-1', 'queued')).toThrow();

      // A running attempt and terminal history never block a fresh enqueue.
      insertIntent(db, 'int-3', 'idx-1', 'key-2', 'running');
      insertIntent(db, 'int-4', 'idx-1', 'key-2', 'queued');
      insertIntent(db, 'int-5', 'idx-1', 'key-2', 'succeeded');
      insertIntent(db, 'int-6', 'idx-1', 'key-2', 'failed');
      expect(
        db.prepare("SELECT COUNT(*) AS count FROM semantic_intents WHERE idempotency_key = 'key-2'").get(),
      ).toEqual({ count: 4 });
    } finally {
      db.close();
    }
  });

  it('enforces run idempotency keys and one running run per (identity, kind)', () => {
    const db = new Database(':memory:');
    try {
      applySemanticIndexMigration(db);
      insertIdentity(db, 'idx-1', 'building');

      insertRun(db, 'run-1', 'idx-1', 'backfill', 'key-1', 'running');
      expect(() => insertRun(db, 'run-2', 'idx-1', 'reconcile', 'key-1', 'queued')).toThrow();
      expect(() => insertRun(db, 'run-3', 'idx-1', 'backfill', 'key-2', 'running')).toThrow();

      // A different kind, and queued rows of the same kind, are unconstrained.
      insertRun(db, 'run-4', 'idx-1', 'reconcile', 'key-3', 'running');
      insertRun(db, 'run-5', 'idx-1', 'backfill', 'key-4', 'queued');
      expect(
        db.prepare('SELECT COUNT(*) AS count FROM semantic_runs').get(),
      ).toEqual({ count: 3 });
    } finally {
      db.close();
    }
  });
});

// ─── Legacy adoption ───────────────────────────────────────────────────────

function createLegacyTable(db: Database.Database) {
  db.exec(`
    CREATE TABLE search_embeddings (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      source_sort_at TEXT
    )
  `);
}

function insertLegacyRow(
  db: Database.Database,
  row: {
    id: string;
    entityType?: string;
    entityId?: string;
    embedding: unknown;
    provider?: string;
    model?: string;
    sourceSortAt?: string | null;
  },
) {
  db.prepare(`
    INSERT INTO search_embeddings (id, entity_type, entity_id, embedding, updated_at, provider, model, source_sort_at)
    VALUES (?, ?, ?, ?, '2026-01-01', ?, ?, ?)
  `).run(
    row.id,
    row.entityType ?? 'task',
    row.entityId ?? row.id,
    typeof row.embedding === 'string' ? row.embedding : JSON.stringify(row.embedding),
    row.provider ?? 'openai',
    row.model ?? 'text-embedding-3-small',
    row.sourceSortAt === undefined ? '2026-01-01' : row.sourceSortAt,
  );
}

describe('legacy search_embeddings assessment', () => {
  it('reports the table as absent without throwing', () => {
    const db = new Database(':memory:');
    try {
      expect(legacyEmbeddingsTableExists(db)).toBe(false);
      expect(assessLegacyCohorts(db)).toEqual({
        tableExists: false,
        cohorts: [],
        totalRows: 0,
        eligibleRows: 0,
      });
      expect([...iterateLegacyAdoptionCandidates(db, {
        provider: 'openai', model: 'm', dimensions: 3,
      })]).toEqual([]);
    } finally {
      db.close();
    }
  });

  it('validates every row rather than sampling one', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'a1', embedding: [1, 0, 0] });
      insertLegacyRow(db, { id: 'a2', embedding: [0, 1, 0] });
      // Same cohort, wrong dimension count — a one-row sample would have missed it.
      insertLegacyRow(db, { id: 'a3', embedding: [0, 1] });
      insertLegacyRow(db, { id: 'a4', embedding: '{not json' });
      insertLegacyRow(db, { id: 'a5', embedding: [0, 0, 0] });
      insertLegacyRow(db, { id: 'a6', embedding: [1, 0, 0], sourceSortAt: null });
      insertLegacyRow(db, { id: 'a7', embedding: [1, 0, 0], entityType: 'unknown-kind' });

      const assessment = assessLegacyCohorts(db, { 'text-embedding-3-small': 3 });
      expect(assessment.tableExists).toBe(true);
      expect(assessment.totalRows).toBe(7);
      expect(assessment.eligibleRows).toBe(2);

      const [cohort] = assessment.cohorts;
      expect(cohort.provider).toBe('openai');
      expect(cohort.eligible).toBe(2);
      expect(cohort.ineligible).toBe(5);
      expect(cohort.ineligibleByReason).toEqual({
        'dimension-mismatch': 1,
        'unparsable-embedding': 1,
        'zero-norm-embedding': 1,
        'stale-source': 1,
        'unsupported-entity-type': 1,
      });
      // Mixed dimensions are surfaced, not hidden behind a single sample.
      expect(cohort.observedDimensions).toEqual([2, 3]);
    } finally {
      db.close();
    }
  });

  it('rejects embeddings containing non-finite members', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'b1', embedding: '[1, null, 0]' });
      insertLegacyRow(db, { id: 'b2', embedding: '[1, "x", 0]' });

      const assessment = assessLegacyCohorts(db, { 'text-embedding-3-small': 3 });
      expect(assessment.eligibleRows).toBe(0);
      expect(assessment.cohorts[0].ineligibleByReason).toEqual({ 'non-finite-embedding': 2 });
    } finally {
      db.close();
    }
  });

  it('separates cohorts by provider and model', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'c1', embedding: [1, 0, 0] });
      insertLegacyRow(db, { id: 'c2', embedding: [0, 1, 0] });
      insertLegacyRow(db, {
        id: 'c3', embedding: [1, 0], provider: 'azure', model: 'ada-002', entityType: 'alert',
      });

      const assessment = assessLegacyCohorts(db);
      expect(assessment.cohorts.map((cohort) => [cohort.provider, cohort.total])).toEqual([
        ['azure', 1],
        ['openai', 2],
      ]);
      // Each cohort is measured against its own dominant dimension count.
      expect(assessment.eligibleRows).toBe(3);
    } finally {
      db.close();
    }
  });

  it('maps legacy entity kinds onto the canonical entity types', () => {
    const row = {
      id: 'n1',
      entityType: 'notification',
      entityId: 'n1',
      embedding: '[1,0,0]',
      updatedAt: '2026-01-01',
      provider: 'openai',
      model: 'm',
      sourceSortAt: '2026-01-01',
    };
    const classified = classifyLegacyRow(row, { dimensions: 3 });
    expect('candidate' in classified).toBe(true);
    if ('candidate' in classified) {
      expect(classified.candidate.entityType).toBe('alert');
      expect(classified.candidate.norm).toBeCloseTo(1);
    }
  });

  it('iterates only fully-validated candidates, in stable id order, across batches', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'd1', embedding: [1, 0, 0] });
      insertLegacyRow(db, { id: 'd2', embedding: [0, 1] });
      insertLegacyRow(db, { id: 'd3', embedding: [0, 1, 0] });
      insertLegacyRow(db, { id: 'd4', embedding: [1, 0, 0], sourceSortAt: null });
      insertLegacyRow(db, { id: 'd5', embedding: [0, 0, 1] });
      insertLegacyRow(db, { id: 'd6', embedding: [1, 1, 1], provider: 'azure' });

      const candidates = [...iterateLegacyAdoptionCandidates(
        db,
        { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
        { batchSize: 2 },
      )];

      expect(candidates.map((candidate) => candidate.legacyId)).toEqual(['d1', 'd3', 'd5']);
      expect(candidates.every((candidate) => candidate.dimensions === 3)).toBe(true);
      expect(candidates.every((candidate) => candidate.sourceSortAt !== null)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('resumes iteration from a supplied cursor', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'e1', embedding: [1, 0, 0] });
      insertLegacyRow(db, { id: 'e2', embedding: [0, 1, 0] });
      insertLegacyRow(db, { id: 'e3', embedding: [0, 0, 1] });

      const candidates = [...iterateLegacyAdoptionCandidates(
        db,
        { provider: 'openai', model: 'text-embedding-3-small', dimensions: 3 },
        { after: 'e1' },
      )];
      expect(candidates.map((candidate) => candidate.legacyId)).toEqual(['e2', 'e3']);
    } finally {
      db.close();
    }
  });

  it('never mutates the legacy table', () => {
    const db = new Database(':memory:');
    try {
      createLegacyTable(db);
      insertLegacyRow(db, { id: 'f1', embedding: [1, 0, 0] });
      insertLegacyRow(db, { id: 'f2', embedding: [0, 1] });

      assessLegacyCohorts(db, { 'text-embedding-3-small': 3 });
      const drained = [...iterateLegacyAdoptionCandidates(db, {
        provider: 'openai', model: 'text-embedding-3-small', dimensions: 3,
      })];
      expect(drained.map((candidate) => candidate.legacyId)).toEqual(['f1']);

      expect(
        db.prepare('SELECT COUNT(*) AS count FROM search_embeddings').get(),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  });
});
