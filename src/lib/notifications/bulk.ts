export const MAX_NOTIFICATION_BULK_IDS = 500;

export interface NotificationBulkOutcome {
  acceptedCount: number;
  noOpCount: number;
  failedCount: number;
  queuedCount: number;
}

export function createNotificationBulkOutcome({
  requestedCount,
  acceptedCount,
  failedCount = 0,
  queuedCount = 0,
}: {
  requestedCount: number;
  acceptedCount: number;
  failedCount?: number;
  queuedCount?: number;
}): NotificationBulkOutcome {
  return {
    acceptedCount,
    noOpCount: Math.max(0, requestedCount - acceptedCount - failedCount),
    failedCount,
    queuedCount,
  };
}

export function normalizeNotificationBulkIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_NOTIFICATION_BULK_IDS) {
    throw new Error(`A maximum of ${MAX_NOTIFICATION_BULK_IDS} notification IDs is allowed`);
  }

  const normalized = value.map((id) => {
    if (typeof id !== 'string' || !id.trim() || id.length > 256) {
      throw new Error('Notification IDs must be non-empty strings of at most 256 characters');
    }
    return id.trim();
  });
  return [...new Set(normalized)];
}
