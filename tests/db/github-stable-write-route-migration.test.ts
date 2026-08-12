import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('GitHub stable write route migration', () => {
  it('adds a stable-capable route without rewriting an existing lease', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE task_source_write_leases (
        id text PRIMARY KEY NOT NULL,
        route text DEFAULT 'legacy' NOT NULL,
        state text DEFAULT 'claimed' NOT NULL,
        CONSTRAINT task_source_write_leases_route_check CHECK(route = 'legacy')
      );
      INSERT INTO task_source_write_leases (id, route, state)
      VALUES ('lease-before-stage-3', 'legacy', 'unknown');
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0078_github_stable_write_route.sql'),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      if (statement.trim()) sqlite.exec(statement);
    }

    expect(sqlite.prepare(`
      SELECT id, route, identity_route AS identityRoute, state
      FROM task_source_write_leases
    `).get()).toEqual({
      id: 'lease-before-stage-3',
      route: 'legacy',
      identityRoute: 'legacy',
      state: 'unknown',
    });
    sqlite.prepare(`
      UPDATE task_source_write_leases SET identity_route = 'stable'
      WHERE id = 'lease-before-stage-3'
    `).run();
    expect(sqlite.prepare(`
      SELECT identity_route AS identityRoute
      FROM task_source_write_leases
    `).get()).toEqual({ identityRoute: 'stable' });
    expect(() => sqlite.prepare(`
      UPDATE task_source_write_leases SET identity_route = 'invalid'
    `).run()).toThrow();
    sqlite.close();
  });
});
