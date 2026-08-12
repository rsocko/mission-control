import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { _runMigrationsIndividually } from '@/db';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const openDatabases: Database.Database[] = [];

function createPriorMainDatabase() {
  const sqlite = new Database(':memory:');
  openDatabases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE hub_projects (
      id text PRIMARY KEY NOT NULL
    );
    CREATE TABLE project_phases (
      id text PRIMARY KEY NOT NULL,
      project_id text,
      sort_order integer DEFAULT 0 NOT NULL
    );
    CREATE TABLE project_phase_items (
      id text PRIMARY KEY NOT NULL,
      phase_id text NOT NULL,
      task_id text NOT NULL,
      sort_order integer DEFAULT 0 NOT NULL
    );
    CREATE TABLE task_projects (
      task_id text NOT NULL,
      project_id text NOT NULL
    );
  `);
  return sqlite;
}

function applyHierarchyMigration(sqlite: Database.Database) {
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0032_project_hierarchy_commands.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
}

afterEach(() => {
  for (const sqlite of openDatabases.splice(0)) sqlite.close();
});

describe('project hierarchy command migration', () => {
  it('applies on a clean database through the application migration runner', () => {
    const sqlite = new Database(':memory:');
    openDatabases.push(sqlite);

    _runMigrationsIndividually(sqlite, resolve(process.cwd(), 'drizzle'));

    expect(sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'project_hierarchy_commands'
    `).get()).toEqual({ name: 'project_hierarchy_commands' });
    expect(sqlite.prepare(`
      SELECT count(*) AS count
      FROM __drizzle_migrations
      WHERE created_at = 1785512700000
    `).get()).toEqual({ count: 1 });
  });

  it('upgrades the prior-main schema while preserving one canonical phase placement', () => {
    const sqlite = createPriorMainDatabase();
    sqlite.exec(`
      INSERT INTO hub_projects (id) VALUES ('project-1');
      INSERT INTO project_phases (id, project_id, sort_order)
      VALUES ('phase-1', 'project-1', 0), ('phase-2', 'project-1', 1);
      INSERT INTO task_projects (task_id, project_id)
      VALUES ('task-1', 'project-1');
      INSERT INTO project_phase_items (id, phase_id, task_id, sort_order)
      VALUES
        ('item-1', 'phase-1', 'task-1', 0),
        ('item-2', 'phase-2', 'task-1', 0);
    `);

    applyHierarchyMigration(sqlite);

    expect(sqlite.prepare(`
      SELECT hierarchy_revision AS revision
      FROM hub_projects
      WHERE id = 'project-1'
    `).get()).toEqual({ revision: 0 });
    expect(sqlite.prepare(`
      SELECT id, phase_id AS phaseId
      FROM project_phase_items
      WHERE task_id = 'task-1'
    `).all()).toEqual([{ id: 'item-1', phaseId: 'phase-1' }]);
    expect(sqlite.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'project_phase_items_one_phase_per_project_insert'
    `).get()).toEqual({ name: 'project_phase_items_one_phase_per_project_insert' });
  });
});
