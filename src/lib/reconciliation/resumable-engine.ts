export type ReconciliationSnapshotStatus =
  | 'running'
  | 'failed'
  | 'partial'
  | 'completed';

export interface ResumableReconciliationSnapshot {
  status: ReconciliationSnapshotStatus;
  cursor: number;
  total: number;
  batchSize: number;
  failureCount: number;
  nextAttemptAt: string | null;
}

export interface ReconciliationBatchWindow {
  start: number;
  end: number;
}

export interface ReconciliationRetryClassification {
  retryable: boolean;
}

export interface ReconciliationFailure {
  error: unknown;
  failureCount: number;
  failedAt: string;
  nextAttemptAt: string | null;
}

export type ReconciliationProgressPhase =
  | 'ready'
  | 'deferred'
  | 'advanced'
  | 'terminal'
  | 'completed'
  | 'failed';

export interface ReconciliationProgressEvent<Progress> {
  phase: ReconciliationProgressPhase;
  progress: Progress;
}

export interface ResumableReconciliationAdapter<
  Snapshot extends ResumableReconciliationSnapshot,
  Batch,
  BatchResult,
  Completion,
  Progress,
> {
  createSnapshot(): Promise<Snapshot>;
  loadBatch(
    snapshot: Snapshot,
    window: ReconciliationBatchWindow,
  ): Promise<Batch>;
  executeBatch(
    snapshot: Snapshot,
    batch: Batch,
    window: ReconciliationBatchWindow,
  ): Promise<BatchResult>;
  advanceCursor(
    snapshot: Snapshot,
    batchResult: BatchResult,
    window: ReconciliationBatchWindow,
  ): Promise<Snapshot>;
  classifyRetry(
    error: unknown,
    snapshot: Snapshot,
  ): ReconciliationRetryClassification;
  recordFailure(
    snapshot: Snapshot,
    failure: ReconciliationFailure,
  ): Promise<Snapshot>;
  reportProgress(snapshot: Snapshot): Progress;
  complete(snapshot: Snapshot): Promise<{
    snapshot: Snapshot;
    result: Completion;
  }>;
  shouldContinue?(snapshot: Snapshot): boolean;
  onProgress?(event: ReconciliationProgressEvent<Progress>): void | Promise<void>;
}

export interface ResumableReconciliationOptions<
  Snapshot extends ResumableReconciliationSnapshot,
> {
  snapshot?: Snapshot;
  retryBaseMs: number;
  retryMaxMs: number;
  now?: () => Date;
}

interface ResumableReconciliationResultBase<
  Snapshot extends ResumableReconciliationSnapshot,
  BatchResult,
  Progress,
> {
  snapshot: Snapshot;
  batchResults: BatchResult[];
  progress: Progress;
}

export type ResumableReconciliationResult<
  Snapshot extends ResumableReconciliationSnapshot,
  BatchResult,
  Completion,
  Progress,
> =
  | ResumableReconciliationResultBase<Snapshot, BatchResult, Progress> & {
      outcome: 'deferred' | 'running' | 'terminal';
      completion?: never;
    }
  | ResumableReconciliationResultBase<Snapshot, BatchResult, Progress> & {
      outcome: 'completed';
      completion: Completion;
    };

export function exponentialRetryDelay(
  failureCount: number,
  baseMs: number,
  maxMs: number,
): number {
  const normalizedFailureCount = Math.max(1, Math.floor(failureCount));
  return Math.min(baseMs * (2 ** (normalizedFailureCount - 1)), maxMs);
}

function validateSnapshot(snapshot: ResumableReconciliationSnapshot): void {
  if (!Number.isInteger(snapshot.cursor) || snapshot.cursor < 0) {
    throw new Error('Reconciliation snapshot cursor must be a non-negative integer');
  }
  if (!Number.isInteger(snapshot.total) || snapshot.total < 0) {
    throw new Error('Reconciliation snapshot total must be a non-negative integer');
  }
  if (!Number.isInteger(snapshot.batchSize) || snapshot.batchSize <= 0) {
    throw new Error('Reconciliation snapshot batch size must be a positive integer');
  }
  if (snapshot.cursor > snapshot.total) {
    throw new Error('Reconciliation snapshot cursor cannot exceed its total');
  }
}

async function emitProgress<
  Snapshot extends ResumableReconciliationSnapshot,
  Batch,
  BatchResult,
  Completion,
  Progress,
>(
  adapter: ResumableReconciliationAdapter<
    Snapshot,
    Batch,
    BatchResult,
    Completion,
    Progress
  >,
  phase: ReconciliationProgressPhase,
  snapshot: Snapshot,
): Promise<Progress> {
  const progress = adapter.reportProgress(snapshot);
  await adapter.onProgress?.({ phase, progress });
  return progress;
}

export async function runResumableReconciliation<
  Snapshot extends ResumableReconciliationSnapshot,
  Batch,
  BatchResult,
  Completion,
  Progress,
>(
  adapter: ResumableReconciliationAdapter<
    Snapshot,
    Batch,
    BatchResult,
    Completion,
    Progress
  >,
  options: ResumableReconciliationOptions<Snapshot>,
): Promise<ResumableReconciliationResult<
  Snapshot,
  BatchResult,
  Completion,
  Progress
>> {
  const now = options.now ?? (() => new Date());
  let snapshot = options.snapshot ?? await adapter.createSnapshot();
  const batchResults: BatchResult[] = [];
  validateSnapshot(snapshot);
  await emitProgress(adapter, 'ready', snapshot);

  const recordFailure = async (error: unknown): Promise<never> => {
    const classification = adapter.classifyRetry(error, snapshot);
    const failureCount = snapshot.failureCount + 1;
    const failedAt = now();
    const nextAttemptAt = classification.retryable
      ? new Date(
          failedAt.getTime() + exponentialRetryDelay(
            failureCount,
            options.retryBaseMs,
            options.retryMaxMs,
          ),
        ).toISOString()
      : null;
    snapshot = await adapter.recordFailure(snapshot, {
      error,
      failureCount,
      failedAt: failedAt.toISOString(),
      nextAttemptAt,
    });
    await emitProgress(adapter, 'failed', snapshot);
    throw error;
  };

  if (
    snapshot.status === 'failed'
    && snapshot.nextAttemptAt
    && Date.parse(snapshot.nextAttemptAt) > now().getTime()
  ) {
    return {
      outcome: 'deferred',
      snapshot,
      batchResults,
      progress: await emitProgress(adapter, 'deferred', snapshot),
    };
  }

  while (snapshot.cursor < snapshot.total) {
    const window = {
      start: snapshot.cursor,
      end: Math.min(snapshot.cursor + snapshot.batchSize, snapshot.total),
    };

    try {
      const batch = await adapter.loadBatch(snapshot, window);
      const batchResult = await adapter.executeBatch(snapshot, batch, window);
      const advanced = await adapter.advanceCursor(snapshot, batchResult, window);
      validateSnapshot(advanced);
      if (
        advanced.cursor < window.end
        && advanced.status !== 'partial'
        && advanced.status !== 'completed'
      ) {
        throw new Error(
          `Reconciliation cursor advanced to ${advanced.cursor}; expected at least ${window.end}`,
        );
      }
      snapshot = advanced;
      batchResults.push(batchResult);
      await emitProgress(adapter, 'advanced', snapshot);
      if (snapshot.status === 'partial' || snapshot.status === 'completed') {
        return {
          outcome: 'terminal',
          snapshot,
          batchResults,
          progress: await emitProgress(adapter, 'terminal', snapshot),
        };
      }
    } catch (error) {
      return recordFailure(error);
    }

    if (snapshot.cursor < snapshot.total && !adapter.shouldContinue?.(snapshot)) {
      return {
        outcome: 'running',
        snapshot,
        batchResults,
        progress: adapter.reportProgress(snapshot),
      };
    }
  }

  let completed: Awaited<ReturnType<typeof adapter.complete>>;
  try {
    completed = await adapter.complete(snapshot);
  } catch (error) {
    return recordFailure(error);
  }
  snapshot = completed.snapshot;
  validateSnapshot(snapshot);
  return {
    outcome: 'completed',
    snapshot,
    batchResults,
    completion: completed.result,
    progress: await emitProgress(adapter, 'completed', snapshot),
  };
}
