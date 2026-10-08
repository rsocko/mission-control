import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

const sqliteMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/0137_recurrence_backfill_decisions.sql'),
  'utf8',
);
const postgresMigration = readFileSync(
  resolve(process.cwd(), 'drizzle/postgres/0013_recurrence_backfill_decisions.sql'),
  'utf8',
);

describe('recurrence backfill decision migration', () => {
  it('is idempotent on SQLite and rejects invalid decisions', () => {
    const sqlite = new Database(':memory:');
    for (let replay = 0; replay < 2; replay += 1) {
      for (const statement of sqliteMigration.split('--> statement-breakpoint')) {
        if (statement.trim()) sqlite.exec(statement);
      }
    }
    expect(() => sqlite.prepare(`
      INSERT INTO task_recurrence_backfill_decisions (
        occurrence_id, series_id, rule_revision_id, effective_kind, effective_value,
        decision, reason, decided_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'occurrence',
      'series',
      'revision',
      'local-date',
      '2026-08-10',
      'invalid',
      'invalid',
      '2026-08-10T00:00:00.000Z',
    )).toThrow();
    sqlite.close();
  });

  it('keeps SQLite and PostgreSQL decision ledgers structurally aligned', () => {
    for (const migration of [sqliteMigration, postgresMigration]) {
      expect(migration).toContain('CREATE TABLE IF NOT EXISTS');
      expect(migration).toContain('task_recurrence_backfill_decisions');
      expect(migration).toContain('occurrence_id');
      expect(migration).toContain('superseded_by_occurrence_id');
      expect(migration).toContain('connector-owned-missing');
      expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    }
  });
});
