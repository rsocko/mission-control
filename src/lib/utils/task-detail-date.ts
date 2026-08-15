function localDateNumber(date: Date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

export function formatTaskDetailUpdatedAt(
  value: string | null | undefined,
  now = new Date(),
) {
  const updatedAt = value ? new Date(value) : null;
  if (!updatedAt || Number.isNaN(updatedAt.getTime()) || Number.isNaN(now.getTime())) {
    return 'Updated recently';
  }

  const dayDifference = localDateNumber(now) - localDateNumber(updatedAt);
  if (dayDifference === 0) return 'Updated today';
  if (dayDifference === 1) return 'Updated yesterday';

  return `Updated ${updatedAt.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })}`;
}

/** Format a date-only value (YYYY-MM-DD) as a short local day label. */
export function formatShortDate(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
