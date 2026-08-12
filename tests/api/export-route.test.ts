import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { exportLogger, rowsByTable, queryCalls } = vi.hoisted(() => ({
  exportLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  queryCalls: [] as Array<{ limit: number; table: string }>,
  rowsByTable: new Map<string, Record<string, unknown>[]>(),
}));

vi.mock('@/lib/logger', () => ({ exportLogger }));
vi.mock('@/lib/telemetry/runtime', () => ({
  recordLivenessProbe: vi.fn(),
}));
vi.mock('@/db/schema', () => {
  const table = (name: string, columns: string[]) => ({
    _: { name },
    ...Object.fromEntries(columns.map((column) => [column, `${name}.${column}`])),
  });
  return {
    connectorConfigs: table('connector_configs', ['deletedAt', 'enabled', 'id', 'name', 'type']),
    hubProjects: table('hub_projects', ['id']),
    notifications: table('notifications', ['id']),
    syncLog: table('sync_log', ['id']),
    tags: table('tags', ['id']),
    tasks: table('tasks', ['id']),
    taskTags: table('task_tags', ['tagId', 'taskId']),
  };
});
vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => {
      let table = '';
      let limit = Number.MAX_SAFE_INTEGER;
      let condition: unknown;
      const query = {
        from(value: { _: { name: string } }) {
          table = value._.name;
          return query;
        },
        limit(value: number) {
          limit = value;
          return query;
        },
        orderBy() {
          return query;
        },
        then(resolve: (rows: Record<string, unknown>[]) => unknown) {
          const matches = (row: Record<string, unknown>, expression: unknown): boolean => {
            if (!expression) return true;
            const value = expression as {
              args?: unknown[];
              col?: unknown;
              type?: string;
              val?: unknown;
            };
            if (value.type === 'and') return (value.args ?? []).every((item) => matches(row, item));
            if (value.type === 'or') return (value.args ?? []).some((item) => matches(row, item));
            if (value.type === 'isNull') {
              const column = String(value.col ?? value.args?.[0]).split('.').at(-1)!;
              return row[column] === null || row[column] === undefined;
            }
            const column = String(value.col ?? value.args?.[0]).split('.').at(-1)!;
            if (value.type === 'eq') return row[column] === value.args?.[1];
            if (value.type === 'gt') return String(row[column]) > String(value.val ?? value.args?.[1]);
            return true;
          };
          queryCalls.push({ limit, table });
          const rows = (rowsByTable.get(table) ?? []).filter((row) => matches(row, condition));
          return Promise.resolve(resolve(rows.slice(0, limit)));
        },
        where(value: unknown) {
          condition = value;
          return query;
        },
      };
      return query;
    }),
  },
}));

function trustedRequest(path: string, signal?: AbortSignal) {
  return new Request(`http://localhost${path}`, {
    headers: {
      'x-mc-api-key': 'export-test-key',
    },
    signal,
  });
}

function sameOriginBrowserRequest(path: string) {
  const request = new Request(`http://localhost${path}`);
  return {
    headers: new Headers({ 'sec-fetch-site': 'same-origin' }),
    signal: request.signal,
    url: request.url,
  } as Request;
}

async function drainReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (!(await reader.read()).done) {
    // Keep consuming until the bounded stream completes or rejects.
  }
}

beforeEach(() => {
  rowsByTable.clear();
  queryCalls.length = 0;
  exportLogger.error.mockReset();
  exportLogger.info.mockReset();
  exportLogger.warn.mockReset();
  process.env.MC_EXPORT_BATCH_SIZE = '1';
  process.env.MC_API_KEY = 'export-test-key';
});

afterEach(() => {
  delete process.env.MC_EXPORT_BATCH_SIZE;
  delete process.env.MC_EXPORT_MAX_RECORDS;
  delete process.env.MC_API_KEY;
});

describe('GET /api/export', () => {
  it('requires same-origin or API-key authorization', async () => {
    const { GET } = await import('@/app/api/export/route');
    const response = await GET(new Request('http://localhost/api/export', {
      headers: { host: 'localhost', origin: 'https://attacker.example' },
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it('accepts same-origin browser GET downloads without an Origin header', async () => {
    const { GET } = await import('@/app/api/export/route');
    const response = await GET(sameOriginBrowserRequest('/api/export?type=tasks'));

    expect(response.status).toBe(200);
    await response.body?.cancel();
  });

  it('preserves the JSON schema while paging database reads', async () => {
    rowsByTable.set('tasks', [
      { id: '1', title: 'First', metadata: { source: 'test' } },
      { id: '2', title: 'Second', metadata: {} },
    ]);
    const { GET } = await import('@/app/api/export/route');

    const response = await GET(trustedRequest('/api/export?format=json&type=tasks'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('.json');
    expect(body).toMatchObject({
      version: '1.0',
      tasks: [
        { id: '1', title: 'First', metadata: { source: 'test' } },
        { id: '2', title: 'Second', metadata: {} },
      ],
    });
    expect(body.exportedAt).toEqual(expect.any(String));
    expect(queryCalls).toEqual([
      { limit: 1, table: 'tasks' },
      { limit: 1, table: 'tasks' },
      { limit: 1, table: 'tasks' },
    ]);
  });

  it('streams compatible CSV with correct escaping', async () => {
    rowsByTable.set('tasks', [{
      id: '1',
      title: 'Quoted, "task"',
      status: 'todo',
      priority: 'none',
      dueDate: null,
      connectorType: 'local',
      sourceListName: 'Inbox',
      createdAt: '2026-08-07',
    }]);
    const { GET } = await import('@/app/api/export/route');

    const response = await GET(trustedRequest('/api/export?format=csv&type=tasks'));

    expect(response.headers.get('content-type')).toContain('text/csv');
    expect(await response.text()).toBe(
      'id,title,status,priority,dueDate,connectorType,sourceListName,createdAt\n'
      + '1,"Quoted, ""task""",todo,none,,local,Inbox,2026-08-07',
    );
  });

  it('neutralizes spreadsheet formulas in CSV string fields', async () => {
    rowsByTable.set('tasks', [{
      id: '1',
      title: '=1+1',
      status: 'todo',
      priority: 'none',
      dueDate: null,
      connectorType: 'local',
      sourceListName: 'Inbox',
      createdAt: '2026-08-07',
    }]);
    const { GET } = await import('@/app/api/export/route');

    const response = await GET(trustedRequest('/api/export?format=csv&type=tasks'));

    expect(await response.text()).toContain("\n1,'=1+1,todo");
  });

  it('rejects equivalent exports until the active stream is cleaned up', async () => {
    const { GET } = await import('@/app/api/export/route');
    const first = await GET(trustedRequest('/api/export?type=tasks'));

    const duplicate = await GET(trustedRequest('/api/export?type=tasks'));
    expect(duplicate.status).toBe(429);
    expect(await duplicate.json()).toEqual({ error: 'Equivalent export already active' });

    await first.body?.cancel();
    const afterCleanup = await GET(trustedRequest('/api/export?type=tasks'));
    expect(afterCleanup.status).toBe(200);
    await afterCleanup.body?.cancel();
  });

  it('serves liveness while large exports saturate bounded concurrency', async () => {
    process.env.MC_EXPORT_BATCH_SIZE = '250';
    process.env.MC_EXPORT_MAX_RECORDS = '500';
    rowsByTable.set('tasks', Array.from({ length: 10_000 }, (_, index) => ({
      id: `task-${index.toString().padStart(5, '0')}`,
      title: `Task ${index}`,
    })));
    rowsByTable.set('notifications', Array.from({ length: 10_000 }, (_, index) => ({
      id: `notification-${index.toString().padStart(5, '0')}`,
    })));
    const { GET: getExport } = await import('@/app/api/export/route');
    const { GET: getLiveness } = await import('@/app/api/health/live/route');

    const taskExport = await getExport(trustedRequest('/api/export?type=tasks'));
    const notificationExport = await getExport(trustedRequest('/api/export?type=notifications'));
    expect(taskExport.status).toBe(200);
    expect(notificationExport.status).toBe(200);
    const taskReader = taskExport.body!.getReader();
    let taskStreamFinished = false;
    let releaseLoad!: () => void;
    const loadReleased = new Promise<'released'>((resolve) => {
      releaseLoad = () => resolve('released');
    });

    try {
      await taskReader.read();
      await taskReader.read();
      await taskReader.read();
      expect(queryCalls).toContainEqual({ limit: 250, table: 'tasks' });

      const overload = await getExport(trustedRequest('/api/export?type=tags'));
      expect(overload.status).toBe(429);
      expect(overload.headers.get('Retry-After')).toBe('5');

      const livenessWinner = await Promise.race([
        getLiveness().then(response => ({ kind: 'live' as const, response })),
        loadReleased.then(() => ({ kind: 'released' as const })),
      ]);
      expect(livenessWinner.kind).toBe('live');
      if (livenessWinner.kind !== 'live') throw new Error('Export load ended before liveness completed');
      expect(livenessWinner.response.status).toBe(200);
      await expect(livenessWinner.response.json()).resolves.toMatchObject({ live: true });

      const stillOverloaded = await getExport(trustedRequest('/api/export?type=projects'));
      expect(stillOverloaded.status).toBe(429);
      await expect(drainReader(taskReader)).rejects.toThrow('Export record limit exceeded');
      taskStreamFinished = true;
      expect(exportLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({ errorCode: 'record_limit', records: 500 }),
        'Export failed',
      );
    } finally {
      releaseLoad();
      if (!taskStreamFinished) await taskReader.cancel();
      await notificationExport.body?.cancel();
    }
  });

  it('cleans up admission after a failed export', async () => {
    const circular: Record<string, unknown> = { id: '1' };
    circular.self = circular;
    rowsByTable.set('tasks', [circular]);
    const { GET } = await import('@/app/api/export/route');

    const failed = await GET(trustedRequest('/api/export?type=tasks'));
    await expect(failed.text()).rejects.toThrow('could not be serialized');

    rowsByTable.set('tasks', []);
    const retry = await GET(trustedRequest('/api/export?type=tasks'));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ tasks: [] });
  });
});
