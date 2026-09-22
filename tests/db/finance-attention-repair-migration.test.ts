import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function migration(name: string): string {
  return readFileSync(resolve(process.cwd(), `drizzle/${name}.sql`), 'utf8')
    .replaceAll('--> statement-breakpoint', '');
}

describe('finance attention repair migration', () => {
  it('applies after finance connection recovery without schema overlap', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(migration('0112_finance_connection_recovery'));
    sqlite.exec(migration('0113_finance_attention_repair'));

    const tables = sqlite.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all() as Array<{ name: string }>;
    expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining([
      'finance_connection_outages',
      'finance_attention_repair_audit',
    ]));

    const indexes = sqlite.prepare(`
      PRAGMA index_list(finance_attention_repair_audit)
    `).all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'idx_finance_attention_repair_idempotency',
      'idx_finance_attention_repair_connector',
    ]));
    sqlite.close();
  });

  it('records the audit table in the latest Drizzle snapshot', () => {
    const snapshot = JSON.parse(readFileSync(
      resolve(process.cwd(), 'drizzle/meta/0113_snapshot.json'),
      'utf8',
    )) as { tables: Record<string, unknown> };

    expect(snapshot.tables).toHaveProperty('finance_connection_outages');
    expect(snapshot.tables).toHaveProperty('finance_attention_repair_audit');
  });
});
