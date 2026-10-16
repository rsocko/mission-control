export interface SyncPhaseMetric {
  durationMs: number;
  success: boolean;
}

export interface SyncGraphMetrics {
  requests: number;
  retries: number;
  failures: number;
  rateLimited: number;
  durationMs: number;
}

export interface SyncTodoMetrics {
  deltaPages: number;
  deltaTasksReceived: number;
  deltaRemovalsReceived: number;
  checklistTasksRequested: number;
  checklistBatchRequests: number;
  checklistFallbackRequests: number;
  linkedResourceTasksRequested: number;
  linkedResourceBatchRequests: number;
  checkpointsCommitted: number;
  checkpointsDeferred: number;
}

export interface SyncReconciliationMetrics {
  tasksReceived: number;
  tasksChanged: number;
  tasksUnchanged: number;
  casConflicts: number;
  casRetries: number;
  casDeferred: number;
  listsDeferred: number;
}

export interface SyncConcurrencyMetrics {
  listFetchLimit: number;
  graphBatchSubrequestLimit: number;
  graphBatchConcurrency: number;
  graphFallbackConcurrency: number;
}

export interface SyncRunMetrics {
  version: 1;
  phases: Record<string, SyncPhaseMetric>;
  graph?: SyncGraphMetrics;
  todo?: SyncTodoMetrics;
  reconciliation?: SyncReconciliationMetrics;
  concurrency?: SyncConcurrencyMetrics;
}

export function normalizeSyncRunMetrics(value: unknown): SyncRunMetrics | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<SyncRunMetrics>;
  if (candidate.version !== 1 || !candidate.phases || typeof candidate.phases !== 'object') {
    return null;
  }
  const phases = Object.fromEntries(
    Object.entries(candidate.phases).flatMap(([key, phase]) => (
      phase
      && typeof phase === 'object'
      && Number.isFinite(phase.durationMs)
      && typeof phase.success === 'boolean'
        ? [[key, {
            durationMs: Math.max(0, Number(phase.durationMs)),
            success: phase.success,
          }]]
        : []
    )),
  );
  const numericGroup = <T extends object>(group: unknown): T | undefined => {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
    return Object.fromEntries(
      Object.entries(group).flatMap(([key, metric]) => (
        Number.isFinite(metric)
          ? [[key, Math.max(0, Number(metric))]]
          : []
      )),
    ) as T;
  };
  return {
    version: 1,
    phases,
    graph: numericGroup<SyncGraphMetrics>(candidate.graph),
    todo: numericGroup<SyncTodoMetrics>(candidate.todo),
    reconciliation: numericGroup<SyncReconciliationMetrics>(candidate.reconciliation),
    concurrency: numericGroup<SyncConcurrencyMetrics>(candidate.concurrency),
  };
}
