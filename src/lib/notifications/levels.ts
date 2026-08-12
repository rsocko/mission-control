import type { NotificationLevel } from '@/types';

export const NOTIFICATION_LEVEL_RANKS = {
  urgent: 0,
  action_needed: 1,
  heads_up: 2,
  fyi: 3,
  digest: 4,
} as const satisfies Record<NotificationLevel, number>;

export const NOTIFICATION_LEVEL_VALUES = Object.freeze(
  Object.keys(NOTIFICATION_LEVEL_RANKS) as NotificationLevel[],
);

export function isNotificationLevel(value: unknown): value is NotificationLevel {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(NOTIFICATION_LEVEL_RANKS, value);
}

export function getNotificationLevelRank(level: NotificationLevel): number {
  return NOTIFICATION_LEVEL_RANKS[level];
}

export function notificationMeetsMinimumLevel(
  level: NotificationLevel,
  minimumLevel: NotificationLevel,
): boolean {
  return getNotificationLevelRank(level) <= getNotificationLevelRank(minimumLevel);
}

const LEGACY_NOTIFICATION_LEVELS: Readonly<Record<string, NotificationLevel>> = {
  critical: 'urgent',
  high: 'action_needed',
  medium: 'heads_up',
  low: 'fyi',
  info: 'digest',
};

export function normalizeNotificationLevel(value: unknown): {
  level: NotificationLevel;
  levelRank: number;
} {
  const normalized = isNotificationLevel(value)
    ? value
    : typeof value === 'string'
      && Object.prototype.hasOwnProperty.call(LEGACY_NOTIFICATION_LEVELS, value)
      ? LEGACY_NOTIFICATION_LEVELS[value]
      : 'digest';
  return {
    level: normalized,
    levelRank: getNotificationLevelRank(normalized),
  };
}
