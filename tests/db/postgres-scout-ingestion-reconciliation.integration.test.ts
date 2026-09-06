import { afterAll, beforeAll, describe, vi } from 'vitest';
import type { Pool } from 'pg';
import type {
  ScoutIngestionReconciliationPersistence,
} from '@/db/persistence/scout-ingestion-reconciliation';
import {
  describeScoutIngestionReconciliationContract,
  SCOUT_NOW,
  describeTriageActionPersistenceContract,
  TRIAGE_ACTION_NOW,
  type ScoutPersistenceContractHarness,
  type TriageActionContractHarness,
} from '../contracts/scout-ingestion-reconciliation-persistence.contract';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';

vi.unmock('drizzle-orm');

const connectionString = process.env.MC_TEST_POSTGRES_URL;

describe.skipIf(!connectionString)('PostgreSQL Scout ingestion/reconciliation adapter', () => {
  let pool: Pool;
  let harness: ScoutPersistenceContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { createPostgresScoutIngestionReconciliationRepository }] =
      await Promise.all([
        import('pg'),
        import('@/db/postgres/repositories/scout-ingestion-reconciliation-repository'),
      ]);
    pool = new Pool({ connectionString, max: 8 });
    const persistence: ScoutIngestionReconciliationPersistence =
      createPostgresScoutIngestionReconciliationRepository(pool);

    harness = {
      persistence,
      async reset() {
        await pool.query(`
          DELETE FROM scout_reconciliation_suggestions
          WHERE run_id IN ('run-1', 'run-2', 'run-3');
          DELETE FROM scout_reconciliation_evaluations
          WHERE run_id IN ('run-1', 'run-2', 'run-3');
          DELETE FROM scout_reconciliation_task_state
          WHERE task_id IN (
            'task-1', 'task-2', 'task-done', 'task-terminal',
            'scout-open', 'scout-old', 'scout-new'
          );
          DELETE FROM scout_reconciliation_runs
          WHERE id IN ('run-1', 'run-2', 'run-3');
          DELETE FROM notifications
          WHERE id = 'notification-1'
             OR source_id = 'scout-reconciliation:run-1';
          DELETE FROM task_field_states
          WHERE task_id IN (
            'task-1', 'task-2', 'task-done', 'task-terminal',
            'other-task', 'scout-task-1', 'scout-task-loser',
            'scout-task-tombstoned', 'scout-open', 'scout-old', 'scout-new'
          );
          DELETE FROM task_linked_sources
          WHERE id IN ('link-1', 'link-2')
             OR source_id LIKE 'scout:%';
          DELETE FROM task_ingest_suppressions
          WHERE connector_instance_id = 'scout-primary';
          DELETE FROM task_tags
          WHERE task_id IN ('scout-task-1', 'scout-task-loser');
          DELETE FROM task_projects
          WHERE task_id IN (
            'task-1', 'task-2', 'task-done', 'task-terminal',
            'scout-task-1', 'scout-task-loser'
          );
          DELETE FROM triage_items
          WHERE id IN ('triage-1', 'triage-open', 'triage-closed');
          DELETE FROM tasks
          WHERE id IN (
            'task-1', 'task-2', 'task-done', 'task-terminal', 'other-task',
            'scout-task-1', 'scout-task-loser', 'scout-task-tombstoned',
            'scout-open', 'scout-old', 'scout-new'
          );
          DELETE FROM tags WHERE id = 'tag-work';
          DELETE FROM source_lists WHERE id = 'sl-scout-email';
          DELETE FROM hub_projects WHERE id = 'project-1';
          DELETE FROM connector_configs WHERE id = 'scout-primary';
        `);
      },
      async seedConnector(input) {
        await pool.query(`
          INSERT INTO connector_configs (
            id, type, name, enabled, sync_mode, capabilities, credentials, settings,
            synced_lists, created_at, updated_at, deleted_at
          ) VALUES (
            $1, $2, 'Scout', $3, 'push', '{}'::jsonb, '{}'::jsonb, $4::jsonb,
            '[]'::jsonb, $5, $5, $6
          )
        `, [
          input.id,
          input.type,
          input.enabled,
          JSON.stringify(input.settings),
          SCOUT_NOW,
          input.deletedAt ?? null,
        ]);
      },
      async seedTask(task) {
        await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            priority, due_date, created_at, updated_at, last_synced_at, metadata,
            source_list_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $9, $10::jsonb, $11)
        `, [
          task.id,
          task.sourceId,
          task.connectorType,
          task.connectorInstanceId,
          task.title,
          task.status,
          task.priority ?? 'none',
          task.dueDate ?? null,
          task.createdAt ?? SCOUT_NOW,
          JSON.stringify(task.metadata ?? {}),
          task.sourceListId ?? null,
        ]);
      },
      async seedProject(id) {
        await pool.query(`
          INSERT INTO hub_projects (id, name, status, color, created_at, updated_at)
          VALUES ($1, $1, 'active', '#3b82f6', $2, $2)
        `, [id, SCOUT_NOW]);
      },
      async seedSuppression(input) {
        await pool.query(`
          INSERT INTO task_ingest_suppressions (
            connector_instance_id, source_id, reason, created_at
          ) VALUES ($1, $2, 'hard-deleted', $3)
        `, [input.connectorInstanceId, input.sourceId, SCOUT_NOW]);
      },
      async seedTriageItem(item) {
        await pool.query(`
          INSERT INTO triage_items (
            id, source_platform, source_id, source_url, title, content_type,
            captured_at, ingested_at, status, ai_categories, ai_suggested_actions,
            ai_relevance_score, ai_urgency, raw_metadata, actions_taken
          ) VALUES (
            $1, $2, $3, 'https://example.com', $4, 'text_post', $5, $5, $6,
            '[]'::jsonb, '[]'::jsonb, 0, 'evergreen', '{}'::jsonb, '[]'::jsonb
          )
        `, [item.id, item.sourcePlatform, item.sourceId, item.title, SCOUT_NOW, item.status]);
      },
      async seedTaskProject(input) {
        await pool.query(
          'INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)',
          [input.taskId, input.projectId],
        );
      },
      async readTask(id) {
        const { rows } = await pool.query(`
          SELECT id, title, description, status, status_reason AS "statusReason",
                 priority, due_date AS "dueDate", completed_at AS "completedAt", metadata
          FROM tasks WHERE id = $1
        `, [id]);
        return rows[0] ?? null;
      },
      async readFieldStates(taskId) {
        const { rows } = await pool.query(`
          SELECT field_name AS "fieldName", source_value AS "sourceValue",
                 locally_overridden AS "locallyOverridden"
          FROM task_field_states WHERE task_id = $1 ORDER BY field_name COLLATE "C"
        `, [taskId]);
        return rows;
      },
      async readSourceList(sourceId) {
        const { rows } = await pool.query(
          'SELECT name, task_count AS "taskCount" FROM source_lists WHERE source_id = $1',
          [sourceId],
        );
        return rows[0] ? { name: rows[0].name, taskCount: Number(rows[0].taskCount) } : null;
      },
      async readTriageItem(input) {
        const { rows } = await pool.query(`
          SELECT id, status, title FROM triage_items
          WHERE source_platform = $1 AND source_id = $2
        `, [input.sourcePlatform, input.sourceId]);
        return rows[0] ?? null;
      },
      async countTaskTags(taskId) {
        const { rows } = await pool.query(
          'SELECT COUNT(*) AS count FROM task_tags WHERE task_id = $1',
          [taskId],
        );
        return Number(rows[0].count);
      },
      async countLinkedSources() {
        const { rows } = await pool.query(`
          SELECT COUNT(*) AS count FROM task_linked_sources
          WHERE id IN ('link-1', 'link-2') OR source_id LIKE 'scout:%'
        `);
        return Number(rows[0].count);
      },
      async countEvaluations() {
        const { rows } = await pool.query(
          `SELECT COUNT(*) AS count FROM scout_reconciliation_evaluations
           WHERE run_id IN ('run-1', 'run-2', 'run-3')`,
        );
        return Number(rows[0].count);
      },
      async countNotifications() {
        const { rows } = await pool.query(`
          SELECT COUNT(*) AS count FROM notifications
          WHERE id = 'notification-1' OR source_id = 'scout-reconciliation:run-1'
        `);
        return Number(rows[0].count);
      },
      async listSuggestions() {
        const { rows } = await pool.query(`
          SELECT id, task_id AS "taskId", status, evidence_hash AS "evidenceHash"
          FROM scout_reconciliation_suggestions
          WHERE run_id IN ('run-1', 'run-2', 'run-3')
          ORDER BY id COLLATE "C"
        `);
        return rows;
      },
      async readRunStatus(runId) {
        const { rows } = await pool.query(
          'SELECT status FROM scout_reconciliation_runs WHERE id = $1',
          [runId],
        );
        return rows[0]?.status ?? null;
      },
    };
  });

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeScoutIngestionReconciliationContract('PostgreSQL', () => harness);
});

describe.skipIf(!connectionString)('PostgreSQL triage action adapter', () => {
  let pool: Pool;
  let harness: TriageActionContractHarness;

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    const [{ Pool }, { drizzle }, { createPostgresTriagePersistenceRepositories }, schema] =
      await Promise.all([
        import('pg'),
        import('drizzle-orm/node-postgres'),
        import('@/db/postgres/repositories/triage-repositories'),
        import('@/db/postgres/schema'),
      ]);
    pool = new Pool({ connectionString, max: 8 });
    const repositories = createPostgresTriagePersistenceRepositories(
      drizzle(pool, { schema }),
    );

    harness = {
      actions: repositories.actions,
      documentTaskActions: repositories.documentTaskActions,
      async reset() {
        await pool.query(`
          DELETE FROM triage_action_claims WHERE triage_item_id = 'triage-1';
          DELETE FROM triage_items WHERE id = 'triage-1';
          DELETE FROM tasks WHERE id = 'owl-task-1';
        `);
      },
      async seedItem(item) {
        await pool.query(`
          INSERT INTO triage_items (
            id, source_platform, source_id, source_url, canonical_url, title,
            description, thumbnail_url, content_type, captured_at, ingested_at,
            status, snoozed_until, ai_summary, ai_categories, ai_suggested_actions,
            ai_relevance_score, ai_urgency, raw_metadata, actions_taken, source_order
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            $15::jsonb, $16::jsonb, $17, $18, $19::jsonb, $20::jsonb, $21
          )
        `, [
          item.id,
          item.sourcePlatform,
          item.sourceId,
          item.sourceUrl,
          item.canonicalUrl ?? null,
          item.title,
          item.description ?? null,
          item.thumbnailUrl ?? null,
          item.contentType,
          item.capturedAt,
          item.ingestedAt,
          item.status,
          item.snoozedUntil ?? null,
          item.aiSummary ?? null,
          JSON.stringify(item.aiCategories),
          JSON.stringify(item.aiSuggestedActions),
          item.aiRelevanceScore,
          item.aiUrgency,
          JSON.stringify(item.rawMetadata),
          JSON.stringify(item.actionsTaken),
          item.sourceOrder ?? null,
        ]);
      },
      async seedTask(task) {
        await pool.query(`
          INSERT INTO tasks (
            id, source_id, connector_type, connector_instance_id, title, status,
            created_at, updated_at, last_synced_at, metadata
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, $8::jsonb)
        `, [
          task.id,
          task.sourceId,
          task.connectorType,
          task.connectorInstanceId,
          task.title,
          task.status,
          TRIAGE_ACTION_NOW,
          JSON.stringify(task.metadata),
        ]);
      },
      async readItem(id) {
        return repositories.actions.getActionSnapshot(id);
      },
      async countClaims() {
        const { rows } = await pool.query(`
          SELECT COUNT(*) AS count FROM triage_action_claims
          WHERE triage_item_id = 'triage-1'
        `);
        return Number(rows[0].count);
      },
    };
  });

  afterAll(async () => {
    await harness?.reset();
    await pool?.end();
  });

  describeTriageActionPersistenceContract('PostgreSQL', () => harness);
});
