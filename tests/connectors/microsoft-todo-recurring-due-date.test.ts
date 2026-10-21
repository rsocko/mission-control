import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConnectorConfig } from '@/types';
import type { GraphTodoTask } from '@/lib/connectors/microsoft-todo/types';

vi.mock('@/db', () => ({ default: { update: vi.fn() } }));
vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(async () => 'test-token'),
  getSubstrateToken: vi.fn(async () => 'test-token'),
  invalidateToken: vi.fn(),
}));
vi.mock('@/lib/mode', () => ({ getTimezone: () => 'America/New_York' }));

import { MicrosoftTodoConnector } from '@/lib/connectors/microsoft-todo';

const config = {
  id: 'todo-test',
  type: 'microsoft-todo',
  name: 'To Do',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 5,
  capabilities: {
    read: true, write: true, delete: true, sync: true,
    subtasks: true, lists: true, tags: true, tagWriteBack: true,
  },
  credentials: {},
  settings: {},
  syncedLists: [],
} satisfies ConnectorConfig;

const graphUrl = 'https://graph.microsoft.com/v1.0/me/todo/lists/list%2F%2B%3D/tasks/task%2F%2B%3D';
const nativeUrl = 'https://substrate.office.com/todob2/api/v1/taskfolders/list%2F%2B%3D/tasks/task%2F%2B%3D';
const sourceId = 'list/+=:task/+=';

type NativeRule = {
  RecurrenceType: string;
  IntervalType?: string;
  Interval?: number;
  WeekDays?: string[];
};

function installProvider(
  rule: NativeRule | null = { RecurrenceType: 'Daily' },
  options: {
    nativeReadStatus?: number;
    nativePatchStatus?: number;
    returnedId?: string;
    failAfterApply?: boolean;
    ignoreNativeDate?: boolean;
  } = {},
) {
  let task: GraphTodoTask = {
    id: 'task/+=',
    title: 'Recurring diagnostic',
    status: 'notStarted',
    importance: 'normal',
    createdDateTime: '2024-08-11T12:00:00Z',
    lastModifiedDateTime: '2026-10-01T12:00:00Z',
    dueDateTime: { dateTime: '2026-10-01T00:00:00', timeZone: 'UTC' },
    recurrence: rule ? {
      pattern: { type: 'daily', interval: 1 },
      range: { type: 'noEnd', startDate: '2024-08-11' },
    } : null,
  };
  let failedAfterApply = false;
  const calls: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    calls.push({ url, method, body });
    if (url === graphUrl) {
      if (method === 'PATCH') {
        // A due-date-only Graph write is the live-reproduced unsafe operation.
        if (task.recurrence && body?.dueDateTime) throw new Error('Unsafe Graph recurring due-date PATCH');
        task = { ...task, ...body };
      }
      return Response.json(task);
    }
    if (url !== nativeUrl) throw new Error(`Unexpected request: ${method} ${url}`);
    if (method === 'GET') {
      return Response.json({
        Id: 'task/+=',
        Recurrence: rule ? { ...rule, CompletingWillTriggerAnotherRecurrence: true } : null,
      }, { status: options.nativeReadStatus ?? 200 });
    }
    if (options.nativePatchStatus) return new Response('Native update failed', { status: options.nativePatchStatus });
    const due = body?.DueDateTime as { DateTime: string; TimeZone: string };
    if (!options.ignoreNativeDate) {
      task = { ...task, dueDateTime: { dateTime: due.DateTime, timeZone: due.TimeZone } };
    }
    if (options.failAfterApply && !failedAfterApply) {
      failedAfterApply = true;
      throw new Error('Connection lost after native update applied');
    }
    return Response.json({
      Id: options.returnedId ?? task.id,
      DueDateTime: { DateTime: task.dueDateTime?.dateTime },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, setTask: (updates: Partial<GraphTodoTask>) => { task = { ...task, ...updates }; } };
}

async function connector() {
  const instance = new MicrosoftTodoConnector();
  await instance.initialize(config);
  return instance;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Microsoft To Do recurring due-date writes', () => {
  it.each([
    { rule: { RecurrenceType: 'Daily' }, dueDate: '2026-10-21' },
    { rule: { RecurrenceType: 'Custom', IntervalType: 'Months', Interval: 3 }, dueDate: '2026-11-11' },
    { rule: { RecurrenceType: 'Custom', IntervalType: 'Weeks', Interval: 2, WeekDays: ['Monday', 'Friday'] }, dueDate: '2026-10-23' },
  ])('matches native Skip for $rule and preserves occurrence identity across replay', async ({ rule, dueDate }) => {
    const provider = installProvider(rule);
    const instance = await connector();

    for (let replay = 0; replay < 2; replay++) {
      const result = await instance.updateTask(sourceId, { dueDate });
      expect(result).toMatchObject({
        sourceId,
        dueDate,
        status: 'todo',
        createdAt: '2024-08-11T12:00:00Z',
      });
    }
    expect(provider.calls.filter(c => c.method === 'PATCH')).toEqual([{
      url: nativeUrl,
      method: 'PATCH',
      body: {
        DueDateTime: { DateTime: dueDate, TimeZone: 'America/New_York' },
        Recurrence: { FirstDayOfWeek: 'Sunday', ...rule },
      },
    }]);
    expect(provider.calls.some(c => c.method === 'POST' || c.method === 'DELETE')).toBe(false);
  });

  it('keeps worker full-task retries on the native date path without sending dates to Graph', async () => {
    const { calls } = installProvider();
    const instance = await connector();
    for (let replay = 0; replay < 2; replay++) {
      await instance.updateTask(sourceId, {
        title: 'Updated title',
        description: 'Keep notes',
        dueDate: '2026-10-21',
        priority: 'high',
        status: 'todo',
      });
    }
    expect(calls.filter(c => c.url === nativeUrl && c.method === 'PATCH')).toHaveLength(1);
    expect(calls.filter(c => c.url === graphUrl && c.method === 'PATCH').map(c => c.body)).toEqual([
      { title: 'Updated title', body: { content: 'Keep notes', contentType: 'text' }, importance: 'high', status: 'notStarted' },
      { title: 'Updated title', body: { content: 'Keep notes', contentType: 'text' }, importance: 'high', status: 'notStarted' },
    ]);
  });

  it('retains Graph updates for non-recurring tasks', async () => {
    const { calls } = installProvider(null);
    await (await connector()).updateTask(sourceId, { dueDate: '2026-10-21' });
    expect(calls).toEqual([
      { url: graphUrl, method: 'GET', body: undefined },
      { url: graphUrl, method: 'PATCH', body: { dueDateTime: { dateTime: '2026-10-21', timeZone: 'America/New_York' } } },
    ]);
  });

  it('recognizes an applied update after an ambiguous network failure without replaying the mutation', async () => {
    const { calls } = installProvider(undefined, { failAfterApply: true });
    const instance = await connector();
    await expect(instance.updateTask(sourceId, { dueDate: '2026-10-21' }))
      .rejects.toThrow('Connection lost after native update applied');
    await expect(instance.updateTask(sourceId, { dueDate: '2026-10-21' }))
      .resolves.toMatchObject({ sourceId, dueDate: '2026-10-21' });
    expect(calls.filter(c => c.method === 'PATCH')).toHaveLength(1);
  });

  it('leaves recurring completion with an unchanged date to Graph without rewriting recurrence', async () => {
    const { calls } = installProvider();
    await (await connector()).updateTask(sourceId, { dueDate: '2026-10-01', status: 'done' });
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([{
      url: graphUrl, method: 'PATCH', body: { status: 'completed' },
    }]);
    expect(calls.some(c => c.url === nativeUrl)).toBe(false);
  });

  it('does not read recurrence for unrelated title updates', async () => {
    const { calls } = installProvider();
    await (await connector()).updateTask(sourceId, { title: 'Renamed' });
    expect(calls).toEqual([{ url: graphUrl, method: 'PATCH', body: { title: 'Renamed' } }]);
  });

  it.each([
    { nativeReadStatus: 403, message: 'Failed to read native recurrence: 403' },
    { nativePatchStatus: 503, message: 'Failed to update native recurring task due date: 503' },
    { returnedId: 'replacement', message: 'Native To Do due-date update changed the task identity' },
    { ignoreNativeDate: true, message: 'Native To Do due-date update did not apply the requested date' },
  ])('fails explicitly without unsafe Graph fallback: $message', async ({ message, ...options }) => {
    const { calls } = installProvider(undefined, options);
    await expect((await connector()).updateTask(sourceId, { dueDate: '2026-10-21' })).rejects.toThrow(message);
    expect(calls.filter(c => c.url === graphUrl && c.method === 'PATCH')).toEqual([]);
    expect(calls.filter(c => c.url === nativeUrl && c.method === 'PATCH').length).toBeLessThanOrEqual(1);
  });

  it.each([
    { RecurrenceType: 'Unknown' },
    { RecurrenceType: 'Custom', IntervalType: 'Months', Interval: 0 },
    { RecurrenceType: 'Custom', IntervalType: 'Weeks', Interval: 2, WeekDays: [] },
  ])('rejects unsupported or malformed source rules instead of approximating them: %j', async rule => {
    const { calls } = installProvider(rule);
    await expect((await connector()).updateTask(sourceId, { dueDate: '2026-10-21' }))
      .rejects.toThrow('Cannot safely update due date');
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
  });

  it('does not discard a finite recurrence boundary', async () => {
    const { calls, setTask } = installProvider();
    setTask({ recurrence: {
      pattern: { type: 'daily', interval: 1 },
      range: { type: 'endDate', startDate: '2024-08-11', endDate: '2026-12-31' },
    } });
    await expect((await connector()).updateTask(sourceId, { dueDate: '2026-10-21' }))
      .rejects.toThrow('unsupported native To Do recurrence');
    expect(calls.filter(c => c.method === 'PATCH')).toEqual([]);
  });
});
