import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type { TaskFieldStateRecord } from '@/lib/tasks/field-state';
import {
  ScoutPersistenceConflictError,
  type ScoutComparisonRepository,
  type ScoutComparisonTask,
  type ScoutComparisonWindow,
  type ScoutConnectorBootstrapInput,
  type ScoutConnectorBootstrapResult,
  type ScoutConnectorConfigurationRecord,
  type ScoutCrossConnectorCandidate,
  type ScoutEvaluationContext,
  type ScoutExistingTask,
  type ScoutIngestGuard,
  type ScoutIngestionReconciliationPersistence,
  type ScoutIngestionRepository,
  type ScoutLinkSourceInput,
  type ScoutLinkSourceOutcome,
  type ScoutReconciliationCommitInput,
  type ScoutReconciliationCommitResult,
  type ScoutReconciliationEvaluationView,
  type ScoutReconciliationRepository,
  type ScoutReconciliationRunInsert,
  type ScoutReconciliationRunRecord,
  type ScoutReconciliationScopeQuery,
  type ScoutReconciliationSuggestionRow,
  type ScoutReconciliationTask,
  type ScoutReconciliationTaskStateRecord,
  type ScoutSourceListCountRefresh,
  type ScoutSourceListDefinition,
  type ScoutSuggestionActionDecision,
  type ScoutSuggestionActionSnapshot,
  type ScoutSuggestionRecord,
  type ScoutTaskCreationInput,
  type ScoutTaskCreationOutcome,
  type ScoutTaskMergeDecision,
  type ScoutTaskMergeInput,
  type ScoutTriageItemState,
  type ScoutTriageUpsertInput,
  type ScoutTriageUpsertOutcome,
} from '@/db/persistence/scout-ingestion-reconciliation';

type Queryable = Pool | PoolClient;

const UNIQUE_VIOLATION = '23505';

async function query<T extends QueryResultRow>(
  client: Queryable,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

async function run(
  client: Queryable,
  text: string,
  values: readonly unknown[] = [],
): Promise<number> {
  return (await client.query(text, [...values])).rowCount ?? 0;
}

async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error
    && typeof error === 'object'
    && (error as { code?: unknown }).code === UNIQUE_VIOLATION,
  );
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  dueDate: string | null;
  metadata: unknown;
  status: string;
  snoozedUntil: string | null;
}

const EXISTING_TASK_COLUMNS = `
  id, title, description, priority, due_date AS "dueDate", metadata, status,
  snoozed_until AS "snoozedUntil"
`;

function mapExistingTask(row: TaskRow): ScoutExistingTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    dueDate: row.dueDate,
    metadata: row.metadata,
    status: row.status,
    snoozedUntil: row.snoozedUntil,
  };
}

const RECONCILIATION_TASK_COLUMNS = `
  id, title, connector_type AS "connectorType",
  connector_instance_id AS "connectorInstanceId", source_id AS "sourceId",
  status, priority, due_date AS "dueDate", completed_at AS "completedAt",
  status_reason AS "statusReason"
`;

const RECONCILIATION_TASK_COLUMNS_T = `
  t.id, t.title, t.connector_type AS "connectorType",
  t.connector_instance_id AS "connectorInstanceId", t.source_id AS "sourceId",
  t.status, t.priority, t.due_date AS "dueDate", t.completed_at AS "completedAt",
  t.status_reason AS "statusReason"
`;

const TASK_STATE_COLUMNS = `
  task_id AS "taskId", never_auto_complete AS "neverAutoComplete", reason,
  source_run_id AS "sourceRunId", updated_at AS "updatedAt",
  updated_by AS "updatedBy"
`;

/**
 * PostgreSQL stores triage/reconciliation JSON in `jsonb`, so `pg` already
 * returns parsed values. SQLite stores them as text; both adapters therefore
 * hand the service the parsed value.
 */
function asJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

class PostgresScoutIngestionRepository implements ScoutIngestionRepository {
  constructor(private readonly pool: Pool) {}

  private async insertSourceList(
    client: Queryable,
    definition: ScoutSourceListDefinition,
    connectorInstanceId: string,
    now: string,
  ): Promise<number> {
    return run(client, `
      INSERT INTO source_lists (
        id, connector_instance_id, source_id, name, type, task_count,
        last_synced_at, sort_order, hidden, icon, icon_color
      ) VALUES ($1, $2, $3, $4, $5, 0, $6, 0, FALSE, $7, $8)
      ON CONFLICT DO NOTHING
    `, [
      definition.id,
      connectorInstanceId,
      definition.sourceId,
      definition.name,
      definition.type,
      now,
      definition.icon,
      definition.iconColor,
    ]);
  }

  async bootstrapConnector(
    input: ScoutConnectorBootstrapInput,
  ): Promise<ScoutConnectorBootstrapResult> {
    return withTransaction(this.pool, async (client) => {
      const [existing] = await query<{ enabled: boolean; settings: unknown }>(client, `
        SELECT enabled, settings FROM connector_configs WHERE id = $1
      `, [input.connectorInstanceId]);
      if (existing) {
        return { existed: true, enabled: existing.enabled, settings: existing.settings };
      }

      await run(client, `
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, poll_interval_minutes,
          capabilities, credentials, settings, synced_lists, created_at, updated_at
        ) VALUES (
          $1, $2, $3, TRUE, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9::jsonb, $10, $10
        )
        ON CONFLICT DO NOTHING
      `, [
        input.connectorInstanceId,
        input.defaults.type,
        input.defaults.name,
        input.defaults.syncMode,
        input.defaults.pollIntervalMinutes,
        input.defaults.capabilities,
        input.defaults.credentials,
        input.defaults.settings,
        input.defaults.syncedLists,
        input.now,
      ]);

      for (const definition of input.sourceLists) {
        await this.insertSourceList(client, definition, input.connectorInstanceId, input.now);
      }
      return { existed: false, enabled: true, settings: null };
    });
  }

  async ensureSourceList(input: {
    readonly connectorInstanceId: string;
    readonly definition: ScoutSourceListDefinition;
    readonly now: string;
  }): Promise<{ readonly created: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const [existing] = await query<{ id: string }>(client, `
        SELECT id FROM source_lists WHERE source_id = $1
      `, [input.definition.sourceId]);
      if (existing) return { created: false };
      const changes = await this.insertSourceList(
        client,
        input.definition,
        input.connectorInstanceId,
        input.now,
      );
      return { created: changes > 0 };
    });
  }

  async listCrossConnectorCandidates(input: {
    readonly excludeConnectorType: string;
    readonly closedStatuses: readonly string[];
  }): Promise<ScoutCrossConnectorCandidate[]> {
    return query<ScoutCrossConnectorCandidate>(this.pool, `
      SELECT
        id, title, connector_type AS "connectorType",
        connector_instance_id AS "connectorInstanceId", source_id AS "sourceId",
        metadata
      FROM tasks
      WHERE connector_type <> $1
        AND status <> ALL($2::text[])
      ORDER BY id COLLATE "C"
    `, [input.excludeConnectorType, [...input.closedStatuses]]);
  }

  async findExistingTask(input: {
    readonly connectorType: string;
    readonly sourceId: string;
  }): Promise<ScoutExistingTask | null> {
    const [row] = await query<TaskRow>(this.pool, `
      SELECT ${EXISTING_TASK_COLUMNS}
      FROM tasks WHERE connector_type = $1 AND source_id = $2
      ORDER BY id COLLATE "C"
      LIMIT 1
    `, [input.connectorType, input.sourceId]);
    return row ? mapExistingTask(row) : null;
  }

  async findTriageItem(input: {
    readonly sourcePlatform: string;
    readonly sourceId: string;
  }): Promise<ScoutTriageItemState | null> {
    const [row] = await query<{ id: string; status: string }>(this.pool, `
      SELECT id, status FROM triage_items
      WHERE source_platform = $1 AND source_id = $2
    `, [input.sourcePlatform, input.sourceId]);
    return row ?? null;
  }

  async filterExistingProjectIds(projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = await query<{ id: string }>(this.pool, `
      SELECT id FROM hub_projects WHERE id = ANY($1::text[])
    `, [[...projectIds]]);
    const present = new Set(rows.map((row) => row.id));
    return projectIds.filter((id) => present.has(id));
  }

  async readIngestGuard(input: {
    readonly connectorInstanceId: string;
    readonly sourceId: string;
  }): Promise<ScoutIngestGuard> {
    const [tombstone] = await query<{ sourceId: string }>(this.pool, `
      SELECT source_id AS "sourceId" FROM task_ingest_suppressions
      WHERE connector_instance_id = $1 AND source_id = $2
    `, [input.connectorInstanceId, input.sourceId]);
    if (tombstone) return { suppressed: true, linkedTaskId: null };

    const [linked] = await query<{ taskId: string }>(this.pool, `
      SELECT task_id AS "taskId" FROM task_linked_sources
      WHERE connector_instance_id = $1 AND source_id = $2
    `, [input.connectorInstanceId, input.sourceId]);
    return { suppressed: false, linkedTaskId: linked?.taskId ?? null };
  }

  async mergeExistingTask(input: ScoutTaskMergeInput): Promise<ScoutTaskMergeDecision> {
    return withTransaction(this.pool, async (client) => {
      const [current] = await query<TaskRow>(client, `
        SELECT ${EXISTING_TASK_COLUMNS} FROM tasks WHERE id = $1
      `, [input.taskId]);

      const fieldStates: TaskFieldStateRecord[] = current
        ? (await query<TaskFieldStateRecord>(client, `
            SELECT
              task_id AS "taskId", field_name AS "fieldName",
              source_value AS "sourceValue",
              locally_overridden AS "locallyOverridden",
              source_observed_at AS "sourceObservedAt",
              local_edited_at AS "localEditedAt", updated_at AS "updatedAt"
            FROM task_field_states WHERE task_id = $1
            ORDER BY field_name COLLATE "C"
          `, [input.taskId]))
        : [];

      const decision = input.decide({
        task: current ? mapExistingTask(current) : null,
        fieldStates,
      });
      if (decision.kind === 'skip') return decision;

      if (decision.taskWrite) {
        const rendered = decision.taskWrite.rendered;
        const assignments: string[] = [];
        const params: unknown[] = [];
        for (const [column, value] of [
          ['title', rendered.title],
          ['description', rendered.description],
          ['priority', rendered.priority],
          ['due_date', rendered.dueDate],
        ] as const) {
          if (value === undefined) continue;
          params.push(value);
          assignments.push(`${column} = $${params.length}`);
        }
        params.push(decision.taskWrite.metadata);
        assignments.push(`metadata = $${params.length}::jsonb`);
        params.push(decision.taskWrite.updatedAt);
        assignments.push(`updated_at = $${params.length}`);
        params.push(decision.taskWrite.lastSyncedAt);
        assignments.push(`last_synced_at = $${params.length}`);
        params.push(input.taskId);
        await run(client, `
          UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${params.length}
        `, params);
      }

      for (const observation of decision.observations) {
        await run(client, `
          INSERT INTO task_field_states (
            task_id, field_name, source_value, locally_overridden,
            source_observed_at, local_edited_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (task_id, field_name) DO UPDATE SET
            source_value = EXCLUDED.source_value,
            locally_overridden = EXCLUDED.locally_overridden,
            source_observed_at = EXCLUDED.source_observed_at,
            local_edited_at = EXCLUDED.local_edited_at,
            updated_at = EXCLUDED.updated_at
        `, [
          input.taskId,
          observation.fieldName,
          observation.sourceValue,
          observation.locallyOverridden,
          observation.sourceObservedAt,
          observation.localEditedAt,
          observation.updatedAt,
        ]);
      }
      return decision;
    });
  }

  async createTask(input: ScoutTaskCreationInput): Promise<ScoutTaskCreationOutcome> {
    return withTransaction(this.pool, async (client) => {
      const [tombstone] = await query<{ sourceId: string }>(client, `
        SELECT source_id AS "sourceId" FROM task_ingest_suppressions
        WHERE connector_instance_id = $1 AND source_id = $2
      `, [input.connectorInstanceId, input.sourceId]);
      if (tombstone) return { kind: 'suppressed' } as const;

      const inserted = await run(client, `
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, description,
          status, priority, due_date, created_at, updated_at, depth,
          is_checklist_item, source_list_id, source_list_name, sync_status,
          last_synced_at, metadata
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, 0, FALSE, $11, $12,
          'synced', $10, $13::jsonb
        )
        ON CONFLICT (source_id, connector_instance_id) DO NOTHING
      `, [
        input.taskId,
        input.sourceId,
        input.connectorType,
        input.connectorInstanceId,
        input.title,
        input.description,
        input.status,
        input.priority,
        input.dueDate,
        input.now,
        input.sourceListId,
        input.sourceListName,
        input.metadata,
      ]);

      if (inserted === 0) {
        const [winner] = await query<{ id: string }>(client, `
          SELECT id FROM tasks WHERE connector_instance_id = $1 AND source_id = $2
        `, [input.connectorInstanceId, input.sourceId]);
        if (!winner) {
          throw new Error(`Scout ingest conflict for ${input.sourceId} had no winning task`);
        }
        return { kind: 'conflict', taskId: winner.id } as const;
      }

      for (const state of input.fieldStates) {
        await run(client, `
          INSERT INTO task_field_states (
            task_id, field_name, source_value, locally_overridden,
            source_observed_at, local_edited_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          input.taskId,
          state.fieldName,
          state.sourceValue,
          state.locallyOverridden,
          state.sourceObservedAt,
          state.localEditedAt,
          state.updatedAt,
        ]);
      }

      for (const tag of input.tags) {
        await run(client, `
          INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
        `, [
          tag.id,
          tag.name,
          tag.slug,
          tag.type,
          tag.source,
          tag.color,
          tag.confirmed,
          tag.createdAt,
        ]);
        await run(client, `
          INSERT INTO task_tags (task_id, tag_id) VALUES ($1, $2)
        `, [input.taskId, tag.id]);
      }

      if (input.projectId) {
        await run(client, `
          INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
        `, [input.taskId, input.projectId]);
      }
      return { kind: 'created' } as const;
    });
  }

  async linkSourceToTask(input: ScoutLinkSourceInput): Promise<ScoutLinkSourceOutcome> {
    return withTransaction(this.pool, async (client) => {
      const [tombstone] = await query<{ sourceId: string }>(client, `
        SELECT source_id AS "sourceId" FROM task_ingest_suppressions
        WHERE connector_instance_id = $1 AND source_id = $2
      `, [input.connectorInstanceId, input.sourceId]);
      if (tombstone) return { kind: 'suppressed' } as const;

      await run(client, `
        INSERT INTO task_linked_sources (
          id, task_id, connector_type, connector_instance_id, source_id,
          title, linked_at, match_confidence, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT DO NOTHING
      `, [
        input.id,
        input.taskId,
        input.connectorType,
        input.connectorInstanceId,
        input.sourceId,
        input.title,
        input.linkedAt,
        input.matchConfidence,
        input.metadata,
      ]);
      return { kind: 'linked' } as const;
    });
  }

  async upsertTriageItem(input: ScoutTriageUpsertInput): Promise<ScoutTriageUpsertOutcome> {
    const values = input.values;
    return withTransaction(this.pool, async (client) => {
      const [existing] = await query<{ id: string; status: string }>(client, `
        SELECT id, status FROM triage_items
        WHERE source_platform = $1 AND source_id = $2
      `, [input.sourcePlatform, input.sourceId]);

      if (existing && (existing.status === 'actioned' || existing.status === 'dismissed')) {
        return { kind: 'closed', triageItemId: existing.id } as const;
      }

      const refreshParams = [
        values.sourceUrl,
        values.canonicalUrl,
        values.title,
        values.description,
        values.contentType,
        values.capturedAt,
        values.aiSummary,
        JSON.stringify(values.aiCategories),
        JSON.stringify(values.aiSuggestedActions),
        values.aiRelevanceScore,
        values.aiUrgency,
        JSON.stringify(values.rawMetadata),
      ];

      if (existing) {
        await run(client, `
          UPDATE triage_items SET
            source_url = $1, canonical_url = $2, title = $3, description = $4,
            content_type = $5, captured_at = $6, ai_summary = $7,
            ai_categories = $8::jsonb, ai_suggested_actions = $9::jsonb,
            ai_relevance_score = $10, ai_urgency = $11, raw_metadata = $12::jsonb
          WHERE id = $13
        `, [...refreshParams, existing.id]);
        return { kind: 'updated', triageItemId: existing.id } as const;
      }

      await run(client, `
        INSERT INTO triage_items (
          id, source_platform, source_id, source_url, canonical_url, title,
          description, content_type, captured_at, ingested_at, status,
          ai_summary, ai_categories, ai_suggested_actions, ai_relevance_score,
          ai_urgency, raw_metadata, actions_taken
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12::jsonb,
          $13::jsonb, $14, $15, $16::jsonb, '[]'::jsonb
        )
        ON CONFLICT (source_platform, source_id) DO UPDATE SET
          source_url = EXCLUDED.source_url,
          canonical_url = EXCLUDED.canonical_url,
          title = EXCLUDED.title,
          description = EXCLUDED.description,
          content_type = EXCLUDED.content_type,
          captured_at = EXCLUDED.captured_at,
          ai_summary = EXCLUDED.ai_summary,
          ai_categories = EXCLUDED.ai_categories,
          ai_suggested_actions = EXCLUDED.ai_suggested_actions,
          ai_relevance_score = EXCLUDED.ai_relevance_score,
          ai_urgency = EXCLUDED.ai_urgency,
          raw_metadata = EXCLUDED.raw_metadata
        WHERE triage_items.status NOT IN ('actioned', 'dismissed')
      `, [
        input.triageItemId,
        input.sourcePlatform,
        input.sourceId,
        values.sourceUrl,
        values.canonicalUrl,
        values.title,
        values.description,
        values.contentType,
        values.capturedAt,
        input.ingestedAt,
        values.aiSummary,
        JSON.stringify(values.aiCategories),
        JSON.stringify(values.aiSuggestedActions),
        values.aiRelevanceScore,
        values.aiUrgency,
        JSON.stringify(values.rawMetadata),
      ]);

      const [stored] = await query<{ id: string; status: string }>(client, `
        SELECT id, status FROM triage_items
        WHERE source_platform = $1 AND source_id = $2
      `, [input.sourcePlatform, input.sourceId]);
      if (stored && (stored.status === 'actioned' || stored.status === 'dismissed')) {
        return { kind: 'closed', triageItemId: stored.id } as const;
      }
      return {
        kind: 'created',
        triageItemId: stored?.id ?? input.triageItemId,
      } as const;
    });
  }

  async refreshSourceListCounts(
    refreshes: readonly ScoutSourceListCountRefresh[],
  ): Promise<void> {
    if (refreshes.length === 0) return;
    await withTransaction(this.pool, async (client) => {
      for (const refresh of refreshes) {
        await run(client, `
          UPDATE source_lists SET
            task_count = (
              SELECT COUNT(*) FROM tasks
              WHERE tasks.connector_type = $1 AND tasks.source_list_id = $2
            ),
            last_synced_at = $3
          WHERE source_id = $2
        `, [refresh.connectorType, refresh.sourceListId, refresh.syncedAt]);
      }
    });
  }
}

class PostgresScoutComparisonRepository implements ScoutComparisonRepository {
  constructor(private readonly pool: Pool) {}

  private listTasks(connectorType: string, since: string): Promise<ScoutComparisonTask[]> {
    return query<ScoutComparisonTask>(this.pool, `
      SELECT
        id, title, source_id AS "sourceId", created_at AS "createdAt",
        priority, status, metadata
      FROM tasks
      WHERE connector_type = $1 AND created_at >= $2
      ORDER BY created_at COLLATE "C", id COLLATE "C"
    `, [connectorType, since]);
  }

  async readWindow(input: {
    readonly since: string;
    readonly scoutConnectorType: string;
    readonly comparisonConnectorType: string;
  }): Promise<ScoutComparisonWindow> {
    const [scoutTasks, comparisonTasks, linkedPairs] = await Promise.all([
      this.listTasks(input.scoutConnectorType, input.since),
      this.listTasks(input.comparisonConnectorType, input.since),
      query<{ taskId: string; sourceId: string; connectorType: string }>(this.pool, `
        SELECT
          task_id AS "taskId", source_id AS "sourceId",
          connector_type AS "connectorType"
        FROM task_linked_sources
        ORDER BY id COLLATE "C"
      `),
    ]);
    return { scoutTasks, comparisonTasks, linkedPairs };
  }
}

class PostgresScoutReconciliationRepository implements ScoutReconciliationRepository {
  constructor(private readonly pool: Pool) {}

  private async readConnector(
    client: Queryable,
    connectorType: string,
    connectorInstanceId?: string,
  ): Promise<ScoutConnectorConfigurationRecord | null> {
    const [row] = await query<{ enabled: boolean; settings: unknown }>(client, `
      SELECT enabled, settings FROM connector_configs
      WHERE type = $1 AND deleted_at IS NULL
        ${connectorInstanceId ? 'AND id = $2' : ''}
      ORDER BY id COLLATE "C"
      LIMIT 1
    `, connectorInstanceId ? [connectorType, connectorInstanceId] : [connectorType]);
    return row ? { enabled: row.enabled, settings: row.settings } : null;
  }

  async getConnectorConfiguration(input: {
    readonly connectorType: string;
    readonly connectorInstanceId?: string;
  }): Promise<ScoutConnectorConfigurationRecord | null> {
    return this.readConnector(this.pool, input.connectorType, input.connectorInstanceId);
  }

  async expireStaleRuns(input: {
    readonly scopeKey: string;
    readonly startedBefore: string;
    readonly completedAt: string;
    readonly error: string;
  }): Promise<void> {
    await run(this.pool, `
      UPDATE scout_reconciliation_runs
      SET status = 'failed', error = $1, completed_at = $2
      WHERE scope_key = $3 AND status = 'running' AND started_at <= $4
    `, [input.error, input.completedAt, input.scopeKey, input.startedBefore]);
  }

  async findRunByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ScoutReconciliationRunRecord | null> {
    const [row] = await query<{
      id: string;
      scopeKey: string;
      requestHash: string;
      status: 'running' | 'completed' | 'failed';
      dryRun: boolean;
      startedAt: string;
      summary: unknown;
    }>(this.pool, `
      SELECT
        id, scope_key AS "scopeKey", request_hash AS "requestHash", status,
        dry_run AS "dryRun", started_at AS "startedAt", summary
      FROM scout_reconciliation_runs WHERE idempotency_key = $1
      LIMIT 1
    `, [idempotencyKey]);
    if (!row) return null;
    return {
      id: row.id,
      scopeKey: row.scopeKey,
      requestHash: row.requestHash,
      status: row.status,
      dryRun: row.dryRun,
      startedAt: row.startedAt,
      summary: asJsonObject(row.summary) as Record<string, number> | null,
    };
  }

  async loadRunEvaluations(runId: string): Promise<ScoutReconciliationEvaluationView[]> {
    const rows = await query<{
      taskId: string;
      title: string;
      candidateAction: string;
      action: string;
      confidence: number;
      evidence: unknown;
      policyDecision: string;
      policyReason: string;
      applied: boolean;
      appliedResult: unknown;
    }>(this.pool, `
      SELECT
        e.task_id AS "taskId", t.title, e.candidate_action AS "candidateAction",
        e.action, e.confidence, e.evidence,
        e.policy_decision AS "policyDecision", e.policy_reason AS "policyReason",
        e.applied, e.applied_result AS "appliedResult"
      FROM scout_reconciliation_evaluations e
      INNER JOIN tasks t ON t.id = e.task_id
      WHERE e.run_id = $1
      ORDER BY e.created_at COLLATE "C", e.id COLLATE "C"
    `, [runId]);
    return rows.map((row) => ({
      taskId: row.taskId,
      title: row.title,
      candidateAction: row.candidateAction,
      action: row.action,
      confidence: row.confidence,
      evidence: row.evidence,
      policyDecision: row.policyDecision,
      policyReason: row.policyReason,
      applied: row.applied,
      appliedResult: asJsonObject(row.appliedResult),
    }));
  }

  async findRecentCompletedRun(input: {
    readonly scopeKey: string;
    readonly startedAtOrAfter: string;
  }): Promise<{ readonly startedAt: string } | null> {
    const [row] = await query<{ startedAt: string }>(this.pool, `
      SELECT started_at AS "startedAt" FROM scout_reconciliation_runs
      WHERE scope_key = $1 AND dry_run = FALSE AND status = 'completed'
        AND started_at >= $2
      ORDER BY started_at DESC
      LIMIT 1
    `, [input.scopeKey, input.startedAtOrAfter]);
    return row ?? null;
  }

  async createRun(
    record: ScoutReconciliationRunInsert,
  ): Promise<{ readonly kind: 'created' } | { readonly kind: 'conflict' }> {
    try {
      await run(this.pool, `
        INSERT INTO scout_reconciliation_runs (
          id, scope_key, scope_type, scope_id, lookback_hours, dry_run, source,
          source_identity, idempotency_key, request_hash, lease_token, status, started_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'running', $12)
      `, [
        record.id,
        record.scopeKey,
        record.scopeType,
        record.scopeId,
        record.lookbackHours,
        record.dryRun,
        record.source,
        record.sourceIdentity,
        record.idempotencyKey,
        record.requestHash,
        record.leaseToken,
        record.startedAt,
      ]);
      return { kind: 'created' };
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return { kind: 'conflict' };
    }
  }

  async resumeFailedRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly startedAt: string;
  }): Promise<boolean> {
    const resumed = await run(this.pool, `
      UPDATE scout_reconciliation_runs
      SET lease_token = $1, status = 'running', error = NULL, summary = NULL,
          started_at = $2, completed_at = NULL
      WHERE id = $3 AND status = 'failed'
    `, [input.leaseToken, input.startedAt, input.runId]);
    return resumed === 1;
  }

  async failRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly completedAt: string;
  }): Promise<void> {
    await run(this.pool, `
      UPDATE scout_reconciliation_runs
      SET status = 'failed', error = $1, completed_at = $2
      WHERE id = $3 AND status = 'running' AND lease_token = $4
    `, [input.error, input.completedAt, input.runId, input.leaseToken]);
  }

  async listScopedTasks(
    scope: ScoutReconciliationScopeQuery,
  ): Promise<ScoutReconciliationTask[]> {
    if (scope.type === 'project') {
      return query<ScoutReconciliationTask>(this.pool, `
        SELECT ${RECONCILIATION_TASK_COLUMNS_T}
        FROM tasks t
        INNER JOIN task_projects tp ON tp.task_id = t.id
        WHERE t.connector_type = $1 AND t.status = ANY($2::text[])
          AND tp.project_id = $3
        ORDER BY t.id COLLATE "C"
        LIMIT $4
      `, [scope.connectorType, [...scope.openStatuses], scope.id, scope.limit]);
    }
    if (scope.type === 'task') {
      return query<ScoutReconciliationTask>(this.pool, `
        SELECT ${RECONCILIATION_TASK_COLUMNS}
        FROM tasks
        WHERE connector_type = $1 AND status = ANY($2::text[]) AND id = $3
        ORDER BY id COLLATE "C"
        LIMIT $4
      `, [scope.connectorType, [...scope.openStatuses], scope.id, scope.limit]);
    }
    return query<ScoutReconciliationTask>(this.pool, `
      SELECT ${RECONCILIATION_TASK_COLUMNS}
      FROM tasks
      WHERE connector_type = $1 AND status = ANY($2::text[])
      ORDER BY id COLLATE "C"
      LIMIT $3
    `, [scope.connectorType, [...scope.openStatuses], scope.limit]);
  }

  async listTaskStates(
    taskIds: readonly string[],
  ): Promise<ScoutReconciliationTaskStateRecord[]> {
    if (taskIds.length === 0) return [];
    return query<ScoutReconciliationTaskStateRecord>(this.pool, `
      SELECT ${TASK_STATE_COLUMNS}
      FROM scout_reconciliation_task_state
      WHERE task_id = ANY($1::text[])
      ORDER BY task_id COLLATE "C"
    `, [[...taskIds]]);
  }

  private async readEvaluationContext(
    client: Queryable,
    taskId: string,
    connectorInstanceId: string,
    evidenceHash: string,
  ): Promise<ScoutEvaluationContext> {
    const [currentTask] = await query<ScoutReconciliationTask>(client, `
      SELECT ${RECONCILIATION_TASK_COLUMNS} FROM tasks WHERE id = $1 LIMIT 1
    `, [taskId]);
    const [taskState] = await query<ScoutReconciliationTaskStateRecord>(client, `
      SELECT ${TASK_STATE_COLUMNS}
      FROM scout_reconciliation_task_state WHERE task_id = $1 LIMIT 1
    `, [taskId]);
    const connector = await this.readConnector(
      client,
      'scout',
      currentTask?.connectorInstanceId ?? connectorInstanceId,
    );
    const [dismissed] = await query<{ id: string }>(client, `
      SELECT id FROM scout_reconciliation_suggestions
      WHERE task_id = $1 AND evidence_hash = $2 AND status = 'dismissed'
      ORDER BY created_at DESC, id COLLATE "C"
      LIMIT 1
    `, [taskId, evidenceHash]);
    const [pending] = await query<{ id: string; evidenceHash: string }>(client, `
      SELECT id, evidence_hash AS "evidenceHash"
      FROM scout_reconciliation_suggestions
      WHERE task_id = $1 AND status = 'pending'
      LIMIT 1
    `, [taskId]);

    return {
      currentTask: currentTask ?? null,
      taskState: taskState ?? null,
      connector,
      dismissedSuggestionId: dismissed?.id ?? null,
      pendingSuggestion: pending ?? null,
    };
  }

  private async completeTaskColumns(
    client: Queryable,
    taskId: string,
    columns: Readonly<Record<string, string | null>>,
    expectedStatuses: readonly string[],
  ): Promise<number> {
    const entries = Object.entries(columns);
    const assignments = entries
      .map(([column], index) => `${column} = $${index + 1}`)
      .join(', ');
    return run(client, `
      UPDATE tasks SET ${assignments}
      WHERE id = $${entries.length + 1} AND status = ANY($${entries.length + 2}::text[])
    `, [...entries.map(([, value]) => value), taskId, [...expectedStatuses]]);
  }

  async commitRun<TPlan, TResult>(
    input: ScoutReconciliationCommitInput<TPlan, TResult>,
  ): Promise<ScoutReconciliationCommitResult<TResult>> {
    return withTransaction(this.pool, async (client) => {
      const results: TResult[] = [];
      for (const envelope of input.plans) {
        const context = await this.readEvaluationContext(
          client,
          envelope.taskId,
          envelope.connectorInstanceId,
          envelope.evidenceHash,
        );
        const decision = input.decide(envelope.plan, context);
        const evaluation = decision.evaluation;
        await run(client, `
          INSERT INTO scout_reconciliation_evaluations (
            id, run_id, task_id, candidate_action, action, confidence, evidence_hash,
            evidence, policy_decision, policy_reason, payload_hash, applied,
            applied_result, created_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13::jsonb, $14
          )
        `, [
          evaluation.id,
          evaluation.runId,
          evaluation.taskId,
          evaluation.candidateAction,
          evaluation.action,
          evaluation.confidence,
          evaluation.evidenceHash,
          JSON.stringify(evaluation.evidence),
          evaluation.policyDecision,
          evaluation.policyReason,
          evaluation.payloadHash,
          evaluation.applied,
          evaluation.appliedResult === null
            ? null
            : JSON.stringify(evaluation.appliedResult),
          evaluation.createdAt,
        ]);

        const effect = decision.effect;
        if (effect.kind === 'complete-task') {
          const completed = await this.completeTaskColumns(
            client,
            effect.taskId,
            effect.completion.columns,
            effect.completion.expectedStatuses,
          );
          if (completed !== 1) {
            throw new ScoutPersistenceConflictError(
              'task-changed-before-completion',
              'Task changed before completion could be applied',
            );
          }
          await run(client, `
            UPDATE scout_reconciliation_suggestions
            SET status = $1, updated_at = $2, acted_at = $3, acted_by = $4
            WHERE task_id = $5 AND status = 'pending'
          `, [
            effect.supersedePending.status,
            effect.supersedePending.updatedAt,
            effect.supersedePending.actedAt,
            effect.supersedePending.actedBy,
            effect.taskId,
          ]);
        } else if (effect.kind === 'insert-suggestion') {
          if (effect.supersede) {
            await run(client, `
              UPDATE scout_reconciliation_suggestions
              SET status = $1, updated_at = $2, acted_at = $3, acted_by = $4
              WHERE id = $5 AND status = 'pending'
            `, [
              effect.supersede.update.status,
              effect.supersede.update.updatedAt,
              effect.supersede.update.actedAt,
              effect.supersede.update.actedBy,
              effect.supersede.suggestionId,
            ]);
          }
          const suggestion = effect.suggestion;
          await run(client, `
            INSERT INTO scout_reconciliation_suggestions (
              id, task_id, run_id, evaluation_id, action, status, confidence,
              evidence_hash, evidence, policy_decision, policy_reason, payload_hash,
              proposed_effect, created_at, updated_at, expires_at
            ) VALUES (
              $1, $2, $3, $4, $5, 'pending', $6, $7, $8::jsonb, $9, $10, $11,
              $12::jsonb, $13, $14, $15
            )
          `, [
            suggestion.id,
            suggestion.taskId,
            suggestion.runId,
            suggestion.evaluationId,
            suggestion.action,
            suggestion.confidence,
            suggestion.evidenceHash,
            JSON.stringify(suggestion.evidence),
            suggestion.policyDecision,
            suggestion.policyReason,
            suggestion.payloadHash,
            JSON.stringify(suggestion.proposedEffect),
            suggestion.createdAt,
            suggestion.updatedAt,
            suggestion.expiresAt,
          ]);
        }

        if (effect.kind !== 'none') {
          await run(client, `
            UPDATE scout_reconciliation_evaluations
            SET applied = $1, applied_result = $2::jsonb
            WHERE id = $3
          `, [
            effect.kind === 'complete-task',
            JSON.stringify(effect.appliedResult),
            evaluation.id,
          ]);
        }

        results.push(decision.result);
      }

      const summary = input.summarize(results);
      const digest = input.digest(summary);
      if (digest) {
        await run(client, `
          INSERT INTO notifications (
            id, source_id, connector_type, connector_instance_id, title, body,
            level, level_rank, category, template_key, state, is_actionable,
            received_at, sort_at, group_key, dedupe_key, navigation_target,
            metadata, presentation
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
            $16, $17, $18::jsonb, $19::jsonb
          )
        `, [
          digest.id,
          digest.sourceId,
          digest.connectorType,
          digest.connectorInstanceId,
          digest.title,
          digest.body,
          digest.level,
          digest.levelRank,
          digest.category,
          digest.templateKey,
          digest.state,
          digest.isActionable,
          digest.receivedAt,
          digest.sortAt,
          digest.groupKey,
          digest.dedupeKey,
          digest.navigationTarget,
          JSON.stringify(digest.metadata),
          JSON.stringify(digest.presentation),
        ]);
      }

      const completion = await run(client, `
        UPDATE scout_reconciliation_runs
        SET status = 'completed', summary = $1::jsonb, completed_at = $2
        WHERE id = $3 AND status = 'running' AND lease_token = $4
      `, [JSON.stringify(summary), input.completedAt, input.runId, input.leaseToken]);
      if (completion !== 1) {
        throw new ScoutPersistenceConflictError(
          'run-claim-lost',
          'Reconciliation run lost its active claim',
        );
      }
      return { results, summary };
    });
  }

  async listPendingSuggestions(input: {
    readonly now: string;
    readonly limit: number;
    readonly openStatuses: readonly string[];
    readonly terminalStatuses: readonly string[];
  }): Promise<ScoutReconciliationSuggestionRow[]> {
    await run(this.pool, `
      UPDATE scout_reconciliation_suggestions
      SET status = 'superseded', updated_at = $1, acted_at = $1, acted_by = 'expiration'
      WHERE status = 'pending' AND expires_at <= $1
    `, [input.now]);

    await run(this.pool, `
      UPDATE scout_reconciliation_suggestions
      SET status = 'superseded', updated_at = $1, acted_at = $1,
          acted_by = 'task-terminal'
      WHERE status = 'pending' AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = scout_reconciliation_suggestions.task_id
          AND tasks.status = ANY($2::text[])
      )
    `, [input.now, [...input.terminalStatuses]]);

    const rows = await query<ScoutReconciliationSuggestionRow & {
      proposedEffect: unknown;
    }>(this.pool, `
      SELECT
        s.id, s.task_id AS "taskId", t.title AS "taskTitle",
        t.priority AS "taskPriority", t.due_date AS "taskDueDate", s.action,
        s.confidence, s.evidence, s.policy_reason AS "policyReason",
        s.payload_hash AS "payloadHash", s.proposed_effect AS "proposedEffect",
        s.created_at AS "createdAt", s.expires_at AS "expiresAt"
      FROM scout_reconciliation_suggestions s
      INNER JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending' AND t.status = ANY($1::text[])
      ORDER BY s.confidence DESC, s.created_at DESC
      LIMIT $2
    `, [[...input.openStatuses], input.limit]);

    return rows.map((row) => ({
      ...row,
      proposedEffect: asJsonObject(row.proposedEffect) ?? {},
    }));
  }

  async actOnSuggestion<TResult>(input: {
    readonly suggestionId: string;
    readonly decide: (
      snapshot: ScoutSuggestionActionSnapshot,
    ) => ScoutSuggestionActionDecision<TResult>;
  }): Promise<TResult> {
    return withTransaction(this.pool, async (client) => {
      const [suggestionRow] = await query<ScoutSuggestionRecord>(client, `
        SELECT
          id, task_id AS "taskId", run_id AS "runId",
          evaluation_id AS "evaluationId", action, status,
          payload_hash AS "payloadHash", evidence_hash AS "evidenceHash",
          expires_at AS "expiresAt"
        FROM scout_reconciliation_suggestions WHERE id = $1
        LIMIT 1
      `, [input.suggestionId]);
      const suggestion = suggestionRow ?? null;

      const [taskRow] = suggestion
        ? await query<ScoutReconciliationTask>(client, `
            SELECT ${RECONCILIATION_TASK_COLUMNS} FROM tasks WHERE id = $1 LIMIT 1
          `, [suggestion.taskId])
        : [];
      const task = taskRow ?? null;
      const connector = task
        ? await this.readConnector(client, 'scout', task.connectorInstanceId)
        : null;

      const decision = input.decide({ suggestion, task, connector });
      if (decision.kind === 'replay') return decision.result;

      const claimed = await run(client, `
        UPDATE scout_reconciliation_suggestions
        SET status = $1, updated_at = $2, acted_at = $3, acted_by = $4
        WHERE id = $5 AND status = 'pending' AND payload_hash = $6
      `, [
        decision.suggestionUpdate.status,
        decision.suggestionUpdate.updatedAt,
        decision.suggestionUpdate.actedAt,
        decision.suggestionUpdate.actedBy,
        input.suggestionId,
        decision.expectedPayloadHash,
      ]);
      if (claimed !== 1) {
        throw new ScoutPersistenceConflictError(
          'suggestion-acted-concurrently',
          'Suggestion was acted on concurrently',
        );
      }

      if (decision.kind === 'accept') {
        const completed = await this.completeTaskColumns(
          client,
          decision.taskId,
          decision.completion.columns,
          decision.completion.expectedStatuses,
        );
        if (completed !== 1) {
          throw new ScoutPersistenceConflictError(
            'task-changed-before-confirmation',
            'Task changed before confirmation could be applied',
          );
        }
        await run(client, `
          UPDATE scout_reconciliation_evaluations
          SET applied = TRUE, applied_result = $1::jsonb
          WHERE id = $2
        `, [JSON.stringify(decision.appliedResult), decision.evaluationId]);
        return decision.result;
      }

      if (decision.taskState) {
        const state = decision.taskState;
        await run(client, `
          INSERT INTO scout_reconciliation_task_state (
            task_id, never_auto_complete, reason, source_run_id, updated_at, updated_by
          ) VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (task_id) DO UPDATE SET
            never_auto_complete = EXCLUDED.never_auto_complete,
            reason = EXCLUDED.reason,
            source_run_id = EXCLUDED.source_run_id,
            updated_at = EXCLUDED.updated_at,
            updated_by = EXCLUDED.updated_by
        `, [
          state.taskId,
          state.neverAutoComplete,
          state.reason,
          state.sourceRunId,
          state.updatedAt,
          state.updatedBy,
        ]);
      }
      return decision.result;
    });
  }

  async hasAppliedAutoCompletion(taskId: string): Promise<boolean> {
    const rows = await query<{ id: string }>(this.pool, `
      SELECT id FROM scout_reconciliation_evaluations
      WHERE task_id = $1 AND action = 'auto-complete' AND applied = TRUE
      LIMIT 1
    `, [taskId]);
    return rows.length > 0;
  }
}

export function createPostgresScoutIngestionReconciliationRepository(
  pool: Pool,
): ScoutIngestionReconciliationPersistence {
  return {
    ingestion: new PostgresScoutIngestionRepository(pool),
    comparison: new PostgresScoutComparisonRepository(pool),
    reconciliation: new PostgresScoutReconciliationRepository(pool),
  };
}
