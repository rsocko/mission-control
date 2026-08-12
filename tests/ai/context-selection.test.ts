import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  results: [] as unknown[][],
  limits: [] as number[],
}));

function queryChain(result: unknown[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: (value: number) => {
      state.limits.push(value);
      return Promise.resolve(result);
    },
    then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(result)),
  };
  return chain;
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => queryChain(state.results.shift() ?? [])),
  },
}));

vi.mock('@/db/schema', () => ({
  tasks: {
    id: 'task_id',
    title: 'task_title',
    priority: 'task_priority',
    dueDate: 'task_due_date',
    connectorType: 'task_connector_type',
    status: 'task_status',
    updatedAt: 'task_updated_at',
  },
  notifications: {
    id: 'notification_id',
    title: 'notification_title',
    level: 'notification_level',
    levelRank: 'notification_level_rank',
    connectorType: 'notification_connector_type',
    state: 'notification_state',
    readState: 'notification_read_state',
    disposition: 'notification_disposition',
    sourceState: 'notification_source_state',
    snoozedUntil: 'notification_snoozed_until',
    receivedAt: 'notification_received_at',
  },
}));

vi.mock('drizzle-orm', () => ({
  and: vi.fn(() => 'and'),
  asc: vi.fn(() => 'asc'),
  desc: vi.fn(() => 'desc'),
  eq: vi.fn(() => 'eq'),
  inArray: vi.fn(() => 'inArray'),
  isNull: vi.fn(() => 'isNull'),
  lt: vi.fn(() => 'lt'),
  lte: vi.fn(() => 'lte'),
  or: vi.fn(() => 'or'),
  sql: Object.assign(vi.fn(() => 'sql'), {
    raw: vi.fn(() => 'raw'),
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('bounded AI context selection', () => {
  beforeEach(() => {
    state.limits.length = 0;
    state.results = [
      [{ open: 1000, overdue: 100, dueToday: 20, inProgress: 10, critical: 50 }],
      [{ id: 'overdue', title: 'Overdue', priority: 'high', dueDate: '2026-08-01', connectorType: 'github' }],
      [{ id: 'today', title: 'Today', priority: 'medium', dueDate: '2026-08-08', connectorType: 'todo' }],
      [{ id: 'progress', title: 'Progress', priority: 'low', dueDate: null, connectorType: 'todo' }],
      [{ unread: 500, urgent: 5 }],
      [{ id: 'notification', title: 'Alert', level: 'urgent', connectorType: 'outlook' }],
    ];
  });

  it('uses aggregates while limiting every detail category', async () => {
    const {
      AI_CONTEXT_ROWS_PER_CATEGORY,
      loadAIContextSnapshot,
    } = await import('@/lib/ai/context-budget');
    const snapshot = await loadAIContextSnapshot('2026-08-08');

    expect(state.limits).toEqual([
      AI_CONTEXT_ROWS_PER_CATEGORY,
      AI_CONTEXT_ROWS_PER_CATEGORY,
      AI_CONTEXT_ROWS_PER_CATEGORY,
      AI_CONTEXT_ROWS_PER_CATEGORY,
    ]);
    expect(snapshot.counts).toMatchObject({
      open: 1000,
      overdue: 100,
      unreadNotifications: 500,
    });
    expect(snapshot.rowCount).toBe(4);
    expect(snapshot.sources).toEqual(['github', 'todo', 'outlook']);
  });
});
