export interface QuickSortTaskSnapshot {
  updatedAt: string;
  status: string;
  statusReason: string | null;
  localDisposition: string;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  completedAt: string | null;
  microStatus: string | null;
  snoozedUntil: string | null;
  reminderAt: string | null;
  effort: number | null;
  tagIds: string[];
}

export interface QuickSortBeforeSnapshot extends QuickSortTaskSnapshot {
  originalPatch: Record<string, unknown>;
}
