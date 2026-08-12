import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('finance attention routing scan migration', () => {
  it('indexes both deterministic source scans', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE finance_attribution_exceptions (
        id TEXT PRIMARY KEY NOT NULL,
        connector_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE finance_mutation_audit (
        id TEXT PRIMARY KEY NOT NULL,
        connector_id TEXT NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0097_finance-attention-routing-scan.sql'),
      'utf8',
    );
    sqlite.exec(migration);

    const attributionPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM finance_attribution_exceptions
      WHERE connector_id = ? AND (updated_at, id) > (?, ?)
      ORDER BY updated_at, id
      LIMIT ?
    `).all('finance-1', '2026-01-01', 'cursor', 500);
    const mutationPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM finance_mutation_audit
      WHERE connector_id = ? AND (updated_at, id) > (?, ?)
        AND status IN ('pending', 'processing', 'succeeded', 'failed')
      ORDER BY updated_at, id
      LIMIT ?
    `).all('finance-1', '2026-01-01', 'cursor', 500);

    const attributionDetail = attributionPlan
      .map((row) => String((row as { detail: string }).detail))
      .join(' ');
    const mutationDetail = mutationPlan
      .map((row) => String((row as { detail: string }).detail))
      .join(' ');
    expect(attributionDetail).toContain('idx_finance_attribution_attention_scan');
    expect(attributionDetail).toContain('(updated_at,id)>(?,?)');
    expect(mutationDetail).toContain('idx_finance_mutation_attention_scan');
    expect(mutationDetail).toContain('(updated_at,id)>(?,?)');
    sqlite.close();
  });
});
