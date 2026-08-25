import { describe, expect, it } from 'vitest';
import {
  buildUndoPatch,
  snapshotsMatch,
} from '@/lib/quick-sort/operations';
import type { QuickSortTaskSnapshot } from '@/types/quick-sort';

const snapshot: QuickSortTaskSnapshot = {
  updatedAt: '2026-08-16T12:00:00.000Z',
  status: 'todo',
  statusReason: null,
  localDisposition: 'active',
  priority: 'none',
  planningHorizon: null,
  dueDate: null,
  completedAt: null,
  microStatus: 'ready',
  snoozedUntil: null,
  reminderAt: '2026-08-17T12:00:00.000Z',
  effort: null,
  tagIds: ['tag-a'],
};

describe('Quick Sort operation snapshots', () => {
  it('restores grouped fields and completion lifecycle side effects', () => {
    expect(buildUndoPatch(snapshot, {
      status: 'done',
      priority: 'high',
      tags: ['tag-a', 'tag-b'],
    })).toEqual({
      status: 'todo',
      statusReason: null,
      priority: 'none',
      tags: ['tag-a'],
      microStatus: 'ready',
      snoozedUntil: null,
      reminderAt: '2026-08-17T12:00:00.000Z',
    });
  });

  it('detects a newer conflicting task revision', () => {
    expect(snapshotsMatch(snapshot, { ...snapshot })).toBe(true);
    expect(snapshotsMatch(
      { ...snapshot, updatedAt: '2026-08-16T12:01:00.000Z' },
      snapshot,
    )).toBe(false);
  });

  it.each([
    [{ effort: 3 }, { effort: null }],
    [{ planningHorizon: 'now' }, { planningHorizon: null }],
    [{ dueDate: '2026-08-20' }, { dueDate: null }],
    [{ snoozedUntil: '2026-08-16T12:30:00.000Z' }, { snoozedUntil: null }],
    [{ localDisposition: 'handled' }, { localDisposition: 'active' }],
  ])('restores the exact prior value for %o', (patch, expected) => {
    expect(buildUndoPatch(snapshot, patch)).toEqual(expected);
  });

  it('compares tags independent of database row order', () => {
    expect(snapshotsMatch(
      { ...snapshot, tagIds: ['tag-a', 'tag-b'] },
      { ...snapshot, tagIds: ['tag-a', 'tag-b'] },
    )).toBe(true);
    expect(snapshotsMatch(
      { ...snapshot, tagIds: ['tag-a'] },
      { ...snapshot, tagIds: ['tag-b'] },
    )).toBe(false);
  });
});
