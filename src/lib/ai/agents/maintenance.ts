import type Database from 'better-sqlite3';
import { NOTIFICATION_IS_INBOX_SQL } from '@/lib/notifications/lifecycle-sql';
import { randomUUID } from 'node:crypto';
import { sqlite } from '@/db';
import { formatDateInLocalTimezone } from '@/lib/utils/date';

export const MAINTENANCE_AGENT_BUDGETS = {
  scanLimit: 101,
  mutationLimit: 100,
  detailLimit: 20,
  durationMs: 5_000,
} as const;

export type MaintenanceAgentType =
  | 'dismiss-old-notifications'
  | 'bulk-prioritize'
  | 'cleanup-done'
  | 'snooze-low-priority';

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
  database?: Database.Database;
}

export class MaintenanceAgentConflictError extends Error {
  constructor(agentType: MaintenanceAgentType) {
    super(`${agentType} is already running`);
    this.name = 'MaintenanceAgentConflictError';
  }
}

interface Candidate {
  id: string;
  title: string;
  result?: string;
}

interface ScanRow extends Candidate {
  eligible: number;
}

interface BatchPlan {
  candidates: Candidate[];
  scanned: number;
  checkpoint: string | null;
  hasMore: boolean;
  action: string;
  dryRunAction: string;
  summaryVerb: string;
  completedVerb: string;
  objectDescription: string;
  mutate: (ids: string[], now: string) => void;
}

interface PreviousRun {
  status: string;
  checkpointEnd: string | null;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function localDaysFrom(date: Date, days: number): string {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + days);
  return formatDateInLocalTimezone(shifted);
}

function createBatchPlan(
  rows: ScanRow[],
  definition: Omit<BatchPlan, 'candidates' | 'scanned' | 'checkpoint' | 'hasMore'>,
): BatchPlan {
  const hasMore = rows.length > MAINTENANCE_AGENT_BUDGETS.mutationLimit;
  const scanWindow = rows.slice(0, MAINTENANCE_AGENT_BUDGETS.mutationLimit);
  return {
    ...definition,
    candidates: scanWindow
      .filter((row) => row.eligible === 1)
      .map(({ id, title, result }) => ({ id, title, result })),
    scanned: rows.length,
    checkpoint: hasMore ? scanWindow.at(-1)?.id ?? null : null,
    hasMore,
  };
}

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

function buildBatchPlan(
  database: Database.Database,
  agentType: MaintenanceAgentType,
  cursor: string | null,
  now: Date,
): BatchPlan {
  const cursorClause = cursor ? ' AND id > ?' : '';
  const cursorArgs = cursor ? [cursor] : [];
  const limit = MAINTENANCE_AGENT_BUDGETS.scanLimit;

  switch (agentType) {
    case 'dismiss-old-notifications': {
      const cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString();
      const rows = database.prepare(`
        SELECT id, title,
          CASE
            WHEN ${NOTIFICATION_IS_INBOX_SQL}
              AND read_state = 'unread'
              AND level IN ('fyi', 'digest')
              AND received_at < ?
            THEN 1 ELSE 0
          END AS eligible
        FROM notifications
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(now.toISOString(), cutoff, ...cursorArgs, limit) as ScanRow[];
      return createBatchPlan(rows, {
        action: 'dismiss',
        dryRunAction: 'would_dismiss',
        summaryVerb: 'dismiss',
        completedVerb: 'Dismissed',
        objectDescription: 'old low-severity notifications',
        mutate: (ids, timestamp) => {
          database.prepare(`
            UPDATE notifications
            SET state = 'dismissed',
                read_state = 'read',
                disposition = 'dismissed',
                read_at = COALESCE(read_at, ?),
                dismissed_at = ?
            WHERE id IN (${placeholders(ids.length)})
          `).run(timestamp, timestamp, ...ids);
        },
      });
    }
    case 'cleanup-done': {
      const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1_000).toISOString();
      const rows = database.prepare(`
        SELECT id, title,
          CASE
            WHEN status = 'done'
              AND completed_at IS NOT NULL
              AND completed_at < ?
            THEN 1 ELSE 0
          END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(cutoff, ...cursorArgs, limit) as ScanRow[];
      return createBatchPlan(rows, {
        action: 'archive',
        dryRunAction: 'would_archive',
        summaryVerb: 'archive',
        completedVerb: 'Archived',
        objectDescription: 'tasks completed 30+ days ago',
        mutate: (ids, timestamp) => {
          database.prepare(`
            UPDATE tasks
            SET status = 'cancelled', updated_at = ?
            WHERE id IN (${placeholders(ids.length)})
          `).run(timestamp, ...ids);
        },
      });
    }
    case 'snooze-low-priority': {
      const today = localDaysFrom(now, 0);
      const newDate = localDaysFrom(now, 7);
      const rows = database.prepare(`
        SELECT id, title, 'due date -> ${newDate}' AS result,
          CASE
            WHEN status = 'todo'
              AND due_date IS NOT NULL
              AND due_date < ?
              AND priority IN ('low', 'none')
            THEN 1 ELSE 0
          END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(today, ...cursorArgs, limit) as ScanRow[];
      return createBatchPlan(rows, {
        action: 'snooze',
        dryRunAction: 'would_snooze',
        summaryVerb: 'snooze',
        completedVerb: 'Snoozed',
        objectDescription: `overdue low-priority tasks to ${newDate}`,
        mutate: (ids, timestamp) => {
          database.prepare(`
            UPDATE tasks
            SET due_date = ?, updated_at = ?
            WHERE id IN (${placeholders(ids.length)})
          `).run(newDate, timestamp, ...ids);
        },
      });
    }
    case 'bulk-prioritize': {
      const today = localDaysFrom(now, 0);
      const tomorrow = localDaysFrom(now, 1);
      const threeDays = localDaysFrom(now, 3);
      const rows = database.prepare(`
        SELECT id, title, priority, due_date AS dueDate,
          CASE
            WHEN status = 'todo'
              AND due_date IS NOT NULL
              AND (
                (due_date <= ? AND priority <> 'critical')
                OR (due_date > ? AND due_date <= ? AND priority = 'none')
                OR (due_date > ? AND due_date <= ? AND priority = 'none')
              )
            THEN 1 ELSE 0
          END AS eligible
        FROM tasks
        WHERE 1 = 1 ${cursorClause}
        ORDER BY id
        LIMIT ?
      `).all(today, today, tomorrow, tomorrow, threeDays, ...cursorArgs, limit) as Array<
        ScanRow & { priority: string; dueDate: string }
      >;
      const candidates = rows.map((row) => {
        const priority = row.dueDate <= today
          ? 'critical'
          : row.dueDate <= tomorrow
            ? 'high'
            : 'medium';
        return {
          id: row.id,
          title: row.title,
          result: `${row.priority} -> ${priority}`,
          eligible: row.eligible,
        };
      });
      return createBatchPlan(candidates, {
        action: 'reprioritize',
        dryRunAction: 'would_reprioritize',
        summaryVerb: 'update priority for',
        completedVerb: 'Updated priority for',
        objectDescription: 'tasks based on due dates',
        mutate: (ids, timestamp) => {
          database.prepare(`
            UPDATE tasks
            SET priority = CASE
              WHEN due_date <= ? THEN 'critical'
              WHEN due_date <= ? THEN 'high'
              ELSE 'medium'
            END,
            updated_at = ?
            WHERE id IN (${placeholders(ids.length)})
          `).run(today, tomorrow, timestamp, ...ids);
        },
      });
    }
  }
}

function finishRun(
  database: Database.Database,
  runId: string,
  status: string,
  completedAt: string,
  values: {
    checkpoint: string | null;
    scanned: number;
    mutations: number;
    hasMore: boolean;
    error?: string;
  },
): void {
  database.prepare(`
    UPDATE maintenance_agent_runs
    SET status = ?,
        checkpoint_end = ?,
        scanned_count = ?,
        mutation_count = ?,
        has_more = ?,
        error_message = ?,
        completed_at = ?
    WHERE id = ?
  `).run(
    status,
    values.checkpoint,
    values.scanned,
    values.mutations,
    values.hasMore ? 1 : 0,
    values.error ?? null,
    completedAt,
    runId,
  );
}

export function executeMaintenanceAgent(
  agentType: MaintenanceAgentType,
  options: MaintenanceAgentOptions = {},
): MaintenanceAgentResult {
  const database = options.database ?? sqlite;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? Date.now;
  const started = now();
  const startedAt = started.toISOString();
  const deadline = clock() + MAINTENANCE_AGENT_BUDGETS.durationMs;
  const dryRun = options.dryRun ?? false;
  const runId = randomUUID();

  let cursor = options.cursor ?? null;
  database.transaction(() => {
      database.prepare(`
        UPDATE maintenance_agent_runs
        SET status = 'timed_out',
            has_more = 1,
            error_message = 'Lease expired before the run completed',
            completed_at = ?
        WHERE agent_type = ?
          AND status = 'running'
          AND lease_expires_at <= ?
      `).run(startedAt, agentType, startedAt);

      if (!cursor && !dryRun) {
        const previous = database.prepare(`
          SELECT status, checkpoint_end AS checkpointEnd
          FROM maintenance_agent_runs
          WHERE agent_type = ? AND dry_run = 0
          ORDER BY started_at DESC, rowid DESC
          LIMIT 1
        `).get(agentType) as PreviousRun | undefined;
        if (previous?.status === 'partial') cursor = previous.checkpointEnd;
      }

      try {
        database.prepare(`
          INSERT INTO maintenance_agent_runs (
            id, agent_type, status, dry_run, checkpoint_start,
            lease_expires_at, started_at
          ) VALUES (?, ?, 'running', ?, ?, ?, ?)
        `).run(
          runId,
          agentType,
          dryRun ? 1 : 0,
          cursor,
          new Date(started.getTime() + MAINTENANCE_AGENT_BUDGETS.durationMs + 1_000).toISOString(),
          startedAt,
        );
      } catch (error) {
        if (
          typeof error === 'object'
          && error !== null
          && 'code' in error
          && String(error.code).startsWith('SQLITE_CONSTRAINT')
        ) {
          throw new MaintenanceAgentConflictError(agentType);
        }
        throw error;
      }
  }).immediate();

  let scanned = 0;
  try {
    throwIfStopped(options.signal, deadline, clock);
    const completedAt = now().toISOString();
    let plan: BatchPlan | undefined;
    let batch: Candidate[] = [];
    let checkpoint: string | null = null;
    let hasMore = false;
    database.transaction(() => {
      throwIfStopped(options.signal, deadline, clock);
      plan = buildBatchPlan(database, agentType, cursor, started);
      hasMore = plan.hasMore;
      batch = plan.candidates;
      scanned = plan.scanned;
      checkpoint = plan.checkpoint;
      throwIfStopped(options.signal, deadline, clock);
      if (!dryRun && batch.length > 0) {
        plan.mutate(batch.map((candidate) => candidate.id), completedAt);
      }
      throwIfStopped(options.signal, deadline, clock);
      finishRun(database, runId, hasMore ? 'partial' : 'succeeded', completedAt, {
        checkpoint,
        scanned,
        mutations: dryRun ? 0 : batch.length,
        hasMore,
      });
    }).immediate();
    if (!plan) throw new Error('Maintenance batch did not initialize');
    const completedPlan = plan;

    const count = batch.length;
    const verb = dryRun ? `Would ${completedPlan.summaryVerb}` : completedPlan.completedVerb;
    return {
      agent: agentType,
      status: hasMore ? 'partial' : 'success',
      summary: `${verb} ${count} ${completedPlan.objectDescription}${hasMore ? '; more work remains' : ''}`,
      actionsPerformed: count,
      details: batch.slice(0, MAINTENANCE_AGENT_BUDGETS.detailLimit).map((candidate) => ({
        action: dryRun ? completedPlan.dryRunAction : completedPlan.action,
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
    finishRun(database, runId, stopReason === 'error' ? 'failed' : stopReason, completedAt, {
      checkpoint: cursor,
      scanned,
      mutations: 0,
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
