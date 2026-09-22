import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { PostgresSemanticSourcePort } from '@/db/postgres/semantic-index/source-port';

/**
 * Asserts that the PostgreSQL source port issues the same shape of query as its
 * SQLite twin: same columns, same ascending keyset ordering, one tag read per
 * page, and a bounded limit.
 */
interface MockPool {
  pool: Pool;
  statements: string[];
  params: unknown[][];
  sql(): string[];
  find(pattern: RegExp): string | undefined;
}

function createMockPool(rowsByPattern: Array<{ match: RegExp; rows: unknown[] }> = []): MockPool {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const query = async (text: string, values: unknown[] = []) => {
    statements.push(text);
    params.push(values);
    for (const handler of rowsByPattern) {
      if (handler.match.test(text)) return { rows: handler.rows, rowCount: handler.rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  const pool = { query } as unknown as Pool;
  return {
    pool,
    statements,
    params,
    sql: () => statements.map((statement) => statement.replace(/\s+/g, ' ').trim()),
    find(pattern) {
      return this.sql().find((statement) => pattern.test(statement));
    },
  };
}

const TASK_ROW = {
  id: 'task-1',
  title: 'Title',
  description: 'Body',
  status: 'todo',
  statusReason: null,
  microStatus: null,
  priority: 'none',
  planningHorizon: null,
  localDisposition: 'active',
  effort: null,
  dueDate: null,
  connectorType: 'github-issues',
  sourceListName: null,
  parentId: null,
  isChecklistItem: false,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
  completedAt: null,
};

const ALERT_ROW = {
  id: 'alert-1',
  title: 'Sync failed',
  body: null,
  level: 'critical',
  category: 'sync',
  state: 'unread',
  readState: 'unread',
  disposition: 'inbox',
  sourceState: 'active',
  connectorType: 'microsoft-todo',
  isActionable: true,
  receivedAt: '2026-08-20T00:00:00.000Z',
  sortAt: '2026-08-20T00:00:00.000Z',
  expiresAt: null,
  lastSourceActivityAt: null,
  readAt: null,
  handledAt: null,
  resolvedAt: null,
  archivedAt: null,
  dismissedAt: null,
  relatedTaskId: null,
  relatedProjectId: null,
};

const PROJECT_ROW = {
  id: 'project-1',
  name: 'Semantic platform',
  description: 'Build retrieval',
  status: 'active',
  statusOverride: null,
  hidden: false,
  category: 'engineering',
  targetDate: null,
  startedAt: null,
  completedAt: null,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
};

const TAG_ROW = {
  id: 'tag-1',
  name: 'Platform',
  slug: 'platform',
  type: 'hub',
  source: null,
  confirmed: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  unifiedInto: null,
};

describe('PostgresSemanticSourcePort', () => {
  it('reads a task and joins its tags', async () => {
    const mock = createMockPool([
      { match: /FROM tasks WHERE id = \$1/, rows: [TASK_ROW] },
      { match: /FROM task_tags/, rows: [{ name: 'Platform' }] },
      { match: /FROM task_projects/, rows: [{ name: 'Semantic platform' }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);

    const record = await port.get('task', 'task-1');
    expect(record).toMatchObject({
      entityType: 'task',
      id: 'task-1',
      isChecklistItem: false,
      tags: ['Platform'],
      projects: ['Semantic platform'],
    });
  });

  it('coerces alert booleans and returns null for a missing row', async () => {
    const mock = createMockPool([
      { match: /FROM notifications\s+WHERE id = \$1/, rows: [{ ...ALERT_ROW, isActionable: 1 }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);
    expect(await port.get('alert', 'alert-1')).toMatchObject({
      entityType: 'alert', isActionable: true,
    });

    const empty = createMockPool();
    expect(await new PostgresSemanticSourcePort(empty.pool).get('alert', 'nope')).toBeNull();
  });

  it('pages ids with an exclusive ascending keyset cursor', async () => {
    const mock = createMockPool([
      { match: /SELECT id FROM tasks/, rows: [{ id: 'task-1' }, { id: 'task-2' }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);

    const page = await port.listIds('task', { afterId: 'task-0', limit: 2 });
    expect(page).toEqual({ ids: ['task-1', 'task-2'], nextCursor: 'task-2' });
    expect(mock.find(/SELECT id FROM tasks/))
      .toContain('WHERE id > $1 AND TRUE ORDER BY id ASC LIMIT $2');
    expect(mock.params[0]).toEqual(['task-0', 2]);
  });

  it('reads project, tag, and triage records through backend-equivalent queries', async () => {
    const projectMock = createMockPool([
      { match: /FROM hub_projects WHERE id = \$1/, rows: [PROJECT_ROW] },
      { match: /FROM project_tags/, rows: [{ projectId: 'project-1', name: 'Platform' }] },
      { match: /representatives WHERE row_number/, rows: [{ projectId: 'project-1', title: 'Task' }] },
      { match: /COUNT\(\*\)[\s\S]*task_projects/, rows: [{ projectId: 'project-1', count: 1, latest: null }] },
    ]);
    await expect(new PostgresSemanticSourcePort(projectMock.pool).get('project', 'project-1'))
      .resolves.toMatchObject({
        entityType: 'project', tags: ['Platform'], representativeTasks: ['Task'], taskCount: 1,
      });

    const tagMock = createMockPool([
      { match: /FROM tags\s+WHERE id = \$1/, rows: [TAG_ROW] },
      { match: /representatives WHERE row_number/, rows: [{ tagId: 'tag-1', title: 'Task' }] },
      { match: /COUNT\(\*\)[\s\S]*task_tags/, rows: [{ tagId: 'tag-1', count: 1, latest: null }] },
    ]);
    await expect(new PostgresSemanticSourcePort(tagMock.pool).get('tag', 'tag-1'))
      .resolves.toMatchObject({
        entityType: 'tag', representativeTasks: ['Task'], usageCount: 1,
      });

    const triageMock = createMockPool([
      {
        match: /FROM triage_items WHERE id = \$1/,
        rows: [{
          id: 'triage-1',
          sourcePlatform: 'github',
          title: 'Research',
          description: null,
          contentType: 'repo',
          capturedAt: '2026-08-01T00:00:00.000Z',
          ingestedAt: '2026-08-20T00:00:00.000Z',
          status: 'pending',
          snoozedUntil: null,
          aiSummary: null,
          aiCategories: ['research'],
          aiRelevanceScore: 10,
          aiUrgency: 'evergreen',
        }],
      },
    ]);
    await expect(new PostgresSemanticSourcePort(triageMock.pool).get('triage-item', 'triage-1'))
      .resolves.toMatchObject({ entityType: 'triage-item', aiCategories: ['research'] });
  });

  it('puts authoritative eligibility predicates on source scans', async () => {
    const mock = createMockPool();
    const port = new PostgresSemanticSourcePort(mock.pool);
    await port.listIds('project', { limit: 10 });
    await port.listIds('tag', { limit: 10 });
    await port.listIds('triage-item', { limit: 10 });
    expect(mock.sql()[0]).toContain('hidden = false');
    expect(mock.sql()[1]).toContain('confirmed = true AND unified_into IS NULL');
    expect(mock.sql()[2]).toContain("status <> 'dismissed'");
  });

  it('reports the kind as exhausted when a page is short', async () => {
    const mock = createMockPool([
      { match: /SELECT id FROM notifications/, rows: [{ id: 'alert-1' }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);
    expect(await port.listIds('alert', { limit: 10 }))
      .toEqual({ ids: ['alert-1'], nextCursor: null });
  });

  it('reads a page of tasks with exactly one tag query', async () => {
    const mock = createMockPool([
      { match: /FROM tasks WHERE id > \$1/, rows: [TASK_ROW, { ...TASK_ROW, id: 'task-2' }] },
      { match: /FROM task_tags/, rows: [{ taskId: 'task-1', name: 'Platform' }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);

    const page = await port.list('task', { limit: 2 });
    expect(page.records.map((record) => record.id)).toEqual(['task-1', 'task-2']);
    expect((page.records[0] as { tags: string[] }).tags).toEqual(['Platform']);
    expect((page.records[1] as { tags: string[] }).tags).toEqual([]);
    expect(page.nextCursor).toBe('task-2');
    expect(mock.sql().filter((statement) => /FROM task_tags/.test(statement))).toHaveLength(1);
  });

  it('does not query tags for an empty task page', async () => {
    const mock = createMockPool();
    const port = new PostgresSemanticSourcePort(mock.pool);
    expect(await port.list('task', { limit: 10 })).toEqual({ records: [], nextCursor: null });
    expect(mock.find(/FROM task_tags/)).toBeUndefined();
  });

  it('probes existence for a bounded batch with a single array parameter', async () => {
    const mock = createMockPool([
      { match: /SELECT id FROM tasks WHERE id = ANY/, rows: [{ id: 'task-1' }] },
    ]);
    const port = new PostgresSemanticSourcePort(mock.pool);

    expect([...await port.listExisting('task', ['task-1', 'task-2'])]).toEqual(['task-1']);
    expect(mock.params[0]).toEqual([['task-1', 'task-2']]);

    const empty = createMockPool();
    expect(await new PostgresSemanticSourcePort(empty.pool).listExisting('task', []))
      .toEqual(new Set());
    expect(empty.statements).toHaveLength(0);
  });

  it('bounds a hostile page size', async () => {
    const mock = createMockPool();
    const port = new PostgresSemanticSourcePort(mock.pool);
    await port.listIds('task', { limit: Number.MAX_SAFE_INTEGER });
    expect(mock.params[0][1]).toBe(1_000);
    await port.listIds('task', { limit: -5 });
    expect(mock.params[1][1]).toBe(1);
  });
});
