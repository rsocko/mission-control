import { describe, expect, it } from 'vitest';
import { getStatusLifecycleUpdates } from '@/lib/tasks/status-lifecycle';

describe('getStatusLifecycleUpdates', () => {
  const now = '2026-07-31T12:00:00.000Z';

  it('records a genuine final completion and clears a stale closure reason', () => {
    expect(getStatusLifecycleUpdates({
      status: 'done',
      explicitReason: undefined,
      completedAt: now,
      currentStatus: 'cancelled',
      currentCompletedAt: null,
      currentStatusReason: 'duplicate',
    })).toEqual({
      status: 'done',
      completedAt: now,
      statusReason: 'completed',
    });
  });

  it('clears completion state when a task is reopened', () => {
    expect(getStatusLifecycleUpdates({
      status: 'in_progress',
      explicitReason: undefined,
      completedAt: now,
      currentStatus: 'done',
      currentCompletedAt: '2026-07-30T12:00:00.000Z',
    })).toEqual({
      status: 'in_progress',
      completedAt: null,
      statusReason: null,
    });
  });

  it('preserves an explicit non-completion closure reason', () => {
    expect(getStatusLifecycleUpdates({
      status: 'cancelled',
      explicitReason: 'duplicate',
      completedAt: now,
      currentStatus: 'todo',
    })).toEqual({
      status: 'cancelled',
      completedAt: null,
      statusReason: 'duplicate',
    });
  });

  it('does not move an existing final completion on a redundant done update', () => {
    expect(getStatusLifecycleUpdates({
      status: 'done',
      explicitReason: undefined,
      completedAt: now,
      currentStatus: 'done',
      currentCompletedAt: '2026-07-20T12:00:00.000Z',
      currentStatusReason: 'completed',
    })).toEqual({
      status: 'done',
      completedAt: '2026-07-20T12:00:00.000Z',
      statusReason: 'completed',
    });
  });

  it('tracks close, reopen, and final reclose timestamps independently', () => {
    const firstClose = getStatusLifecycleUpdates({
      status: 'done',
      explicitReason: 'completed',
      completedAt: '2026-07-10T12:00:00.000Z',
      currentStatus: 'todo',
    });
    const reopened = getStatusLifecycleUpdates({
      status: 'todo',
      explicitReason: null,
      completedAt: now,
      currentStatus: firstClose.status as string,
      currentCompletedAt: firstClose.completedAt,
      currentStatusReason: firstClose.statusReason,
    });
    const finalClose = getStatusLifecycleUpdates({
      status: 'done',
      explicitReason: 'completed',
      completedAt: '2026-07-31T12:00:00.000Z',
      currentStatus: reopened.status as string,
      currentCompletedAt: reopened.completedAt,
      currentStatusReason: reopened.statusReason,
    });

    expect(reopened.completedAt).toBeNull();
    expect(finalClose.completedAt).toBe('2026-07-31T12:00:00.000Z');
  });
});
