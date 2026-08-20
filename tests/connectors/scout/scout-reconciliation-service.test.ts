import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/db/schema';
import {
  connectorConfigs,
  scoutReconciliationEvaluations,
  scoutReconciliationRuns,
  scoutReconciliationSuggestions,
  scoutReconciliationTaskState,
  taskHistoryEvents,
  taskProjects,
  tasks,
} from '@/db/schema';
import {
  reconciliationHash,
} from '@/lib/connectors/scout/reconciliation-domain';
import {
  actOnReconciliationSuggestion,
  listReconciliationSuggestions,
  reconcileScoutTasks,
  ScoutReconciliationError,
  suppressAutoCompletionAfterReopen,
  wasTaskAutoCompletedByReconciliation,
} from '@/lib/connectors/scout/reconciliation-service';
import { DEFAULT_SCOUT_SETTINGS } from '@/lib/connectors/scout/settings';

vi.unmock('drizzle-orm');
vi.mock('@/lib/events', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));

const openDatabases: Database.Database[] = [];
const now = new Date('2026-08-05T12:00:00.000Z');

function testDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE connector_configs (
      id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1 NOT NULL, sync_mode TEXT DEFAULT 'poll' NOT NULL,
      poll_interval_minutes INTEGER, capabilities TEXT NOT NULL, credentials TEXT DEFAULT '{}' NOT NULL,
      settings TEXT DEFAULT '{}' NOT NULL, synced_lists TEXT DEFAULT '[]' NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'todo' NOT NULL, priority TEXT DEFAULT 'none' NOT NULL,
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
      parent_id TEXT, depth INTEGER DEFAULT 0 NOT NULL, is_checklist_item INTEGER DEFAULT 0 NOT NULL,
      source_list_id TEXT, source_list_name TEXT, assignee TEXT, micro_status TEXT, status_reason TEXT,
      metadata TEXT DEFAULT '{}' NOT NULL, sync_status TEXT DEFAULT 'synced' NOT NULL,
      last_synced_at TEXT NOT NULL, push_retry_count INTEGER DEFAULT 0 NOT NULL,
      kanban_column TEXT, kanban_order REAL, snoozed_until TEXT, reminder_at TEXT,
      effort INTEGER, is_bulk_import INTEGER DEFAULT 0 NOT NULL,
      local_disposition TEXT DEFAULT 'active' NOT NULL,
      push_count INTEGER DEFAULT 0 NOT NULL
    );
    CREATE TABLE task_projects (task_id TEXT NOT NULL, project_id TEXT NOT NULL);
    CREATE TABLE task_history_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL, task_id TEXT NOT NULL, event_type TEXT NOT NULL,
      field_name TEXT, previous_value TEXT, new_value TEXT, project_id TEXT, phase_id TEXT,
      occurred_at TEXT NOT NULL, recorded_at TEXT NOT NULL, provenance TEXT NOT NULL,
      provenance_ref TEXT, metadata TEXT
    );
    CREATE TRIGGER task_history_task_update
    AFTER UPDATE OF status ON tasks
    WHEN OLD.status IS NOT NEW.status
    BEGIN
      INSERT INTO task_history_events (
        task_id, event_type, field_name, previous_value, new_value,
        occurred_at, recorded_at, provenance, provenance_ref
      ) VALUES (
        NEW.id, 'status_changed', 'status', OLD.status, NEW.status,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        'system', json_object('source', 'test')
      );
    END;
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL UNIQUE, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
      level TEXT DEFAULT 'fyi' NOT NULL, level_rank INTEGER DEFAULT 3 NOT NULL,
      category TEXT DEFAULT 'system' NOT NULL, template_key TEXT, state TEXT DEFAULT 'unread' NOT NULL,
      read_at TEXT, dismissed_at TEXT, resolved_at TEXT, archived_at TEXT,
      is_actionable INTEGER DEFAULT 0 NOT NULL, primary_action_id TEXT, ai_suggested_action_id TEXT,
      received_at TEXT NOT NULL, sort_at TEXT NOT NULL, expires_at TEXT, group_key TEXT, dedupe_key TEXT,
      related_task_id TEXT, related_project_id TEXT, related_entity_type TEXT, related_entity_id TEXT,
      navigation_target TEXT, reconcile_attempts INTEGER DEFAULT 0 NOT NULL,
      last_reconciled_at TEXT, stale_since TEXT, auto_resolve_reason TEXT,
      metadata TEXT DEFAULT '{}' NOT NULL, presentation TEXT DEFAULT '{}' NOT NULL
    );
  `);
  const migration = readFileSync(
    resolve(process.cwd(), 'drizzle/0050_square_stepford_cuckoos.sql'),
    'utf8',
  );
  for (const statement of migration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
  const notificationWritebackMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0061_glamorous_colossus.sql'),
    'utf8',
  );
  for (const statement of notificationWritebackMigration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
  const notificationLifecycleMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0080_split_notification_lifecycle.sql'),
    'utf8',
  );
  for (const statement of notificationLifecycleMigration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
  const githubNotificationLifecycleMigration = readFileSync(
    resolve(process.cwd(), 'drizzle/0082_github_notification_lifecycle.sql'),
    'utf8',
  );
  for (const statement of githubNotificationLifecycleMigration.split('--> statement-breakpoint')) {
    if (statement.trim()) sqlite.exec(statement);
  }
  openDatabases.push(sqlite);
  return drizzle(sqlite, { schema });
}

async function seedScout(
  database: ReturnType<typeof testDatabase>,
  options: {
    taskId?: string;
    priority?: string;
    dueDate?: string | null;
    settings?: typeof DEFAULT_SCOUT_SETTINGS;
  } = {},
) {
  const taskId = options.taskId ?? 'task-1';
  await database.insert(connectorConfigs).values({
    id: 'scout-primary',
    type: 'scout',
    name: 'Scout',
    enabled: true,
    syncMode: 'push',
    capabilities: {
      read: true,
      write: false,
      subtasks: false,
      attachments: false,
      tags: true,
      bidirectionalSync: true,
      statusWriteBack: true,
    },
    credentials: {},
    settings: options.settings ?? DEFAULT_SCOUT_SETTINGS,
    syncedLists: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  });
  await database.insert(tasks).values({
    id: taskId,
    sourceId: `scout:email:${taskId}`,
    connectorType: 'scout',
    connectorInstanceId: 'scout-primary',
    title: `Synthetic ${taskId}`,
    status: 'todo',
    priority: options.priority ?? 'medium',
    dueDate: options.dueDate ?? null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    lastSyncedAt: '2026-08-01T00:00:00.000Z',
  });
  return taskId;
}

function plannerSignal(taskId = 'task-1', signalId = 'planner-1') {
  return {
    signalId,
    taskId,
    sourceType: 'planner' as const,
    kind: 'planner-completed' as const,
    occurredAt: '2026-08-05T11:00:00.000Z',
    summary: 'Synthetic Planner item is marked complete',
    sourceRefHash: '0123456789abcdef'.repeat(4),
  };
}

afterEach(() => {
  while (openDatabases.length) openDatabases.pop()?.close();
});

describe('Scout reconciliation service', () => {
  it('keeps dry runs mutation-free and denies autonomy for unverified evidence', async () => {
    const database = testDatabase();
    await seedScout(database);
    expect(await database.select().from(connectorConfigs).where(and(
      eq(connectorConfigs.type, 'scout'),
      isNull(connectorConfigs.deletedAt),
    ))).toHaveLength(1);
    expect(await database.select().from(tasks).where(and(
      eq(tasks.connectorType, 'scout'),
      inArray(tasks.status, ['todo', 'in_progress']),
      eq(tasks.id, 'task-1'),
    ))).toHaveLength(1);

    const result = await reconcileScoutTasks({
      scope: 'task:task-1',
      dryRun: true,
      sourceIdentity: 'dry-run-1',
      signals: [plannerSignal()],
    }, { database, now });

    expect(result.reconciled[0]).toMatchObject({
      candidateAction: 'auto-complete',
      action: 'suggest-complete',
      policyDecision: 'deny',
      applied: false,
    });
    expect(Object.keys(result).sort()).toEqual([
      'dryRun',
      'idempotentReplay',
      'reconciled',
      'runId',
      'summary',
    ]);
    expect(Object.keys(result.reconciled[0]).sort()).toEqual([
      'action',
      'applied',
      'appliedResult',
      'candidateAction',
      'confidence',
      'policyDecision',
      'policyReason',
      'signals',
      'taskId',
      'title',
    ]);
    expect((await database.select().from(tasks).where(eq(tasks.id, 'task-1')))[0].status).toBe('todo');
    expect(await database.select().from(scoutReconciliationSuggestions)).toHaveLength(0);
  });

  it('auto-completes only under explicit source-scoped policy and records task history', async () => {
    const database = testDatabase();
    await seedScout(database, {
      settings: {
        ...DEFAULT_SCOUT_SETTINGS,
        autonomy: {
          ...DEFAULT_SCOUT_SETTINGS.autonomy,
          autoExecuteActions: [{
            action: 'complete-task',
            sourceTypes: ['planner'],
            target: 'scout-originated',
            minimumConfidence: 0.95,
          }],
        },
      },
    });

    const result = await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'authorized-run-1',
      signals: [plannerSignal()],
    }, {
      database,
      now,
      verifiedSourceRefHashes: new Set([plannerSignal().sourceRefHash]),
    });

    expect(result.reconciled[0]).toMatchObject({
      action: 'auto-complete',
      policyDecision: 'allow',
      applied: true,
    });
    expect((await database.select().from(tasks).where(eq(tasks.id, 'task-1')))[0].status).toBe('done');
    expect(await database.select().from(taskHistoryEvents).where(eq(taskHistoryEvents.eventType, 'status_changed')))
      .toEqual([expect.objectContaining({ taskId: 'task-1', previousValue: 'todo', newValue: 'done' })]);
    expect(await wasTaskAutoCompletedByReconciliation('task-1', database)).toBe(true);
  });

  it('replays duplicate runs idempotently without duplicate evaluations', async () => {
    const database = testDatabase();
    await seedScout(database);
    const request = {
      scope: 'task:task-1',
      dryRun: true,
      sourceIdentity: 'retryable-run',
      idempotencyKey: 'retryable-run-key',
      signals: [plannerSignal()],
    };

    const first = await reconcileScoutTasks(request, { database, now });
    const replay = await reconcileScoutTasks(request, { database, now });

    expect(replay).toMatchObject({ runId: first.runId, idempotentReplay: true });
    expect(await database.select().from(scoutReconciliationRuns)).toHaveLength(1);
    expect(await database.select().from(scoutReconciliationEvaluations)).toHaveLength(1);
    await expect(reconcileScoutTasks({
      ...request,
      signals: [{ ...plannerSignal(), summary: 'Changed evidence under the same key' }],
    }, { database, now })).rejects.toMatchObject({ status: 409 });
  });

  it('recovers an exact stale idempotent run without changing its run identity', async () => {
    const database = testDatabase();
    await seedScout(database);
    const request = {
      scope: 'task:task-1',
      sourceIdentity: 'stale-retry',
      idempotencyKey: 'stale-retry-key',
      signals: [plannerSignal()],
    };
    const requestHash = reconciliationHash({
      scope: { type: 'task', id: 'task-1', key: 'task:task-1' },
      lookbackHours: 48,
      dryRun: false,
      source: 'api',
      sourceIdentity: request.sourceIdentity,
      signals: request.signals,
    });
    await database.insert(scoutReconciliationRuns).values({
      id: 'stale-run',
      scopeKey: 'task:task-1',
      scopeType: 'task',
      scopeId: 'task-1',
      lookbackHours: 48,
      dryRun: false,
      source: 'api',
      sourceIdentity: request.sourceIdentity,
      idempotencyKey: request.idempotencyKey,
      requestHash,
      leaseToken: 'stale-lease',
      status: 'running',
      startedAt: '2026-08-05T11:00:00.000Z',
    });

    const result = await reconcileScoutTasks(request, { database, now });
    const staleFailure = database.update(scoutReconciliationRuns).set({
      status: 'failed',
      error: 'late original worker',
    }).where(and(
      eq(scoutReconciliationRuns.id, 'stale-run'),
      eq(scoutReconciliationRuns.leaseToken, 'stale-lease'),
    )).run();

    expect(result.runId).toBe('stale-run');
    expect(staleFailure.changes).toBe(0);
    expect((await database.select().from(scoutReconciliationRuns))[0].status).toBe('completed');
  });

  it('rolls back all task and suggestion effects when a later evaluation fails', async () => {
    const database = testDatabase();
    await seedScout(database, {
      settings: {
        ...DEFAULT_SCOUT_SETTINGS,
        autonomy: {
          ...DEFAULT_SCOUT_SETTINGS.autonomy,
          autoExecuteActions: [{
            action: 'complete-task',
            sourceTypes: ['planner'],
            target: 'scout-originated',
            minimumConfidence: 0.95,
          }],
        },
      },
    });
    await database.insert(tasks).values({
      id: 'task-2',
      sourceId: 'scout:planner:task-2',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
      title: 'Synthetic task-2',
      status: 'todo',
      priority: 'medium',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastSyncedAt: '2026-08-01T00:00:00.000Z',
    });
    openDatabases.at(-1)!.exec(`
      CREATE TRIGGER fail_second_reconciliation_evaluation
      BEFORE INSERT ON scout_reconciliation_evaluations
      WHEN NEW.task_id = 'task-2'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic evaluation failure');
      END;
    `);
    const sourceRefHash = plannerSignal().sourceRefHash;

    await expect(reconcileScoutTasks({
      scope: 'all',
      sourceIdentity: 'atomic-failure',
      idempotencyKey: 'atomic-failure-key',
      signals: [
        plannerSignal('task-1', 'signal-1'),
        plannerSignal('task-2', 'signal-2'),
      ],
    }, {
      database,
      now,
      verifiedSourceRefHashes: new Set([sourceRefHash]),
    })).rejects.toThrow('synthetic evaluation failure');

    expect((await database.select().from(tasks)).map((task) => task.status)).toEqual(['todo', 'todo']);
    expect(await database.select().from(scoutReconciliationEvaluations)).toHaveLength(0);
    expect(await database.select().from(scoutReconciliationSuggestions)).toHaveLength(0);
    expect((await database.select().from(scoutReconciliationRuns))[0]).toMatchObject({ status: 'failed' });
  });

  it('locks duplicate scopes and rate-limits full applied runs', async () => {
    const database = testDatabase();
    await seedScout(database);
    await database.insert(scoutReconciliationRuns).values({
      id: 'running-1',
      scopeKey: 'task:task-1',
      scopeType: 'task',
      scopeId: 'task-1',
      lookbackHours: 48,
      dryRun: false,
      source: 'api',
      sourceIdentity: 'other-run',
      idempotencyKey: 'other-run-key',
      requestHash: 'other-request-hash',
      leaseToken: 'active-lease',
      status: 'running',
      startedAt: now.toISOString(),
    });

    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'locked-run',
      idempotencyKey: 'locked-run-key',
      signals: [],
    }, { database, now })).rejects.toMatchObject({ status: 409 });

    await database.update(scoutReconciliationRuns).set({
      status: 'failed',
      completedAt: now.toISOString(),
    }).where(eq(scoutReconciliationRuns.id, 'running-1'));
    await reconcileScoutTasks({
      scope: 'all',
      sourceIdentity: 'full-run-1',
      idempotencyKey: 'full-run-key-1',
      signals: [],
    }, { database, now });
    await expect(reconcileScoutTasks({
      scope: 'all',
      sourceIdentity: 'full-run-2',
      idempotencyKey: 'full-run-key-2',
      signals: [],
    }, { database, now })).rejects.toMatchObject({ status: 429 });
  });

  it('honors project and task scopes while reporting ignored signals', async () => {
    const database = testDatabase();
    await seedScout(database, { taskId: 'task-1' });
    await database.insert(tasks).values({
      id: 'task-2',
      sourceId: 'scout:email:task-2',
      connectorType: 'scout',
      connectorInstanceId: 'scout-primary',
      title: 'Synthetic task-2',
      status: 'todo',
      priority: 'medium',
      createdAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      lastSyncedAt: '2026-08-01T00:00:00.000Z',
    });
    await database.insert(taskProjects).values({ taskId: 'task-1', projectId: 'project-1' });

    const result = await reconcileScoutTasks({
      scope: 'project:project-1',
      dryRun: true,
      sourceIdentity: 'project-run',
      signals: [plannerSignal('task-1', 'signal-1'), plannerSignal('task-2', 'signal-2')],
    }, { database, now });

    expect(result.reconciled.map((item) => item.taskId)).toEqual(['task-1']);
    expect(result.summary.ignoredSignals).toBe(1);
  });

  it('binds acceptance to the proposal hash and records confirmed completion', async () => {
    const database = testDatabase();
    await seedScout(database);
    await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'suggestion-run',
      idempotencyKey: 'suggestion-run-key',
      signals: [plannerSignal()],
    }, { database, now });
    const [suggestion] = await listReconciliationSuggestions({ database, now });

    await expect(actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: 'f'.repeat(64),
      actor: 'test-user',
    }, { database, now })).rejects.toMatchObject({ status: 409 });
    const accepted = await actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { database, now });
    const replay = await actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { database, now });

    expect(accepted).toMatchObject({ status: 'accepted', idempotentReplay: false });
    expect(replay).toMatchObject({ status: 'accepted', idempotentReplay: true });
    expect((await database.select().from(tasks).where(eq(tasks.id, 'task-1')))[0].status).toBe('done');
    expect((await database.select().from(scoutReconciliationEvaluations))[0]).toMatchObject({
      applied: true,
      appliedResult: expect.objectContaining({ confirmationActor: 'test-user' }),
    });
  });

  it('suppresses dismissed evidence and persists never-auto-complete decisions', async () => {
    const database = testDatabase();
    await seedScout(database);
    await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'dismiss-run-1',
      idempotencyKey: 'dismiss-run-key-1',
      signals: [plannerSignal()],
    }, { database, now });
    const [suggestion] = await listReconciliationSuggestions({ database, now });
    await actOnReconciliationSuggestion(suggestion.id, {
      action: 'never-auto-complete',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { database, now });

    const repeated = await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'dismiss-run-2',
      idempotencyKey: 'dismiss-run-key-2',
      signals: [plannerSignal()],
    }, { database, now: new Date('2026-08-05T12:01:00.000Z') });

    expect(repeated.reconciled[0]).toMatchObject({
      candidateAction: 'auto-complete',
      action: 'no-change',
      policyDecision: 'deny',
    });
    expect((await database.select().from(scoutReconciliationTaskState))[0]).toMatchObject({
      taskId: 'task-1',
      neverAutoComplete: true,
      reason: 'user_requested',
    });
    expect(await database.select().from(scoutReconciliationSuggestions)
      .where(eq(scoutReconciliationSuggestions.status, 'pending'))).toHaveLength(0);
  });

  it('supersedes pending suggestions after the task becomes terminal', async () => {
    const database = testDatabase();
    await seedScout(database);
    await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'terminal-suggestion',
      signals: [plannerSignal()],
    }, { database, now });
    await database.update(tasks).set({
      status: 'done',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(eq(tasks.id, 'task-1'));

    expect(await listReconciliationSuggestions({ database, now })).toHaveLength(0);
    expect((await database.select().from(scoutReconciliationSuggestions))[0].status).toBe('superseded');
  });

  it('persists reopen suppression after an autonomous completion', async () => {
    const database = testDatabase();
    await seedScout(database, {
      settings: {
        ...DEFAULT_SCOUT_SETTINGS,
        autonomy: {
          ...DEFAULT_SCOUT_SETTINGS.autonomy,
          autoExecuteActions: [{
            action: 'complete-task',
            sourceTypes: ['planner'],
            target: 'scout-originated',
            minimumConfidence: 0.95,
          }],
        },
      },
    });
    await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'auto-run',
      signals: [plannerSignal()],
    }, {
      database,
      now,
      verifiedSourceRefHashes: new Set([plannerSignal().sourceRefHash]),
    });

    database.transaction((tx) => {
      tx.update(tasks).set({
        status: 'todo',
        completedAt: null,
        updatedAt: '2026-08-05T12:05:00.000Z',
      }).where(eq(tasks.id, 'task-1')).run();
      suppressAutoCompletionAfterReopen(tx, 'task-1', '2026-08-05T12:05:00.000Z');
    });

    expect((await database.select().from(scoutReconciliationTaskState))[0]).toMatchObject({
      neverAutoComplete: true,
      reason: 'reopened_after_auto_completion',
    });
    const result = await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'post-reopen-run',
      idempotencyKey: 'post-reopen-run-key',
      signals: [plannerSignal('task-1', 'planner-after-reopen')],
    }, { database, now: new Date('2026-08-05T12:06:00.000Z') });
    expect(result.reconciled[0]).toMatchObject({
      action: 'suggest-complete',
      policyDecision: 'deny',
    });
  });

  it('rejects malformed or duplicate signal identities without a success result', async () => {
    const database = testDatabase();
    await seedScout(database);
    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'malformed-run',
      signals: [{ ...plannerSignal(), summary: 'raw\ncontent' }],
    }, { database, now })).rejects.toBeInstanceOf(ScoutReconciliationError);
    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'duplicate-signals',
      signals: [plannerSignal(), plannerSignal()],
    }, { database, now })).rejects.toMatchObject({ status: 400 });
    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'duplicate-artifacts',
      signals: [
        plannerSignal('task-1', 'planner-1'),
        plannerSignal('task-1', 'planner-2'),
      ],
    }, { database, now })).rejects.toMatchObject({ status: 400 });
  });
});
