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
    getServerToday: vi.fn(() => '2026-08-16'),
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
  getLocalToday: mocks.getServerToday,
}));

describe('GET /api/navigation/counts', () => {
  beforeEach(() => {
    mocks.terminals.length = 0;
    mocks.select.mockClear();
    mocks.getServerToday.mockClear();
  });

  it('returns all actionable queue counts and notification severity', async () => {
    mocks.terminals.push(
      [{ count: 4 }],
      [{ attention: 7, unread: 9, urgent: 0, actionNeeded: 2, headsUp: 3, fyi: 2 }],
      [{ count: 11 }],
      [{ count: 5 }],
      [{ count: 3 }],
      [{ count: 6 }],
    );

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request(
      'http://localhost/api/navigation/counts?date=2026-08-16',
    ));

    expect(response.status).toBe(200);
    expect(mocks.getServerToday).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toEqual({
      myDay: 4,
      notifications: 2,
      triage: 11,
      quickSort: 5,
      reconciliation: 3,
      overdue: 6,
      unreadNotifications: 9,
      notificationTone: 'amber',
    });
  });

  it('counts only urgent notifications when urgent is the highest severity', async () => {
    mocks.terminals.push(
      [{ count: 4 }],
      [{ attention: 7, unread: 9, urgent: 2, actionNeeded: 3, headsUp: 1, fyi: 1 }],
      [{ count: 11 }],
      [{ count: 5 }],
      [{ count: 3 }],
      [{ count: 6 }],
    );

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request('http://localhost/api/navigation/counts'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notifications: 2,
      notificationTone: 'red',
    });
  });

  it('counts only heads-up notifications above lower blue severities', async () => {
    mocks.terminals.push(
      [{ count: 0 }],
      [{ attention: 6, unread: 6, urgent: 0, actionNeeded: 0, headsUp: 2, fyi: 4 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
      [{ count: 0 }],
    );

    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request('http://localhost/api/navigation/counts'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      notifications: 2,
      notificationTone: 'blue',
    });
  });

  it('rejects invalid browser-local dates', async () => {
    const { GET } = await import('@/app/api/navigation/counts/route');
    const response = await GET(new Request(
      'http://localhost/api/navigation/counts?date=2026-02-30',
    ));

    expect(response.status).toBe(400);
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
