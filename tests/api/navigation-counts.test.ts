import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const terminals: unknown[] = [];

  function chainable(terminal: unknown) {
    const chain = new Proxy<Record<PropertyKey, unknown>>({}, {
      get(_, property) {
        if (property === 'then') {
          return (resolve: (value: unknown) => unknown) => resolve(terminal);
        }
        return vi.fn(() => chain);
      },
    });
    return chain;
  }

  return {
    terminals,
    select: vi.fn(() => chainable(terminals.shift() ?? [])),
  };
});

vi.mock('@/db', () => ({
  default: { select: mocks.select },
}));

vi.mock('@/db/schema', () => ({
  myDayItems: { date: 'myDayDate', taskId: 'myDayTaskId' },
  notifications: {
    connectorInstanceId: 'notificationConnectorId',
    readState: 'notificationReadState',
    level: 'notificationLevel',
  },
  scoutReconciliationSuggestions: {
    taskId: 'suggestionTaskId',
    status: 'suggestionStatus',
    expiresAt: 'suggestionExpiresAt',
  },
  tasks: {
    id: 'taskId',
    connectorInstanceId: 'taskConnectorId',
    connectorType: 'taskConnectorType',
    status: 'taskStatus',
    snoozedUntil: 'taskSnoozedUntil',
    parentId: 'taskParentId',
    priority: 'taskPriority',
    dueDate: 'taskDueDate',
  },
  triageItems: { status: 'triageStatus' },
}));

vi.mock('@/lib/connectors/task-source-profiles', () => ({
  NOTIFICATION_ONLY_CONNECTOR_TYPES: ['outlook-email'],
}));

vi.mock('@/lib/notifications/lifecycle-sql', () => ({
  notificationIsInInbox: vi.fn(() => ({ type: 'inbox' })),
  notificationNeedsAttention: vi.fn(() => ({ type: 'attention' })),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-08-16'),
}));

describe('GET /api/navigation/counts', () => {
  beforeEach(() => {
    mocks.terminals.length = 0;
    mocks.select.mockClear();
  });

  it('returns all actionable queue counts and notification severity', async () => {
    mocks.terminals.push(
      [{ count: 4 }],
      [{ attention: 7, unread: 9, urgent: 0, actionNeeded: 2 }],
      [{ count: 11 }],
      [{ count: 5 }],
      [{ count: 3 }],
      [{ count: 6 }],
    );

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      myDay: 4,
      notifications: 7,
      triage: 11,
      quickSort: 5,
      reconciliation: 3,
      overdue: 6,
      unreadNotifications: 9,
      notificationTone: 'amber',
    });
  });
});
