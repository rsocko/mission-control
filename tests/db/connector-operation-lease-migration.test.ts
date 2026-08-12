import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('connector operation lease migration', () => {
  it('records the connector lease table in Drizzle snapshot metadata', () => {
    const snapshot = JSON.parse(
      readFileSync(resolve(process.cwd(), 'drizzle/meta/0048_snapshot.json'), 'utf8'),
    ) as { tables: Record<string, unknown> };

    expect(snapshot.tables).toMatchObject({
      connector_operation_leases: expect.any(Object),
    });
  });

  it('creates one recoverable lease row per connector', () => {
    const sqlite = new Database(':memory:');
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0048_redundant_masque.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    const insert = sqlite.prepare(`
      INSERT INTO connector_operation_leases (
        connector_id, operation_type, owner, lease_expires_at, created_at, updated_at
      ) VALUES ('github-1', 'retention', ?, '2026-08-04', '2026-08-03', '2026-08-03')
    `);
    insert.run('web-1');
    expect(() => insert.run('worker-1')).toThrow();
    expect(sqlite.prepare(`
      SELECT owner FROM connector_operation_leases WHERE connector_id = 'github-1'
    `).get()).toEqual({ owner: 'web-1' });
    sqlite.close();
  });
});
