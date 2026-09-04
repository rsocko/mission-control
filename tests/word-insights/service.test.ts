import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MAX_VALUES_PER_SOURCE_PER_TASK } from '@/lib/word-insights/extract';
import type { AnalyticsPersistence } from '@/db/persistence/analytics';

const databasePath = path.join(os.tmpdir(), `mission-control-word-insights-${randomUUID()}.db`);

/**
 * The service now selects its backend through the composed worker persistence
 * facade, so this suite publishes the SQLite analytics adapter over the same
 * temporary database it seeds. The SQL under test is unchanged.
 */
const composition = vi.hoisted(() => ({ analytics: null as AnalyticsPersistence | null }));

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => {
    if (!composition.analytics) throw new Error('Analytics persistence is not registered');
    return { analytics: composition.analytics };
  },
}));

beforeAll(async () => {
  process.env.MC_DB_PATH = databasePath;
  vi.doUnmock('drizzle-orm');
  vi.resetModules();
  const { sqlite, default: db } = await import('@/db');
  const { createSqliteAnalyticsPersistence } = await import(
    '@/db/persistence/sqlite-analytics-repositories'
  );
  composition.analytics = createSqliteAnalyticsPersistence(db);
  const now = '2026-07-31T00:00:00.000Z';
  const insertConnector = sqlite.prepare(`
    INSERT INTO connector_configs
      (id, type, name, enabled, sync_mode, capabilities, credentials, settings, synced_lists, created_at, updated_at, deleted_at)
    VALUES (?, 'local', ?, 1, 'poll', '{}', '{}', '{}', '[]', ?, ?, ?)
  `);
  insertConnector.run('active-connector', 'Active', now, now, null);
  insertConnector.run('deleted-connector', 'Deleted', now, now, now);

  const insertTask = sqlite.prepare(`
    INSERT INTO tasks
      (id, source_id, connector_type, connector_instance_id, title, description, status, priority, created_at, updated_at, metadata, sync_status, last_synced_at)
    VALUES (?, ?, 'local', ?, ?, ?, 'todo', 'none', ?, ?, '{}', 'synced', ?)
  `);
  insertTask.run('task-a', 'task-a', 'active-connector', 'Alpha gateway', 'Alpha notes', now, now, now);
  insertTask.run('task-b', 'task-b', 'active-connector', 'Beta gateway', null, now, now, now);
  insertTask.run('task-c', 'task-c', 'active-connector', 'Gamma gateway', null, now, now, now);
  insertTask.run('task-deleted', 'task-deleted', 'deleted-connector', 'Deleted secret', null, now, now, now);

  const insertTag = sqlite.prepare(`
    INSERT INTO tags (id, name, slug, type, confirmed, created_at)
    VALUES (?, ?, ?, 'hub', 1, ?)
  `);
  const insertTaskTag = sqlite.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)');
  for (let index = 0; index < MAX_VALUES_PER_SOURCE_PER_TASK + 2; index += 1) {
    const suffix = String(index).padStart(2, '0');
    insertTag.run(`tag-${suffix}`, `Tagword${suffix}`, `tagword${suffix}`, now);
    insertTaskTag.run('task-a', `tag-${suffix}`);
  }

  sqlite.prepare(`
    INSERT INTO hub_projects
      (id, name, color, source_bindings, auto_include_rules, kanban_columns, default_view, status, hidden, sort_order, metadata, created_at, updated_at)
    VALUES ('project-a', 'Gateway Migration', '#3b82f6', '[]', '[]', '[]', 'list', 'active', 0, 0, '{}', ?, ?)
  `).run(now, now);
  sqlite.prepare("INSERT INTO task_projects (task_id, project_id) VALUES ('task-a', 'project-a')").run();
  sqlite.prepare(`
    INSERT INTO project_phases (id, project_id, name, status, sort_order, created_at, updated_at)
    VALUES ('phase-a', 'project-a', 'Production Rollout', 'pending', 0, ?, ?)
  `).run(now, now);
  sqlite.prepare(`
    INSERT INTO project_phase_items (id, phase_id, task_id, sort_order, is_proposed, created_at)
    VALUES ('phase-item-a', 'phase-a', 'task-a', 0, 0, ?)
  `).run(now);
});

afterAll(async () => {
  const { sqlite } = await import('@/db');
  sqlite.close();
  delete process.env.MC_DB_PATH;
});

describe('getWordInsights', () => {
  it('projects bounded relationships and excludes soft-deleted connector tasks', async () => {
    const { getWordInsights } = await import('@/lib/word-insights/service');
    const result = await getWordInsights({
      enabledSources: ['title', 'notes', 'tag', 'project', 'phase'],
      taskLimit: 2,
      wordLimit: 50,
    });

    expect(result.analyzedTaskCount).toBe(2);
    expect(result.truncated).toBe(true);
    expect(result.tasks.map((task) => task.id)).toEqual(['task-a', 'task-b']);
    expect(result.words.some((word) => word.text === 'deleted')).toBe(false);
    expect(result.words.some((word) => word.text === 'migration')).toBe(true);
    expect(result.words.some((word) => word.text === 'production')).toBe(true);
    expect(result.words.some((word) => word.text === 'tagword31')).toBe(true);
    expect(result.words.some((word) => word.text === 'tagword32')).toBe(false);
    expect(result.words.some((word) => word.text === 'tagword33')).toBe(false);
  });

  it('does not query disabled relationship sources into the projection', async () => {
    const { getWordInsights } = await import('@/lib/word-insights/service');
    const result = await getWordInsights({
      enabledSources: ['title'],
      taskLimit: 10,
      wordLimit: 50,
    });

    expect(result.words.map((word) => word.text)).toEqual([
      'gateway',
      'alpha',
      'beta',
      'gamma',
    ]);
    expect(result.words.every((word) => Object.keys(word.sources).join() === 'title')).toBe(true);
  });
});
