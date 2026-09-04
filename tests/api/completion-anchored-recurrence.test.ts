import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/semantic-index/publication-service', () => ({
  publishSemanticEntityDelete: vi.fn(async () => undefined),
  publishSemanticEntityUpsert: vi.fn(async () => undefined),
}));

describe('completion-anchored task recurrence', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let createTask: typeof import('@/app/api/tasks/route').POST;
  let patchTask: typeof import('@/app/api/tasks/[id]/route').PATCH;

  beforeAll(async () => {
    process.env.MC_DB_PATH = ':memory:';
    process.env.MC_MODE = 'demo';
    process.env.TZ = 'America/New_York';
    vi.doUnmock('@/db');
    vi.doUnmock('drizzle-orm');
    vi.doUnmock('crypto');
    vi.resetModules();

    const [dbModule, schemaModule, createRoute, detailRoute] = await Promise.all([
      import('@/db'),
      import('@/db/schema'),
      import('@/app/api/tasks/route'),
      import('@/app/api/tasks/[id]/route'),
    ]);
    db = dbModule.default;
    sqlite = dbModule.sqlite;
    schema = schemaModule;
    createTask = createRoute.POST;
    patchTask = detailRoute.PATCH;
    await dbModule.initializeSqlitePersistenceComposition();
  });

  afterAll(() => {
    sqlite.close();
    delete process.env.MC_DB_PATH;
    delete process.env.MC_MODE;
    delete process.env.TZ;
  });

  it('preserves the completed occurrence and creates one associated successor', async () => {
    const createResponse = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Water plants',
        description: 'Use the rain barrel',
        connectorType: 'local',
        dueDate: '2026-08-01',
        recurrence: 'every 3 days',
        recurrenceMode: 'completion',
        effort: 2,
      }),
    }));
    expect(createResponse.status).toBe(201);
    const { id } = await createResponse.json() as { id: string };

    const tagId = 'tag-garden';
    const projectId = 'project-home';
    const now = new Date().toISOString();
    await db.insert(schema.tags).values({
      id: tagId,
      name: 'Garden',
      slug: 'garden',
      type: 'hub',
      createdAt: now,
    });
    await db.insert(schema.taskTags).values({ taskId: id, tagId });
    await db.insert(schema.taskProjects).values({ taskId: id, projectId });
    sqlite.prepare(
      'UPDATE tasks SET reminder_relative = ?, reminder_due_time = ? WHERE id = ?',
    ).run('1_day_before', '09:00', id);

    const complete = () => patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'done' }),
    }), { params: Promise.resolve({ id }) });
    const [firstResponse, concurrentResponse] = await Promise.all([complete(), complete()]);
    expect(firstResponse.status).toBe(200);
    expect(concurrentResponse.status).toBe(409);
    const first = await firstResponse.json() as { recurrenceNextTaskId: string };
    await expect(concurrentResponse.json()).resolves.toMatchObject({
      code: 'TASK_REVISION_CONFLICT',
    });
    const nextSchedule = sqlite.prepare(
      'SELECT recurrence, recurrence_mode FROM task_schedules WHERE task_id = ?',
    ).get(first.recurrenceNextTaskId) as Record<string, unknown>;
    expect(nextSchedule).toMatchObject({
      recurrence: 'every 3 days',
      recurrence_mode: 'completion',
    });

    const occurrences = sqlite.prepare('SELECT * FROM tasks ORDER BY created_at').all() as Array<Record<string, unknown>>;
    expect(occurrences).toHaveLength(2);
    expect(occurrences.find((task) => task.id === id)).toMatchObject({
      status: 'done',
      description: 'Use the rain barrel',
    });
    expect(occurrences.find((task) => task.id === first.recurrenceNextTaskId)).toMatchObject({
      status: 'todo',
      title: 'Water plants',
      description: 'Use the rain barrel',
      effort: 2,
      recurrence_generated_from_task_id: id,
      reminder_relative: '1_day_before',
      reminder_due_time: '09:00',
    });
    expect(sqlite.prepare('SELECT * FROM task_tags WHERE task_id = ?')
      .all(first.recurrenceNextTaskId)).toHaveLength(1);
    expect(sqlite.prepare('SELECT * FROM task_projects WHERE task_id = ?')
      .all(first.recurrenceNextTaskId)).toHaveLength(1);

    const duplicateResponse = await complete();
    expect(duplicateResponse.status).toBe(200);
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      recurrenceNextTaskId: first.recurrenceNextTaskId,
    });
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(2);

    const reopenResponse = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'todo' }),
    }), { params: Promise.resolve({ id }) });
    expect(reopenResponse.status).toBe(200);
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(2);
  });

  it('rejects completion anchoring for connector-owned tasks', async () => {
    const response = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Remote recurrence',
        connectorType: 'microsoft-todo',
        recurrence: 'daily',
        recurrenceMode: 'completion',
      }),
    }));
    expect(response.status).toBe(400);
  });

  it('rejects completion anchoring without a recurrence interval', async () => {
    const response = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Incomplete recurrence',
        connectorType: 'local',
        recurrenceMode: 'completion',
      }),
    }));

    expect(response.status).toBe(400);
  });
});
