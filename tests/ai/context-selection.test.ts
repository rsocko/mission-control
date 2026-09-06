import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  loadDigestSnapshot: vi.fn(),
}));

vi.mock('@/lib/ai/workflow-persistence', () => ({
  getAIWorkflowPersistence: async () => ({
    context: { loadDigestSnapshot: state.loadDigestSnapshot },
  }),
}));

vi.mock('@/lib/logger', () => ({
  aiLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('bounded AI context selection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.loadDigestSnapshot.mockResolvedValue({
      counts: {
        open: 1000,
        overdue: 100,
        dueToday: 20,
        inProgress: 10,
        critical: 50,
        unreadNotifications: 500,
        urgentNotifications: 5,
      },
      overdue: [{
        id: 'overdue',
        title: 'Overdue',
        priority: 'high',
        dueDate: '2026-08-01',
        connectorType: 'github',
      }],
      dueToday: [{
        id: 'today',
        title: 'Today',
        priority: 'medium',
        dueDate: '2026-08-08',
        connectorType: 'todo',
      }],
      inProgress: [{
        id: 'progress',
        title: 'Progress',
        priority: 'low',
        dueDate: null,
        connectorType: 'todo',
      }],
      notifications: [{
        id: 'notification',
        title: 'Alert',
        level: 'urgent',
        connectorType: 'outlook',
      }],
      sources: ['github', 'todo', 'outlook'],
      rowCount: 4,
    });
  });

  it('passes the fixed detail bound to the aggregate persistence contract', async () => {
    const {
      AI_CONTEXT_ROWS_PER_CATEGORY,
      loadAIContextSnapshot,
    } = await import('@/lib/ai/context-budget');
    const snapshot = await loadAIContextSnapshot('2026-08-08');

    expect(state.loadDigestSnapshot).toHaveBeenCalledWith({
      today: '2026-08-08',
      now: expect.any(String),
      rowsPerCategory: AI_CONTEXT_ROWS_PER_CATEGORY,
    });
    expect(snapshot.counts).toMatchObject({
      open: 1000,
      overdue: 100,
      unreadNotifications: 500,
    });
    expect(snapshot.rowCount).toBe(4);
    expect(snapshot.sources).toEqual(['github', 'todo', 'outlook']);
  });
});
