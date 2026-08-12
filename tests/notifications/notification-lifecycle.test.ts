import { describe, expect, it } from 'vitest';
import {
  isInInbox,
  isNotificationUnread,
  legacyStateFromLifecycle,
  legacyStateMutationPatch,
  legacyStatePatch,
  needsAttention,
  shouldReopenForSourceActivity,
  sourceActivityAdvanced,
} from '@/lib/notifications/lifecycle';

describe('notification lifecycle contract', () => {
  it.each([
    ['unread', 'unread', 'inbox', 'active'],
    ['read', 'read', 'inbox', 'active'],
    ['archived', 'read', 'handled', 'active'],
    ['dismissed', 'read', 'dismissed', 'active'],
    ['resolved', 'read', 'inbox', 'resolved'],
  ] as const)('maps legacy %s state into independent dimensions', (
    state,
    readState,
    disposition,
    sourceState,
  ) => {
    const patch = legacyStatePatch(state, '2026-08-02T12:00:00.000Z');

    expect(patch).toMatchObject({ state, readState, disposition, sourceState });
    expect(legacyStateFromLifecycle(patch)).toBe(state);
  });

  it('keeps read and workflow disposition independent', () => {
    expect(isInInbox({
      disposition: 'inbox',
      sourceState: 'active',
    })).toBe(true);
    expect(needsAttention({
      readState: 'unread',
      disposition: 'handled',
      sourceState: 'active',
      level: 'urgent',
    })).toBe(false);
  });

  it('excludes resolved, dismissed, snoozed, and digest notifications from attention', () => {
    const now = new Date('2026-08-02T12:00:00.000Z');
    const base = {
      readState: 'unread',
      disposition: 'inbox',
      sourceState: 'active',
      level: 'urgent',
    };

    expect(needsAttention({ ...base, sourceState: 'resolved' }, now)).toBe(false);
    expect(needsAttention({ ...base, disposition: 'dismissed' }, now)).toBe(false);
    expect(needsAttention({ ...base, snoozedUntil: '2026-08-02T12:01:00.000Z' }, now)).toBe(false);
    expect(needsAttention({ ...base, level: 'digest' }, now)).toBe(false);
    expect(needsAttention({ ...base, snoozedUntil: '2026-08-02T11:59:00.000Z' }, now)).toBe(true);
  });

  it('adapts legacy-only notification objects at runtime', () => {
    expect(isNotificationUnread({ state: 'unread' })).toBe(true);
    expect(isInInbox({ state: 'read' })).toBe(true);
    expect(isInInbox({ state: 'archived' })).toBe(false);
    expect(isInInbox({ state: 'resolved' })).toBe(false);
  });

  it('adapts legacy mutations without resetting unrelated dimensions', () => {
    const current = {
      readState: 'unread' as const,
      disposition: 'handled' as const,
      sourceState: 'resolved' as const,
      lastSourceActivityAt: '2026-08-02T10:00:00.000Z',
      lastSourceActivityKey: 'one',
    };

    expect(legacyStateMutationPatch(current, 'read', '2026-08-02T12:00:00.000Z')).toMatchObject({
      state: 'resolved',
      readState: 'read',
    });
    expect(legacyStateMutationPatch(current, 'dismissed', '2026-08-02T12:00:00.000Z')).toMatchObject({
      state: 'dismissed',
      disposition: 'dismissed',
    });
    expect(legacyStateMutationPatch(current, 'archived', '2026-08-02T12:00:00.000Z')).toMatchObject({
      state: 'resolved',
      disposition: 'handled',
      handledSourceActivityKey: 'one',
    });
  });

  it('only reopens eligible dispositions for genuinely advanced source activity', () => {
    const handled = {
      disposition: 'handled',
      lastSourceActivityAt: '2026-08-02T10:00:00.000Z',
      lastSourceActivityKey: 'one',
    };
    const same = {
      sourceState: 'active' as const,
      sourceActivityAt: '2026-08-02T10:00:00.000Z',
      sourceActivityKey: 'one',
    };
    const advanced = {
      sourceState: 'active' as const,
      sourceActivityAt: '2026-08-02T11:00:00.000Z',
      sourceActivityKey: 'two',
    };
    const revisedAtSameTime = {
      ...same,
      sourceActivityKey: 'two',
    };

    expect(sourceActivityAdvanced(handled, same)).toBe(false);
    expect(sourceActivityAdvanced(handled, revisedAtSameTime)).toBe(true);
    expect(shouldReopenForSourceActivity(handled, same)).toBe(false);
    expect(shouldReopenForSourceActivity(handled, advanced)).toBe(true);
    expect(shouldReopenForSourceActivity(
      { ...handled, disposition: 'dismissed' },
      advanced,
    )).toBe(false);
    expect(shouldReopenForSourceActivity(
      { ...handled, disposition: 'dismissed' },
      advanced,
      'handled_and_dismissed',
    )).toBe(true);
    expect(shouldReopenForSourceActivity(handled, advanced, 'never')).toBe(false);
  });
});
