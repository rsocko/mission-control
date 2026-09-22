import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';
import { canonicalizeLegacyRecurrence } from '@/lib/recurrence/canonical';

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
    const completedOccurrence = occurrences.find((task) => task.id === id);
    const nextOccurrence = occurrences.find((task) => task.id === first.recurrenceNextTaskId);
    expect(completedOccurrence).toMatchObject({
      status: 'done',
      description: 'Use the rain barrel',
    });
    expect(nextOccurrence).toMatchObject({
      status: 'todo',
      title: 'Water plants',
      description: 'Use the rain barrel',
      effort: 2,
      recurrence_generated_from_task_id: id,
      reminder_relative: '1_day_before',
      reminder_due_time: '09:00',
    });
    const completedMetadata = parseTaskMetadataCompat(
      completedOccurrence?.metadata,
    ).metadata as {
      canonicalRecurrence: {
        series: { id: string };
        revision: { id: string };
        semantics: { mode: string; timezone: { dstPolicy: string } };
      };
    };
    const nextMetadata = parseTaskMetadataCompat(nextOccurrence?.metadata)
      .metadata as typeof completedMetadata;
    expect(completedMetadata.canonicalRecurrence).toMatchObject({
      semantics: {
        mode: 'completion',
        timezone: { dstPolicy: 'preserve-wall-clock' },
      },
    });
    expect(nextMetadata.canonicalRecurrence.series.id).toBe(
      completedMetadata.canonicalRecurrence.series.id,
    );
    expect(nextMetadata.canonicalRecurrence.revision.id).toBe(
      completedMetadata.canonicalRecurrence.revision.id,
    );
    expect(sqlite.prepare(`
      SELECT
        task_id,
        generated_from_task_id,
        series_id,
        rule_revision_id,
        anchor_kind,
        materialization_strategy,
        source_owner,
        series_identity_kind
      FROM task_recurrence_occurrences
    `).get()).toMatchObject({
      task_id: first.recurrenceNextTaskId,
      generated_from_task_id: id,
      series_id: completedMetadata.canonicalRecurrence.series.id,
      rule_revision_id: completedMetadata.canonicalRecurrence.revision.id,
      anchor_kind: 'completion',
      materialization_strategy: 'on-completion',
      source_owner: 'mission-control',
      series_identity_kind: 'mission-control',
    });
    expect(sqlite.prepare('SELECT * FROM task_tags WHERE task_id = ?')
      .all(first.recurrenceNextTaskId)).toHaveLength(1);
    expect(sqlite.prepare('SELECT * FROM task_projects WHERE task_id = ?')
      .all(first.recurrenceNextTaskId)).toHaveLength(1);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    try {
      const duplicateResponse = await complete();
      expect(duplicateResponse.status).toBe(200);
      await expect(duplicateResponse.json()).resolves.toMatchObject({
        recurrenceNextTaskId: first.recurrenceNextTaskId,
      });
    } finally {
      vi.useRealTimers();
    }
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(2);
    expect(sqlite.prepare('SELECT occurrence_id FROM task_recurrence_occurrences').all())
      .toHaveLength(1);
    sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(first.recurrenceNextTaskId);
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(1);

    const reopenResponse = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'todo' }),
    }), { params: Promise.resolve({ id }) });
    expect(reopenResponse.status).toBe(200);
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(1);
    const recompleteResponse = await complete();
    expect(recompleteResponse.status).toBe(200);
    await expect(recompleteResponse.json()).resolves.toMatchObject({
      recurrenceNextTaskId: first.recurrenceNextTaskId,
    });
    expect(sqlite.prepare('SELECT id FROM tasks').all()).toHaveLength(1);
  });

  it('persists the shifted wall time for a successor in a DST gap', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-07T07:30:00.000Z'));
    try {
      const createResponse = await createTask(new Request('http://localhost/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'DST gap task',
          connectorType: 'local',
          dueDate: '2026-03-07T07:30:00.000Z',
          recurrence: 'daily',
          recurrenceMode: 'completion',
        }),
      }));
      expect(createResponse.status).toBe(201);
      const { id } = await createResponse.json() as { id: string };

      const response = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'done' }),
      }), { params: Promise.resolve({ id }) });
      expect(response.status).toBe(200);
      const { recurrenceNextTaskId } = await response.json() as {
        recurrenceNextTaskId: string;
      };
      const successor = sqlite.prepare(
        'SELECT due_date FROM tasks WHERE id = ?',
      ).get(recurrenceNextTaskId) as { due_date: string };
      const schedule = sqlite.prepare(
        'SELECT scheduled_date, scheduled_time FROM task_schedules WHERE task_id = ?',
      ).get(recurrenceNextTaskId) as {
        scheduled_date: string;
        scheduled_time: string;
      };

      expect(successor.due_date).toBe('2026-03-08T07:30:00.000Z');
      expect(schedule).toEqual({
        scheduled_date: '2026-03-08',
        scheduled_time: '03:30',
      });

    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the resulting recurrence rule and does not materialize a removed recurrence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-10T12:00:00.000Z'));
    try {
      const createRecurringTask = async (title: string) => {
        const response = await createTask(new Request('http://localhost/api/tasks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            connectorType: 'local',
            dueDate: '2026-08-10',
            recurrence: 'daily',
            recurrenceMode: 'completion',
          }),
        }));
        expect(response.status).toBe(201);
        return (await response.json() as { id: string }).id;
      };

      const changedId = await createRecurringTask('Changed cadence');
      const changedResponse = await patchTask(new Request(
        `http://localhost/api/tasks/${changedId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: 'done',
            recurrence: 'weekly',
            recurrenceMode: 'completion',
          }),
        },
      ), { params: Promise.resolve({ id: changedId }) });
      expect(changedResponse.status).toBe(200);
      const changed = await changedResponse.json() as { recurrenceNextTaskId: string };
      const changedSuccessor = sqlite.prepare(
        'SELECT due_date, metadata FROM tasks WHERE id = ?',
      ).get(changed.recurrenceNextTaskId) as { due_date: string; metadata: string };
      expect(changedSuccessor.due_date).toBe('2026-08-17');
      expect(parseTaskMetadataCompat(changedSuccessor.metadata).metadata.canonicalRecurrence)
        .toMatchObject({ semantics: { pattern: { type: 'weekly' } } });

      const removedId = await createRecurringTask('Removed cadence');
      const removedResponse = await patchTask(new Request(
        `http://localhost/api/tasks/${removedId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'done', recurrence: null }),
        },
      ), { params: Promise.resolve({ id: removedId }) });
      expect(removedResponse.status).toBe(200);
      expect(await removedResponse.json()).not.toHaveProperty('recurrenceNextTaskId');
      expect(sqlite.prepare(
        'SELECT id FROM tasks WHERE recurrence_generated_from_task_id = ?',
      ).all(removedId)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

  it('preserves series identity and creates a new rule revision when cadence changes', async () => {
    const createResponse = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Review goals',
        connectorType: 'local',
        dueDate: '2026-08-03',
        recurrence: 'daily',
      }),
    }));
    expect(createResponse.status).toBe(201);
    const { id } = await createResponse.json() as { id: string };
    const readRule = () => {
      const row = sqlite.prepare('SELECT metadata FROM tasks WHERE id = ?')
        .get(id) as { metadata: unknown };
      return (parseTaskMetadataCompat(row.metadata).metadata as {
        canonicalRecurrence: {
          series: { id: string };
          revision: { id: string };
          semantics: { pattern: unknown };
        };
      }).canonicalRecurrence;
    };
    const original = readRule();

    const updateResponse = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recurrence: 'weekly' }),
    }), { params: Promise.resolve({ id }) });
    expect(updateResponse.status).toBe(200);
    const revised = readRule();

    expect(revised.series.id).toBe(original.series.id);
    expect(revised.revision.id).not.toBe(original.revision.id);
    expect(revised.semantics.pattern).toEqual({
      type: 'weekly',
      interval: 1,
      daysOfWeek: ['monday'],
    });
  });

  it('persists and updates local recurrence exceptions and catch-up policy', async () => {
    const createResponse = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Review operations',
        connectorType: 'local',
        dueDate: '2026-09-21',
        recurrence: 'weekly',
        recurrenceSkipDates: ['2026-09-28'],
        recurrenceCatchUp: 'none',
      }),
    }));
    expect(createResponse.status).toBe(201);
    const { id } = await createResponse.json() as { id: string };
    const readSemantics = () => {
      const row = sqlite.prepare('SELECT metadata FROM tasks WHERE id = ?')
        .get(id) as { metadata: unknown };
      return (parseTaskMetadataCompat(row.metadata).metadata as {
        canonicalRecurrence: {
          semantics: {
            exceptions: { skipDates: string[] };
            materialization: { catchUp: string };
          };
        };
      }).canonicalRecurrence.semantics;
    };

    expect(readSemantics()).toMatchObject({
      exceptions: { skipDates: ['2026-09-28'] },
      materialization: { catchUp: 'none' },
    });

    const updateResponse = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recurrenceSkipDates: ['2026-10-05'],
        recurrenceCatchUp: 'latest',
      }),
    }), { params: Promise.resolve({ id }) });
    expect(updateResponse.status).toBe(200);
    expect(readSemantics()).toMatchObject({
      exceptions: { skipDates: ['2026-10-05'] },
      materialization: { catchUp: 'latest' },
    });
  });

  it('rejects edits to provider-owned canonical recurrence', async () => {
    const createResponse = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Imported schedule',
        connectorType: 'local',
        dueDate: '2026-09-21',
        recurrence: 'weekly',
      }),
    }));
    const { id } = await createResponse.json() as { id: string };
    const providerRule = canonicalizeLegacyRecurrence({
      recurrence: 'weekly',
      mode: 'schedule',
      startDate: '2026-09-21',
      timezone: 'UTC',
      seriesIdentity: {
        kind: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        externalSeriesId: 'series-1',
        stability: 'provider',
      },
      source: {
        owner: 'connector',
        connectorType: 'example',
        connectorInstanceId: 'example-1',
        support: { status: 'supported', reasons: [] },
        raw: {},
      },
    });
    sqlite.prepare('UPDATE tasks SET metadata = ? WHERE id = ?').run(
      JSON.stringify({ canonicalRecurrence: providerRule }),
      id,
    );

    const response = await patchTask(new Request(`http://localhost/api/tasks/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recurrenceSkipDates: ['2026-09-28'] }),
    }), { params: Promise.resolve({ id }) });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: 'This recurrence is owned by its provider and must be changed there',
    });
  });

  it('rejects unsupported local recurrence strings instead of approximating them', async () => {
    const response = await createTask(new Request('http://localhost/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Ambiguous recurrence',
        connectorType: 'local',
        dueDate: '2026-08-03',
        recurrence: 'sometimes',
      }),
    }));

    expect(response.status).toBe(400);
  });
});
