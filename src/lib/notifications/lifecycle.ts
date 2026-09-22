import type {
  NotificationDisposition,
  NotificationReadState,
  NotificationReopenPolicy,
  NotificationSourceState,
  NotificationState,
  NotificationSyncState,
} from '@/types';

export interface NotificationLifecycle {
  readState: NotificationReadState;
  disposition: NotificationDisposition;
  sourceState: NotificationSourceState;
  syncState: NotificationSyncState;
  snoozedUntil?: string | null;
  level?: string;
}

export interface SourceActivity {
  sourceState: NotificationSourceState;
  sourceActivityAt?: string | null;
  sourceActivityKey?: string | null;
}

export interface StoredSourceActivity {
  disposition: string;
  lastSourceActivityAt?: string | null;
  lastSourceActivityKey?: string | null;
}

export function isInInbox(
  notification: {
    state?: string;
    disposition?: string;
    sourceState?: string;
    snoozedUntil?: string | null;
  },
  now = new Date(),
): boolean {
  const disposition = notification.disposition
    ?? (notification.state === 'archived'
      ? 'handled'
      : notification.state === 'dismissed'
        ? 'dismissed'
        : 'inbox');
  const sourceState = notification.sourceState
    ?? (notification.state === 'resolved' ? 'resolved' : 'active');
  return disposition === 'inbox'
    && (sourceState === 'active' || sourceState === 'unknown')
    && (
      !notification.snoozedUntil
      || new Date(notification.snoozedUntil).getTime() <= now.getTime()
    );
}

export function needsAttention(
  notification: {
    state?: string;
    disposition?: string;
    sourceState?: string;
    snoozedUntil?: string | null;
    readState?: string;
    level?: string | null;
  },
  now = new Date(),
): boolean {
  return isInInbox(notification, now)
    && isNotificationUnread(notification)
    && notification.level !== 'digest';
}

export function countsTowardAttention(
  notification: {
    state?: string;
    disposition?: string;
    sourceState?: string;
    snoozedUntil?: string | null;
    readState?: string;
    level?: string | null;
  },
  now = new Date(),
): boolean {
  return isInInbox(notification, now)
    && notification.level !== 'digest'
    && (
      notification.level === 'urgent'
      || notification.level === 'action_needed'
      || isNotificationUnread(notification)
    );
}

export function isNotificationUnread(
  notification: { state?: string; readState?: string },
): boolean {
  return notification.readState
    ? notification.readState === 'unread'
    : notification.state === 'unread';
}

export function legacyStateFromLifecycle(
  lifecycle: { readState: string; disposition: string; sourceState: string },
): NotificationState {
  if (lifecycle.disposition === 'dismissed') return 'dismissed';
  if (lifecycle.sourceState === 'resolved' || lifecycle.sourceState === 'deleted') return 'resolved';
  if (lifecycle.disposition === 'handled') return 'archived';
  return lifecycle.readState === 'read' ? 'read' : 'unread';
}

export function legacyStatePatch(
  state: NotificationState,
  now: string,
  activity: {
    lastSourceActivityAt?: string | null;
    lastSourceActivityKey?: string | null;
  } = {},
): {
  state: NotificationState;
  readState: NotificationReadState;
  disposition: NotificationDisposition;
  sourceState: NotificationSourceState;
  readAt?: string | null;
  handledAt?: string | null;
  dismissedAt?: string | null;
  sourceResolvedAt?: string | null;
  handledSourceActivityAt?: string | null;
  handledSourceActivityKey?: string | null;
} {
  switch (state) {
    case 'unread':
      return {
        state,
        readState: 'unread',
        disposition: 'inbox',
        sourceState: 'active',
        readAt: null,
      };
    case 'read':
      return {
        state,
        readState: 'read',
        disposition: 'inbox',
        sourceState: 'active',
        readAt: now,
      };
    case 'dismissed':
      return {
        state,
        readState: 'read',
        disposition: 'dismissed',
        sourceState: 'active',
        readAt: now,
        dismissedAt: now,
      };
    case 'resolved':
      return {
        state,
        readState: 'read',
        disposition: 'inbox',
        sourceState: 'resolved',
        readAt: now,
        sourceResolvedAt: now,
      };
    case 'archived':
      return {
        state,
        readState: 'read',
        disposition: 'handled',
        sourceState: 'active',
        readAt: now,
        handledAt: now,
        handledSourceActivityAt: activity.lastSourceActivityAt ?? null,
        handledSourceActivityKey: activity.lastSourceActivityKey ?? null,
      };
  }
}

export function legacyStateMutationPatch(
  current: {
    readState: string;
    disposition: string;
    sourceState: string;
    lastSourceActivityAt?: string | null;
    lastSourceActivityKey?: string | null;
  },
  state: NotificationState,
  now: string,
): {
  state: NotificationState;
  readState?: NotificationReadState;
  disposition?: NotificationDisposition;
  sourceState?: NotificationSourceState;
  readAt?: string | null;
  handledAt?: string | null;
  dismissedAt?: string | null;
  sourceResolvedAt?: string | null;
  handledSourceActivityAt?: string | null;
  handledSourceActivityKey?: string | null;
} {
  const next: {
    readState: NotificationReadState;
    disposition: NotificationDisposition;
    sourceState: NotificationSourceState;
  } = {
    readState: current.readState === 'read' ? 'read' : 'unread',
    disposition: (
      current.disposition === 'handled' || current.disposition === 'dismissed'
        ? current.disposition
        : 'inbox'
    ) as NotificationDisposition,
    sourceState: (
      current.sourceState === 'resolved'
        || current.sourceState === 'deleted'
        || current.sourceState === 'unknown'
        ? current.sourceState
        : 'active'
    ) as NotificationSourceState,
  };
  switch (state) {
    case 'unread':
      next.readState = 'unread';
      return {
        state: legacyStateFromLifecycle(next),
        readState: 'unread',
        readAt: null,
      };
    case 'read':
      next.readState = 'read';
      return {
        state: legacyStateFromLifecycle(next),
        readState: 'read',
        readAt: now,
      };
    case 'archived':
      next.disposition = 'handled';
      return {
        state: legacyStateFromLifecycle(next),
        disposition: 'handled',
        handledAt: now,
        handledSourceActivityAt: current.lastSourceActivityAt ?? null,
        handledSourceActivityKey: current.lastSourceActivityKey ?? null,
      };
    case 'dismissed':
      next.readState = 'read';
      next.disposition = 'dismissed';
      return {
        state: legacyStateFromLifecycle(next),
        readState: 'read',
        disposition: 'dismissed',
        readAt: now,
        dismissedAt: now,
      };
    case 'resolved':
      next.sourceState = 'resolved';
      return {
        state: legacyStateFromLifecycle(next),
        sourceState: 'resolved',
        sourceResolvedAt: now,
      };
  }
}

export function sourceActivityAdvanced(
  current: StoredSourceActivity,
  incoming: SourceActivity,
): boolean {
  if (incoming.sourceState !== 'active') return false;
  if (incoming.sourceActivityAt) {
    if (!current.lastSourceActivityAt) return true;
    if (incoming.sourceActivityAt !== current.lastSourceActivityAt) {
      return incoming.sourceActivityAt > current.lastSourceActivityAt;
    }
    return Boolean(
      incoming.sourceActivityKey
      && incoming.sourceActivityKey !== current.lastSourceActivityKey,
    );
  }
  return Boolean(
    incoming.sourceActivityKey
    && incoming.sourceActivityKey !== current.lastSourceActivityKey,
  );
}

export function shouldReopenForSourceActivity(
  current: StoredSourceActivity,
  incoming: SourceActivity,
  policy: NotificationReopenPolicy = 'handled',
): boolean {
  if (!sourceActivityAdvanced(current, incoming) || policy === 'never') return false;
  if (current.disposition === 'handled') return true;
  return policy === 'handled_and_dismissed' && current.disposition === 'dismissed';
}
