import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { TASK_REFERENCE_COLUMN_POLICIES } from '@/lib/tasks/task-reference-repoint';

describe('task reference inventory', () => {
  const dbPath = join(process.cwd(), 'data', `task-reference-inventory-${process.pid}-${Date.now()}.db`);
  const originalDbPath = process.env.MC_DB_PATH;
  let sqlite: Database.Database;

  beforeAll(async () => {
    process.env.MC_DB_PATH = dbPath;
    vi.resetModules();
    ({ sqlite } = await import('@/db'));
  });

  afterAll(() => {
    sqlite.close();
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${dbPath}${suffix}`;
      if (existsSync(file)) rmSync(file);
    }
    if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDbPath;
  });

  it('classifies every task-like relational column in the initialized schema', () => {
    const discovered = sqlite.prepare(`
      SELECT m.name || '.' || p.name AS reference
      FROM sqlite_master m
      JOIN pragma_table_info(m.name) p
      WHERE m.type = 'table'
        AND (
          lower(p.name) LIKE '%task%id%'
          OR (m.name = 'tasks' AND p.name = 'parent_id')
        )
      ORDER BY reference
    `).all() as Array<{ reference: string }>;

    expect(discovered.map(({ reference }) => reference)).toEqual(
      Object.keys(TASK_REFERENCE_COLUMN_POLICIES).sort(),
    );
  });
});
