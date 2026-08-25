import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('planning horizon values migration', () => {
  it('moves immediate and near-term tasks to next and soon without collisions', () => {
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        planning_horizon TEXT
      );
      CREATE TABLE task_history_events (
        id INTEGER PRIMARY KEY,
        field_name TEXT,
        previous_value TEXT,
        new_value TEXT
      );
      CREATE TABLE quick_sort_operations (
        id TEXT PRIMARY KEY,
        before_snapshot TEXT NOT NULL,
        after_snapshot TEXT NOT NULL
      );
      INSERT INTO tasks (id, planning_horizon) VALUES
        ('immediate', 'now'),
        ('near-term', 'next'),
        ('later', 'later'),
        ('someday', 'someday'),
        ('unset', NULL);
      INSERT INTO task_history_events (id, field_name, previous_value, new_value) VALUES
        (1, 'planningHorizon', 'now', 'next'),
        (2, 'priority', 'now', 'next');
      INSERT INTO quick_sort_operations (id, before_snapshot, after_snapshot) VALUES
        (
          'operation',
          '{"planningHorizon":"now","originalPatch":{"planningHorizon":"next"}}',
          '{"planningHorizon":"next"}'
        );
    `);
    const migration = readFileSync(
      resolve(process.cwd(), 'drizzle/0119_replace_now_horizon_with_soon.sql'),
      'utf8',
    );

    sqlite.exec(migration);

    expect(sqlite.prepare(
      'SELECT id, planning_horizon FROM tasks ORDER BY id',
    ).all()).toEqual([
      { id: 'immediate', planning_horizon: 'next' },
      { id: 'later', planning_horizon: 'later' },
      { id: 'near-term', planning_horizon: 'soon' },
      { id: 'someday', planning_horizon: 'someday' },
      { id: 'unset', planning_horizon: null },
    ]);
    expect(sqlite.prepare(
      'SELECT field_name, previous_value, new_value FROM task_history_events ORDER BY id',
    ).all()).toEqual([
      { field_name: 'planningHorizon', previous_value: 'next', new_value: 'soon' },
      { field_name: 'priority', previous_value: 'now', new_value: 'next' },
    ]);
    const operation = sqlite.prepare(
      'SELECT before_snapshot, after_snapshot FROM quick_sort_operations',
    ).get() as { before_snapshot: string; after_snapshot: string };
    expect(JSON.parse(operation.before_snapshot)).toEqual({
      planningHorizon: 'next',
      originalPatch: { planningHorizon: 'soon' },
    });
    expect(JSON.parse(operation.after_snapshot)).toEqual({
      planningHorizon: 'soon',
    });
    sqlite.close();
  });
});
