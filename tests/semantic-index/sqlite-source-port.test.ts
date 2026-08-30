import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteSemanticSourcePort } from '@/lib/semantic-index/source/sqlite-source-port';
import { projectSource } from '@/lib/semantic-index/projections';

/**
 * Minimal authoritative-source schema. It carries exactly the columns the port
 * projects, which is what the PostgreSQL adapter reads too; if either adapter
 * drifts from this column set, its query fails loudly rather than silently
 * changing a projection.
 */
const SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL,
    status_reason TEXT,
    micro_status TEXT,
    priority TEXT NOT NULL,
    planning_horizon TEXT,
    local_disposition TEXT NOT NULL,
    effort INTEGER,
    due_date TEXT,
    connector_type TEXT NOT NULL,
    connector_instance_id TEXT NOT NULL DEFAULT 'local',
    source_list_name TEXT,
    parent_id TEXT,
    is_checklist_item INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE TABLE tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'hub',
    source TEXT,
    confirmed INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT '2026-08-01T00:00:00.000Z',
    unified_into TEXT
  );
  CREATE TABLE task_tags (
    task_id TEXT NOT NULL,
    tag_id TEXT NOT NULL
  );
  CREATE TABLE hub_projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    status_override TEXT,
    hidden INTEGER NOT NULL DEFAULT 0,
    category TEXT,
    target_date TEXT,
    started_at TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE project_tags (project_id TEXT NOT NULL, tag_id TEXT NOT NULL);
  CREATE TABLE task_projects (task_id TEXT NOT NULL, project_id TEXT NOT NULL);
  CREATE TABLE triage_items (
    id TEXT PRIMARY KEY,
    source_platform TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    content_type TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    ingested_at TEXT NOT NULL,
    status TEXT NOT NULL,
    snoozed_until TEXT,
    ai_summary TEXT,
    ai_categories TEXT NOT NULL DEFAULT '[]',
    ai_relevance_score INTEGER NOT NULL DEFAULT 0,
    ai_urgency TEXT NOT NULL DEFAULT 'evergreen'
  );
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL,
    category TEXT NOT NULL,
    state TEXT NOT NULL,
    read_state TEXT NOT NULL,
    disposition TEXT NOT NULL,
    source_state TEXT NOT NULL,
    connector_type TEXT NOT NULL,
    is_actionable INTEGER NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    sort_at TEXT NOT NULL,
    expires_at TEXT,
    last_source_activity_at TEXT,
    read_at TEXT,
    handled_at TEXT,
    resolved_at TEXT,
    archived_at TEXT,
    dismissed_at TEXT,
    related_task_id TEXT,
    related_project_id TEXT
  );
`;

describe('SqliteSemanticSourcePort', () => {
  let db: Database.Database;
  let port: SqliteSemanticSourcePort;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA);
    port = new SqliteSemanticSourcePort(db);

    const insertTask = db.prepare(`
      INSERT INTO tasks (
        id, title, description, status, status_reason, micro_status, priority,
        planning_horizon, local_disposition, effort, due_date, connector_type,
        source_list_name, parent_id, is_checklist_item, created_at, updated_at,
        completed_at
      ) VALUES (?, ?, ?, 'todo', NULL, NULL, 'none', NULL, 'active', NULL, NULL,
                'github-issues', NULL, NULL, 0, '2026-08-01T00:00:00.000Z',
                '2026-08-02T00:00:00.000Z', NULL)
    `);
    for (const id of ['task-1', 'task-2', 'task-3']) {
      insertTask.run(id, `Title ${id}`, `Body ${id}`);
    }
    db.prepare("INSERT INTO tags (id, name) VALUES ('tag-1', 'Platform')").run();
    db.prepare("INSERT INTO tags (id, name) VALUES ('tag-2', 'Search')").run();
    db.prepare("INSERT INTO task_tags (task_id, tag_id) VALUES ('task-1', 'tag-1')").run();
    db.prepare("INSERT INTO task_tags (task_id, tag_id) VALUES ('task-1', 'tag-2')").run();
    db.prepare(`
      INSERT INTO hub_projects (
        id, name, description, category, created_at, updated_at
      ) VALUES (
        'project-1', 'Semantic platform', 'Build retrieval', 'engineering',
        '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z'
      )
    `).run();
    db.prepare("INSERT INTO task_projects VALUES ('task-1', 'project-1')").run();
    db.prepare("INSERT INTO project_tags VALUES ('project-1', 'tag-1')").run();
    db.prepare(`
      INSERT INTO triage_items (
        id, source_platform, title, description, content_type, captured_at,
        ingested_at, status, ai_summary, ai_categories
      ) VALUES (
        'triage-1', 'github', 'Vector research', 'Compare indexes', 'repo',
        '2026-08-01T00:00:00.000Z', '2026-08-20T00:00:00.000Z', 'pending',
        'Candidate libraries', '["software-development"]'
      )
    `).run();

    db.prepare(`
      INSERT INTO notifications (
        id, title, body, level, category, state, read_state, disposition,
        source_state, connector_type, is_actionable, received_at, sort_at,
        expires_at, last_source_activity_at, read_at, handled_at, resolved_at,
        archived_at, dismissed_at, related_task_id, related_project_id
      ) VALUES ('alert-1', 'Sync failed', 'Upstream unreachable', 'critical',
                'sync', 'unread', 'unread', 'inbox', 'active', 'microsoft-todo',
                1, '2026-08-20T00:00:00.000Z', '2026-08-20T00:00:00.000Z',
                '2026-12-01T00:00:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL,
                'task-1', NULL)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('reads a task with its tags', async () => {
    const record = await port.get('task', 'task-1');
    expect(record).toMatchObject({
      entityType: 'task',
      id: 'task-1',
      title: 'Title task-1',
      description: 'Body task-1',
      connectorType: 'github-issues',
      isChecklistItem: false,
    });
    expect((record as { tags: string[] }).tags.sort()).toEqual(['Platform', 'Search']);
    expect((record as { projects: string[] }).projects).toEqual(['Semantic platform']);
  });

  it('reads project, canonical tag, and triage sources with bounded context', async () => {
    await expect(port.get('project', 'project-1')).resolves.toMatchObject({
      entityType: 'project',
      tags: ['Platform'],
      representativeTasks: ['Title task-1'],
      taskCount: 1,
    });
    await expect(port.get('tag', 'tag-1')).resolves.toMatchObject({
      entityType: 'tag',
      representativeTasks: ['Title task-1'],
      usageCount: 1,
    });
    await expect(port.get('triage-item', 'triage-1')).resolves.toMatchObject({
      entityType: 'triage-item',
      aiCategories: ['software-development'],
    });
  });

  it('returns ineligible records by id but excludes them from scans', async () => {
    db.prepare("UPDATE hub_projects SET hidden = 1 WHERE id = 'project-1'").run();
    db.prepare("UPDATE tags SET unified_into = 'tag-2' WHERE id = 'tag-1'").run();
    db.prepare("UPDATE tags SET confirmed = 0 WHERE id = 'tag-2'").run();
    db.prepare("UPDATE triage_items SET status = 'dismissed' WHERE id = 'triage-1'").run();
    db.prepare("UPDATE notifications SET source_state = 'stale' WHERE id = 'alert-1'").run();
    expect(await port.get('project', 'project-1')).toMatchObject({ semanticEligible: false });
    expect(await port.get('tag', 'tag-1')).toMatchObject({ semanticEligible: false });
    expect(await port.get('triage-item', 'triage-1')).toMatchObject({ semanticEligible: false });
    expect(await port.get('alert', 'alert-1')).toMatchObject({ semanticEligible: false });
    expect((await port.listIds('project', { limit: 10 })).ids).toEqual([]);
    expect((await port.listIds('tag', { limit: 10 })).ids).toEqual([]);
  });

  it('reads an alert with its coerced booleans', async () => {
    const record = await port.get('alert', 'alert-1');
    expect(record).toMatchObject({
      entityType: 'alert',
      id: 'alert-1',
      isActionable: true,
      expiresAt: '2026-12-01T00:00:00.000Z',
      relatedTaskId: 'task-1',
    });
  });

  it('returns null for an unknown entity instead of throwing', async () => {
    expect(await port.get('task', 'nope')).toBeNull();
    expect(await port.get('alert', 'nope')).toBeNull();
  });

  it('paginates ids by a stable, exclusive id cursor', async () => {
    const first = await port.listIds('task', { limit: 2 });
    expect(first).toEqual({ ids: ['task-1', 'task-2'], nextCursor: 'task-2' });

    const second = await port.listIds('task', { afterId: first.nextCursor, limit: 2 });
    expect(second).toEqual({ ids: ['task-3'], nextCursor: null });
  });

  it('paginates full records with one tag read per page', async () => {
    const page = await port.list('task', { limit: 3 });
    expect(page.records.map((record) => record.id)).toEqual(['task-1', 'task-2', 'task-3']);
    expect(page.nextCursor).toBe('task-3');
    const [first] = page.records;
    expect((first as { tags: string[] }).tags.sort()).toEqual(['Platform', 'Search']);
    expect((page.records[1] as { tags: string[] }).tags).toEqual([]);
  });

  it('returns identical records from get and list', async () => {
    const [listed] = (await port.list('task', { limit: 1 })).records;
    const fetched = await port.get('task', 'task-1');
    const options = { resolveSensitivity: () => 'standard' as const };
    expect(projectSource(listed, options)).toEqual(projectSource(fetched!, options));
  });

  it('reports which of a bounded id batch still exist', async () => {
    const existing = await port.listExisting('task', ['task-1', 'task-9', 'task-3']);
    expect([...existing].sort()).toEqual(['task-1', 'task-3']);
    expect(await port.listExisting('task', [])).toEqual(new Set());
  });

  it('lists alerts from the notifications table', async () => {
    const page = await port.list('alert', { limit: 10 });
    expect(page.records).toHaveLength(1);
    expect(page.records[0]).toMatchObject({ entityType: 'alert', id: 'alert-1' });
    expect(page.nextCursor).toBeNull();
  });

  it('bounds a hostile page size instead of scanning the table', async () => {
    const page = await port.listIds('task', { limit: Number.MAX_SAFE_INTEGER });
    expect(page.ids).toHaveLength(3);
    expect((await port.listIds('task', { limit: 0 })).ids).toHaveLength(1);
  });
});
