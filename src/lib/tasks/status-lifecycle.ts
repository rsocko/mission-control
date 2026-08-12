export interface StatusLifecycleInput {
  status: string | undefined;
  explicitReason: string | null | undefined;
  completedAt: string;
  currentStatus?: string;
  currentCompletedAt?: string | null;
  currentStatusReason?: string | null;
}

export function getStatusLifecycleUpdates({
  status,
  explicitReason,
  completedAt,
  currentStatus,
  currentCompletedAt,
  currentStatusReason,
}: StatusLifecycleInput): Record<string, string | null> {
  if (status === undefined) {
    return explicitReason === undefined ? {} : { statusReason: explicitReason };
  }

  if (status === 'done') {
    const isNewCompletion = currentStatus !== 'done';
    return {
      status,
      completedAt: isNewCompletion ? completedAt : currentCompletedAt ?? completedAt,
      statusReason: explicitReason ?? (isNewCompletion ? 'completed' : currentStatusReason ?? 'completed'),
    };
  }

  return {
    status,
    completedAt: null,
    statusReason: explicitReason ?? null,
  };
}
