import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

describe('attribution write-back migrations', () => {
  it('preserves an existing manual audit and queues its first durable receipt on upgrade', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.exec(`
        CREATE TABLE finance_attribution_audit (
          id text PRIMARY KEY, connector_id text NOT NULL, created_at text NOT NULL,
          requested_kid_id text, requested_decision text
        );
        INSERT INTO finance_attribution_audit VALUES (
          'old-audit', 'synthetic-connector', '2026-10-20T12:00:00.000Z', 'kid-one', 'assign-kid'
        );
      `);
      sqlite.exec(readFileSync(join('drizzle', '0159_finance_attribution_writeback.sql'), 'utf8'));
      expect(sqlite.prepare('SELECT * FROM finance_attribution_audit').get()).toEqual({
        id: 'old-audit', connector_id: 'synthetic-connector', created_at: '2026-10-20T12:00:00.000Z',
        requested_kid_id: 'kid-one', requested_decision: 'assign-kid',
        writeback_status: 'pending', writeback_request: null, writeback_error_code: null,
        writeback_updated_at: null,
      });
    } finally {
      sqlite.close();
    }
  });

  it('registers additive, matching SQLite and Postgres migrations', () => {
    const sqlite = readFileSync(join('drizzle', '0159_finance_attribution_writeback.sql'), 'utf8');
    const postgres = readFileSync(join('drizzle', 'postgres', '0037_finance_attribution_writeback.sql'), 'utf8');
    expect(postgres).toBe(sqlite);
    for (const [path, index, tag] of [
      [join('drizzle', 'meta', '_journal.json'), 159, '0159_finance_attribution_writeback'],
      [join('drizzle', 'postgres', 'meta', '_journal.json'), 37, '0037_finance_attribution_writeback'],
    ] as const) {
      const journal = JSON.parse(readFileSync(path, 'utf8'));
      expect(journal.entries[index]).toMatchObject({ idx: index, tag });
    }
  });
});
