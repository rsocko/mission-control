import { randomUUID } from 'node:crypto';
import { getAIWorkflowPersistence } from '@/lib/ai/workflow-persistence';
import type {
  AIMaintenancePersistence,
  MaintenanceAgentType,
} from '@/db/persistence/ai-workflows';

export const MAINTENANCE_AGENT_BUDGETS = {
  scanLimit: 101,
  mutationLimit: 100,
  detailLimit: 20,
  durationMs: 5_000,
} as const;

export type { MaintenanceAgentType };

export interface MaintenanceAgentResult {
  agent: MaintenanceAgentType;
  status: 'success' | 'partial' | 'failed';
  summary: string;
  actionsPerformed: number;
  details: Array<{ action: string; target: string; result: string }>;
  startedAt: string;
  completedAt: string;
  checkpoint: string | null;
  hasMore: boolean;
  scanned: number;
  remainingWork: 'none' | 'more' | 'unknown';
  stopReason?: 'cancelled' | 'timed_out' | 'error';
  budgets: typeof MAINTENANCE_AGENT_BUDGETS;
}

export interface MaintenanceAgentOptions {
  dryRun?: boolean;
  cursor?: string;
  signal?: AbortSignal;
  now?: () => Date;
  clock?: () => number;
  /** Test-only seam for injecting a fake persistence port. */
  persistence?: AIMaintenancePersistence;
}

export class MaintenanceAgentConflictError extends Error {
  constructor(agentType: MaintenanceAgentType) {
    super(`${agentType} is already running`);
    this.name = 'MaintenanceAgentConflictError';
  }
}

const AGENT_DESCRIPTORS: Record<MaintenanceAgentType, {
  action: string;
  dryRunAction: string;
  summaryVerb: string;
  completedVerb: string;
  objectDescription: string;
}> = {
  'dismiss-old-notifications': {
    action: 'dismiss',
    dryRunAction: 'would_dismiss',
    summaryVerb: 'dismiss',
    completedVerb: 'Dismissed',
    objectDescription: 'old low-severity notifications',
  },
  'cleanup-done': {
    action: 'archive',
    dryRunAction: 'would_archive',
    summaryVerb: 'archive',
    completedVerb: 'Archived',
    objectDescription: 'tasks completed 30+ days ago',
  },
  'snooze-low-priority': {
    action: 'snooze',
    dryRunAction: 'would_snooze',
    summaryVerb: 'snooze',
    completedVerb: 'Snoozed',
    objectDescription: 'overdue low-priority tasks',
  },
  'bulk-prioritize': {
    action: 'reprioritize',
    dryRunAction: 'would_reprioritize',
    summaryVerb: 'update priority for',
    completedVerb: 'Updated priority for',
    objectDescription: 'tasks based on due dates',
  },
};

function throwIfStopped(
  signal: AbortSignal | undefined,
  deadline: number,
  clock: () => number,
): void {
  if (signal?.aborted) {
    throw new DOMException('Maintenance agent cancelled', 'AbortError');
  }
  if (clock() >= deadline) {
    throw new DOMException('Maintenance agent exceeded its duration budget', 'TimeoutError');
  }
}

export async function executeMaintenanceAgent(
  agentType: MaintenanceAgentType,
  options: MaintenanceAgentOptions = {},
): Promise<MaintenanceAgentResult> {
  const persistence = options.persistence
    ?? (await getAIWorkflowPersistence()).maintenance;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const started = now();
  const startedAt = started.toISOString();
  const deadline = clock() + MAINTENANCE_AGENT_BUDGETS.durationMs;
  const dryRun = options.dryRun ?? false;
  const runId = randomUUID();
  const descriptor = AGENT_DESCRIPTORS[agentType];

  const claim = await persistence.claimRun({
    runId,
    agentType,
    dryRun,
    cursor: options.cursor ?? null,
    leaseExpiresAt: new Date(started.getTime() + MAINTENANCE_AGENT_BUDGETS.durationMs + 1_000).toISOString(),
    startedAt,
  });
  if (!claim.claimed) {
    throw new MaintenanceAgentConflictError(agentType);
  }
  const cursor = claim.cursor;

  let scanned = 0;
  try {
    throwIfStopped(options.signal, deadline, clock);

    const rows = await persistence.scanBatch({
      agentType,
      cursor,
      limit: MAINTENANCE_AGENT_BUDGETS.scanLimit,
      now: startedAt,
    });
    throwIfStopped(options.signal, deadline, clock);
    scanned = rows.length;
    const hasMore = rows.length > MAINTENANCE_AGENT_BUDGETS.mutationLimit;
    const scanWindow = rows.slice(0, MAINTENANCE_AGENT_BUDGETS.mutationLimit);
    const candidates = scanWindow.filter((row) => row.eligible);
    const checkpoint = hasMore ? (scanWindow.at(-1)?.id ?? null) : null;

    throwIfStopped(options.signal, deadline, clock);
    // `completedAt` is taken here, once the scan is done and the commit is
    // about to run, so it reflects when the batch completed rather than when
    // the run started.
    const completedAt = now().toISOString();
    // Mutating and recording the run's terminal checkpoint happen in one
    // atomic commit: `guard` runs after the mutation but before the commit,
    // so a deadline/cancellation detected there rolls the mutation back too.
    // The adapter re-checks eligibility inside the mutation and reports both
    // how many rows it actually changed and exactly which ones.
    const { applied, appliedIds } = await persistence.commitBatch({
      runId,
      agentType,
      ids: !dryRun && candidates.length > 0 ? candidates.map((candidate) => candidate.id) : [],
      now: startedAt,
      completedAt,
      status: hasMore ? 'partial' : 'succeeded',
      checkpoint,
      scanned,
      hasMore,
      guard: () => throwIfStopped(options.signal, deadline, clock),
    });

    const count = dryRun ? candidates.length : applied;
    // A dry run reports every candidate it would have touched; a real run
    // reports only the rows the commit actually mutated, so a candidate that
    // stopped being eligible between the scan and the commit is never named.
    // Filtering the scan window keeps the details in scan order.
    const mutated = new Set(appliedIds);
    const reported = dryRun
      ? candidates
      : candidates.filter((candidate) => mutated.has(candidate.id));
    const verb = dryRun ? `Would ${descriptor.summaryVerb}` : descriptor.completedVerb;
    return {
      agent: agentType,
      status: hasMore ? 'partial' : 'success',
      summary: `${verb} ${count} ${descriptor.objectDescription}${hasMore ? '; more work remains' : ''}`,
      actionsPerformed: count,
      details: reported
        .slice(0, MAINTENANCE_AGENT_BUDGETS.detailLimit)
        .map((candidate) => ({
          action: dryRun ? descriptor.dryRunAction : descriptor.action,
          target: candidate.title,
          result: dryRun ? candidate.result ?? 'dry run' : candidate.result ?? 'completed',
        })),
      startedAt,
      completedAt,
      checkpoint,
      hasMore,
      scanned,
      remainingWork: hasMore ? 'more' : 'none',
      budgets: MAINTENANCE_AGENT_BUDGETS,
    };
  } catch (error) {
    const completedAt = now().toISOString();
    const stopReason = error instanceof DOMException && error.name === 'AbortError'
      ? 'cancelled'
      : error instanceof DOMException && error.name === 'TimeoutError'
        ? 'timed_out'
        : 'error';
    const message = error instanceof Error ? error.message : String(error);
    await persistence.commitBatch({
      runId,
      agentType,
      ids: [],
      now: startedAt,
      completedAt,
      status: stopReason === 'error' ? 'failed' : stopReason,
      checkpoint: cursor,
      scanned,
      hasMore: true,
      error: message,
    });
    return {
      agent: agentType,
      status: 'failed',
      summary: `${agentType} ${stopReason.replace('_', ' ')} after 0 mutations: ${message}`,
      actionsPerformed: 0,
      details: [],
      startedAt,
      completedAt,
      checkpoint: cursor,
      hasMore: true,
      scanned,
      remainingWork: 'unknown',
      stopReason,
      budgets: MAINTENANCE_AGENT_BUDGETS,
    };
  }
}
