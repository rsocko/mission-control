import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
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
  wasTaskAutoCompletedByReconciliation,
} from '@/lib/connectors/scout/reconciliation-service';
import { DEFAULT_SCOUT_SETTINGS } from '@/lib/connectors/scout/settings';
import {
  createSqliteScoutIngestionReconciliationRepository,
} from '@/db/persistence/sqlite-scout-ingestion-reconciliation-repository';
import {
  describeScoutIngestionReconciliationContract,
  SCOUT_NOW,
  type ScoutPersistenceContractHarness,
} from '../../contracts/scout-ingestion-reconciliation-persistence.contract';

vi.unmock('drizzle-orm');
vi.mock('@/lib/events', () => ({ emitEvent: vi.fn().mockResolvedValue(undefined) }));

const openDatabases: Database.Database[] = [];
const now = new Date('2026-08-05T12:00:00.000Z');
let persistence: ReturnType<typeof createSqliteScoutIngestionReconciliationRepository>;

function testDatabase() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE connector_configs (
      id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER DEFAULT 1 NOT NULL, sync_mode TEXT DEFAULT 'poll' NOT NULL,
      poll_interval_minutes INTEGER, capabilities TEXT NOT NULL, credentials TEXT DEFAULT '{}' NOT NULL,
      settings TEXT DEFAULT '{}' NOT NULL, synced_lists TEXT DEFAULT '[]' NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      last_test_status TEXT, last_test_error TEXT, last_test_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY NOT NULL, source_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT DEFAULT 'todo' NOT NULL, priority TEXT DEFAULT 'none' NOT NULL,
      planning_horizon TEXT,
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
      deleted_at TEXT,
      parent_id TEXT, sibling_order INTEGER, subtask_order_revision INTEGER DEFAULT 0 NOT NULL,
      depth INTEGER DEFAULT 0 NOT NULL, is_checklist_item INTEGER DEFAULT 0 NOT NULL,
      source_list_id TEXT, source_list_name TEXT, assignee TEXT, micro_status TEXT, status_reason TEXT,
      metadata TEXT DEFAULT '{}' NOT NULL, sync_status TEXT DEFAULT 'synced' NOT NULL,
      last_synced_at TEXT NOT NULL, push_retry_count INTEGER DEFAULT 0 NOT NULL,
      kanban_column TEXT, kanban_order REAL, snoozed_until TEXT, reminder_at TEXT,
      reminder_relative TEXT, reminder_due_time TEXT,
      effort INTEGER, is_bulk_import INTEGER DEFAULT 0 NOT NULL,
      local_disposition TEXT DEFAULT 'active' NOT NULL,
      push_count INTEGER DEFAULT 0 NOT NULL,
      recurrence_generated_from_task_id TEXT
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
      metadata TEXT DEFAULT '{}' NOT NULL, presentation TEXT DEFAULT '{}' NOT NULL,
      enrichment_revision TEXT, enrichment_generation INTEGER DEFAULT 0 NOT NULL
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
  persistence = createSqliteScoutIngestionReconciliationRepository(sqlite);
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
    }, { persistence, now });

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
      persistence,
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
    expect(await wasTaskAutoCompletedByReconciliation('task-1', { persistence })).toBe(true);
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

    const first = await reconcileScoutTasks(request, { persistence, now });
    const replay = await reconcileScoutTasks(request, { persistence, now });

    expect(replay).toMatchObject({ runId: first.runId, idempotentReplay: true });
    expect(await database.select().from(scoutReconciliationRuns)).toHaveLength(1);
    expect(await database.select().from(scoutReconciliationEvaluations)).toHaveLength(1);
    await expect(reconcileScoutTasks({
      ...request,
      signals: [{ ...plannerSignal(), summary: 'Changed evidence under the same key' }],
    }, { persistence, now })).rejects.toMatchObject({ status: 409 });
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

    const result = await reconcileScoutTasks(request, { persistence, now });
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
      persistence,
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
    }, { persistence, now })).rejects.toMatchObject({ status: 409 });

    await database.update(scoutReconciliationRuns).set({
      status: 'failed',
      completedAt: now.toISOString(),
    }).where(eq(scoutReconciliationRuns.id, 'running-1'));
    await reconcileScoutTasks({
      scope: 'all',
      sourceIdentity: 'full-run-1',
      idempotencyKey: 'full-run-key-1',
      signals: [],
    }, { persistence, now });
    await expect(reconcileScoutTasks({
      scope: 'all',
      sourceIdentity: 'full-run-2',
      idempotencyKey: 'full-run-key-2',
      signals: [],
    }, { persistence, now })).rejects.toMatchObject({ status: 429 });
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
    }, { persistence, now });

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
    }, { persistence, now });
    const [suggestion] = await listReconciliationSuggestions({ persistence, now });

    await expect(actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: 'f'.repeat(64),
      actor: 'test-user',
    }, { persistence, now })).rejects.toMatchObject({ status: 409 });
    const accepted = await actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { persistence, now });
    const replay = await actOnReconciliationSuggestion(suggestion.id, {
      action: 'accept',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { persistence, now });

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
    }, { persistence, now });
    const [suggestion] = await listReconciliationSuggestions({ persistence, now });
    await actOnReconciliationSuggestion(suggestion.id, {
      action: 'never-auto-complete',
      payloadHash: suggestion.payloadHash,
      actor: 'test-user',
    }, { persistence, now });

    const repeated = await reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'dismiss-run-2',
      idempotencyKey: 'dismiss-run-key-2',
      signals: [plannerSignal()],
    }, { persistence, now: new Date('2026-08-05T12:01:00.000Z') });

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
    }, { persistence, now });
    await database.update(tasks).set({
      status: 'done',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    }).where(eq(tasks.id, 'task-1'));

    expect(await listReconciliationSuggestions({ persistence, now })).toHaveLength(0);
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
      persistence,
      now,
      verifiedSourceRefHashes: new Set([plannerSignal().sourceRefHash]),
    });

    // Reopen suppression is written by the task-core reopen path (already
    // backend-neutral); this reproduces exactly the rows it writes so the
    // post-reopen reconciliation decision stays under test here.
    database.transaction((tx) => {
      tx.update(tasks).set({
        status: 'todo',
        completedAt: null,
        updatedAt: '2026-08-05T12:05:00.000Z',
      }).where(eq(tasks.id, 'task-1')).run();
      tx.insert(scoutReconciliationTaskState).values({
        taskId: 'task-1',
        neverAutoComplete: true,
        reason: 'reopened_after_auto_completion',
        updatedAt: '2026-08-05T12:05:00.000Z',
        updatedBy: 'task-reopen',
      }).onConflictDoUpdate({
        target: scoutReconciliationTaskState.taskId,
        set: {
          neverAutoComplete: true,
          reason: 'reopened_after_auto_completion',
          updatedAt: '2026-08-05T12:05:00.000Z',
          updatedBy: 'task-reopen',
        },
      }).run();
      tx.update(scoutReconciliationSuggestions).set({
        status: 'dismissed',
        updatedAt: '2026-08-05T12:05:00.000Z',
        actedAt: '2026-08-05T12:05:00.000Z',
        actedBy: 'task-reopen',
      }).where(and(
        eq(scoutReconciliationSuggestions.taskId, 'task-1'),
        eq(scoutReconciliationSuggestions.status, 'pending'),
      )).run();
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
    }, { persistence, now: new Date('2026-08-05T12:06:00.000Z') });
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
    }, { persistence, now })).rejects.toBeInstanceOf(ScoutReconciliationError);
    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'duplicate-signals',
      signals: [plannerSignal(), plannerSignal()],
    }, { persistence, now })).rejects.toMatchObject({ status: 400 });
    await expect(reconcileScoutTasks({
      scope: 'task:task-1',
      sourceIdentity: 'duplicate-artifacts',
      signals: [
        plannerSignal('task-1', 'planner-1'),
        plannerSignal('task-1', 'planner-2'),
      ],
    }, { persistence, now })).rejects.toMatchObject({ status: 400 });
  });
});

// ─── Shared SQLite/PostgreSQL contract ───────────────────────────────────────

let contractDatabase: Database.Database | null = null;

afterAll(() => {
  contractDatabase?.close();
  contractDatabase = null;
});

function createSqliteScoutContractHarness(): ScoutPersistenceContractHarness {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE connector_configs (
      id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1, sync_mode TEXT NOT NULL DEFAULT 'poll',
      poll_interval_minutes INTEGER, capabilities TEXT NOT NULL DEFAULT '{}',
      credentials TEXT NOT NULL DEFAULT '{}', settings TEXT NOT NULL DEFAULT '{}',
      synced_lists TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL DEFAULT 'todo', priority TEXT NOT NULL DEFAULT 'none',
      due_date TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      completed_at TEXT, deleted_at TEXT, depth INTEGER NOT NULL DEFAULT 0,
      is_checklist_item INTEGER NOT NULL DEFAULT 0, source_list_id TEXT,
      source_list_name TEXT, micro_status TEXT, status_reason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', sync_status TEXT NOT NULL DEFAULT 'synced',
      last_synced_at TEXT NOT NULL, snoozed_until TEXT, reminder_at TEXT,
      reminder_relative TEXT, reminder_due_time TEXT
    );
    CREATE UNIQUE INDEX idx_tasks_source_connector ON tasks(source_id, connector_instance_id);
    CREATE TABLE task_field_states (
      task_id TEXT NOT NULL, field_name TEXT NOT NULL, source_value TEXT NOT NULL,
      locally_overridden INTEGER NOT NULL DEFAULT 0, source_observed_at TEXT,
      local_edited_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (task_id, field_name)
    );
    CREATE TABLE task_ingest_suppressions (
      connector_instance_id TEXT NOT NULL, source_id TEXT NOT NULL,
      reason TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (connector_instance_id, source_id)
    );
    CREATE TABLE task_linked_sources (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, source_id TEXT NOT NULL,
      title TEXT NOT NULL, linked_at TEXT NOT NULL, match_confidence REAL,
      metadata TEXT NOT NULL DEFAULT '{}'
    );
    CREATE UNIQUE INDEX idx_task_linked_sources_unique
      ON task_linked_sources(task_id, connector_type, source_id);
    CREATE UNIQUE INDEX idx_task_linked_sources_source_identity
      ON task_linked_sources(connector_instance_id, source_id);
    CREATE TABLE source_lists (
      id TEXT PRIMARY KEY, connector_instance_id TEXT NOT NULL, source_id TEXT NOT NULL,
      name TEXT NOT NULL, type TEXT NOT NULL, task_count INTEGER NOT NULL DEFAULT 0,
      last_synced_at TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0, icon TEXT, icon_color TEXT
    );
    CREATE TABLE tags (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL, type TEXT NOT NULL,
      source TEXT, color TEXT, confirmed INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, unified_into TEXT
    );
    CREATE TABLE task_tags (task_id TEXT NOT NULL, tag_id TEXT NOT NULL);
    CREATE TABLE task_projects (task_id TEXT NOT NULL, project_id TEXT NOT NULL);
    CREATE UNIQUE INDEX idx_task_projects_task_project ON task_projects(task_id, project_id);
    CREATE TABLE hub_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      color TEXT NOT NULL DEFAULT '#3b82f6', created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE triage_items (
      id TEXT PRIMARY KEY, source_platform TEXT NOT NULL, source_id TEXT NOT NULL,
      source_url TEXT NOT NULL, canonical_url TEXT, title TEXT NOT NULL,
      description TEXT, thumbnail_url TEXT, content_type TEXT NOT NULL DEFAULT 'link',
      captured_at TEXT NOT NULL, ingested_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', snoozed_until TEXT, ai_summary TEXT,
      ai_categories TEXT NOT NULL DEFAULT '[]',
      ai_suggested_actions TEXT NOT NULL DEFAULT '[]',
      ai_relevance_score INTEGER NOT NULL DEFAULT 0,
      ai_urgency TEXT NOT NULL DEFAULT 'evergreen',
      raw_metadata TEXT NOT NULL DEFAULT '{}',
      actions_taken TEXT NOT NULL DEFAULT '[]', source_order INTEGER
    );
    CREATE UNIQUE INDEX idx_triage_items_source ON triage_items(source_platform, source_id);
    CREATE TABLE notifications (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL UNIQUE, connector_type TEXT NOT NULL,
      connector_instance_id TEXT NOT NULL, title TEXT NOT NULL, body TEXT,
      level TEXT NOT NULL DEFAULT 'fyi', level_rank INTEGER NOT NULL DEFAULT 3,
      category TEXT NOT NULL DEFAULT 'system', template_key TEXT,
      state TEXT NOT NULL DEFAULT 'unread', is_actionable INTEGER NOT NULL DEFAULT 0,
      received_at TEXT NOT NULL, sort_at TEXT NOT NULL, group_key TEXT,
      dedupe_key TEXT, navigation_target TEXT,
      metadata TEXT NOT NULL DEFAULT '{}', presentation TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE scout_reconciliation_runs (
      id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, scope_type TEXT NOT NULL,
      scope_id TEXT, lookback_hours INTEGER NOT NULL,
      dry_run INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL,
      source_identity TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_hash TEXT NOT NULL, lease_token TEXT NOT NULL, status TEXT NOT NULL,
      summary TEXT, error TEXT, started_at TEXT NOT NULL, completed_at TEXT
    );
    CREATE UNIQUE INDEX idx_scout_reconciliation_run_idempotency
      ON scout_reconciliation_runs(idempotency_key);
    CREATE UNIQUE INDEX idx_scout_reconciliation_active_scope
      ON scout_reconciliation_runs(scope_key) WHERE status = 'running';
    CREATE TABLE scout_reconciliation_evaluations (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, task_id TEXT NOT NULL,
      candidate_action TEXT NOT NULL, action TEXT NOT NULL, confidence REAL NOT NULL,
      evidence_hash TEXT NOT NULL, evidence TEXT NOT NULL, policy_decision TEXT NOT NULL,
      policy_reason TEXT NOT NULL, payload_hash TEXT NOT NULL,
      applied INTEGER NOT NULL DEFAULT 0, applied_result TEXT, created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_scout_reconciliation_evaluation_run_task
      ON scout_reconciliation_evaluations(run_id, task_id);
    CREATE TABLE scout_reconciliation_suggestions (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, run_id TEXT NOT NULL,
      evaluation_id TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL,
      confidence REAL NOT NULL, evidence_hash TEXT NOT NULL, evidence TEXT NOT NULL,
      policy_decision TEXT NOT NULL, policy_reason TEXT NOT NULL,
      payload_hash TEXT NOT NULL, proposed_effect TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      acted_at TEXT, acted_by TEXT
    );
    CREATE UNIQUE INDEX idx_scout_reconciliation_pending_task
      ON scout_reconciliation_suggestions(task_id) WHERE status = 'pending';
    CREATE TABLE scout_reconciliation_task_state (
      task_id TEXT PRIMARY KEY, never_auto_complete INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL, source_run_id TEXT, updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);
  contractDatabase = sqlite;
  const contractPersistence = createSqliteScoutIngestionReconciliationRepository(sqlite);

  return {
    persistence: contractPersistence,
    async reset() {
      sqlite.exec(`
        DELETE FROM scout_reconciliation_suggestions;
        DELETE FROM scout_reconciliation_evaluations;
        DELETE FROM scout_reconciliation_task_state;
        DELETE FROM scout_reconciliation_runs;
        DELETE FROM notifications;
        DELETE FROM task_field_states;
        DELETE FROM task_linked_sources;
        DELETE FROM task_ingest_suppressions;
        DELETE FROM task_tags;
        DELETE FROM task_projects;
        DELETE FROM triage_items;
        DELETE FROM tasks;
        DELETE FROM tags;
        DELETE FROM source_lists;
        DELETE FROM hub_projects;
        DELETE FROM connector_configs;
      `);
    },
    async seedConnector(input) {
      sqlite.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, capabilities, credentials, settings,
          synced_lists, created_at, updated_at, deleted_at
        ) VALUES (?, ?, 'Scout', ?, 'push', '{}', '{}', ?, '[]', ?, ?, ?)
      `).run(
        input.id,
        input.type,
        input.enabled ? 1 : 0,
        JSON.stringify(input.settings),
        SCOUT_NOW,
        SCOUT_NOW,
        input.deletedAt ?? null,
      );
    },
    async seedTask(task) {
      sqlite.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, status,
          priority, due_date, created_at, updated_at, last_synced_at, metadata,
          source_list_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.sourceId,
        task.connectorType,
        task.connectorInstanceId,
        task.title,
        task.status,
        task.priority ?? 'none',
        task.dueDate ?? null,
        task.createdAt ?? SCOUT_NOW,
        task.createdAt ?? SCOUT_NOW,
        task.createdAt ?? SCOUT_NOW,
        JSON.stringify(task.metadata ?? {}),
        task.sourceListId ?? null,
      );
    },
    async seedProject(id) {
      sqlite.prepare(`
        INSERT INTO hub_projects (id, name, status, color, created_at, updated_at)
        VALUES (?, ?, 'active', '#3b82f6', ?, ?)
      `).run(id, id, SCOUT_NOW, SCOUT_NOW);
    },
    async seedSuppression(input) {
      sqlite.prepare(`
        INSERT INTO task_ingest_suppressions (
          connector_instance_id, source_id, reason, created_at
        ) VALUES (?, ?, 'hard-deleted', ?)
      `).run(input.connectorInstanceId, input.sourceId, SCOUT_NOW);
    },
    async seedTriageItem(item) {
      sqlite.prepare(`
        INSERT INTO triage_items (
          id, source_platform, source_id, source_url, title, content_type,
          captured_at, ingested_at, status, ai_categories, ai_suggested_actions,
          ai_relevance_score, ai_urgency, raw_metadata, actions_taken
        ) VALUES (?, ?, ?, 'https://example.com', ?, 'text_post', ?, ?, ?, '[]', '[]', 0, 'evergreen', '{}', '[]')
      `).run(
        item.id,
        item.sourcePlatform,
        item.sourceId,
        item.title,
        SCOUT_NOW,
        SCOUT_NOW,
        item.status,
      );
    },
    async seedTaskProject(input) {
      sqlite.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)')
        .run(input.taskId, input.projectId);
    },
    async readTask(id) {
      const row = sqlite.prepare(`
        SELECT id, title, description, status, status_reason, priority, due_date,
               completed_at, metadata
        FROM tasks WHERE id = ?
      `).get(id) as Record<string, unknown> | undefined;
      return row
        ? {
            id: row.id as string,
            title: row.title as string,
            description: (row.description ?? null) as string | null,
            status: row.status as string,
            statusReason: (row.status_reason ?? null) as string | null,
            priority: row.priority as string,
            dueDate: (row.due_date ?? null) as string | null,
            completedAt: (row.completed_at ?? null) as string | null,
            metadata: row.metadata,
          }
        : null;
    },
    async readFieldStates(taskId) {
      return (sqlite.prepare(`
        SELECT field_name, source_value, locally_overridden
        FROM task_field_states WHERE task_id = ? ORDER BY field_name
      `).all(taskId) as { field_name: string; source_value: string; locally_overridden: number }[])
        .map((row) => ({
          fieldName: row.field_name,
          sourceValue: row.source_value,
          locallyOverridden: row.locally_overridden === 1,
        }));
    },
    async readSourceList(sourceId) {
      const row = sqlite.prepare(
        'SELECT name, task_count FROM source_lists WHERE source_id = ?',
      ).get(sourceId) as { name: string; task_count: number } | undefined;
      return row ? { name: row.name, taskCount: row.task_count } : null;
    },
    async readTriageItem(input) {
      const row = sqlite.prepare(`
        SELECT id, status, title FROM triage_items
        WHERE source_platform = ? AND source_id = ?
      `).get(input.sourcePlatform, input.sourceId) as
        { id: string; status: string; title: string } | undefined;
      return row ?? null;
    },
    async countTaskTags(taskId) {
      return (sqlite.prepare('SELECT COUNT(*) AS count FROM task_tags WHERE task_id = ?')
        .get(taskId) as { count: number }).count;
    },
    async countLinkedSources() {
      return (sqlite.prepare('SELECT COUNT(*) AS count FROM task_linked_sources')
        .get() as { count: number }).count;
    },
    async countEvaluations() {
      return (sqlite.prepare('SELECT COUNT(*) AS count FROM scout_reconciliation_evaluations')
        .get() as { count: number }).count;
    },
    async countNotifications() {
      return (sqlite.prepare('SELECT COUNT(*) AS count FROM notifications')
        .get() as { count: number }).count;
    },
    async listSuggestions() {
      return (sqlite.prepare(`
        SELECT id, task_id, status, evidence_hash
        FROM scout_reconciliation_suggestions ORDER BY id
      `).all() as { id: string; task_id: string; status: string; evidence_hash: string }[])
        .map((row) => ({
          id: row.id,
          taskId: row.task_id,
          status: row.status,
          evidenceHash: row.evidence_hash,
        }));
    },
    async readRunStatus(runId) {
      const row = sqlite.prepare('SELECT status FROM scout_reconciliation_runs WHERE id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status ?? null;
    },
  };
}

let scoutContractHarness: ScoutPersistenceContractHarness | null = null;

describeScoutIngestionReconciliationContract('SQLite', () => {
  scoutContractHarness ??= createSqliteScoutContractHarness();
  return scoutContractHarness;
});
