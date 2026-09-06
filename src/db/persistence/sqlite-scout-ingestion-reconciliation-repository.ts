import type Database from 'better-sqlite3';
import type { TaskFieldStateRecord } from '@/lib/tasks/field-state';
import {
  ScoutPersistenceConflictError,
  type ScoutComparisonLinkedPair,
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
} from './scout-ingestion-reconciliation';

type SqliteDatabase = Database.Database;

function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ');
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseJsonObjectColumn(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonColumn(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

interface TaskRow {
  id: string;
  title: string;
  description: string | null;
  priority: string;
  due_date: string | null;
  metadata: unknown;
  status: string;
  snoozed_until: string | null;
}

function mapExistingTask(row: TaskRow): ScoutExistingTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    dueDate: row.due_date,
    metadata: row.metadata,
    status: row.status,
    snoozedUntil: row.snoozed_until,
  };
}

interface ReconciliationTaskRow {
  id: string;
  title: string;
  connector_type: string;
  connector_instance_id: string;
  source_id: string;
  status: string;
  priority: string;
  due_date: string | null;
  completed_at: string | null;
  status_reason: string | null;
}

const RECONCILIATION_TASK_COLUMNS = `
  id, title, connector_type, connector_instance_id, source_id, status,
  priority, due_date, completed_at, status_reason
`;

const RECONCILIATION_TASK_COLUMNS_T = `
  t.id, t.title, t.connector_type, t.connector_instance_id, t.source_id, t.status,
  t.priority, t.due_date, t.completed_at, t.status_reason
`;

function mapReconciliationTask(row: ReconciliationTaskRow): ScoutReconciliationTask {
  return {
    id: row.id,
    title: row.title,
    connectorType: row.connector_type,
    connectorInstanceId: row.connector_instance_id,
    sourceId: row.source_id,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    completedAt: row.completed_at,
    statusReason: row.status_reason,
  };
}

interface TaskStateRow {
  task_id: string;
  never_auto_complete: number;
  reason: string;
  source_run_id: string | null;
  updated_at: string;
  updated_by: string;
}

function mapTaskState(row: TaskStateRow): ScoutReconciliationTaskStateRecord {
  return {
    taskId: row.task_id,
    neverAutoComplete: row.never_auto_complete === 1,
    reason: row.reason,
    sourceRunId: row.source_run_id,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

interface RunRow {
  id: string;
  scope_key: string;
  request_hash: string;
  status: 'running' | 'completed' | 'failed';
  dry_run: number;
  started_at: string;
  summary: unknown;
}

function mapRun(row: RunRow): ScoutReconciliationRunRecord {
  const summary = parseJsonObjectColumn(row.summary);
  return {
    id: row.id,
    scopeKey: row.scope_key,
    requestHash: row.request_hash,
    status: row.status,
    dryRun: row.dry_run === 1,
    startedAt: row.started_at,
    summary: summary as Record<string, number> | null,
  };
}

class SqliteScoutIngestionRepository implements ScoutIngestionRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private insertSourceList(definition: ScoutSourceListDefinition, connectorInstanceId: string, now: string): number {
    return this.db.prepare(`
      INSERT INTO source_lists (
        id, connector_instance_id, source_id, name, type, task_count,
        last_synced_at, sort_order, hidden, icon, icon_color
      ) VALUES (?, ?, ?, ?, ?, 0, ?, 0, 0, ?, ?)
      ON CONFLICT DO NOTHING
    `).run(
      definition.id,
      connectorInstanceId,
      definition.sourceId,
      definition.name,
      definition.type,
      now,
      definition.icon,
      definition.iconColor,
    ).changes;
  }

  async bootstrapConnector(
    input: ScoutConnectorBootstrapInput,
  ): Promise<ScoutConnectorBootstrapResult> {
    const transaction = this.db.transaction((): ScoutConnectorBootstrapResult => {
      const existing = this.db.prepare(`
        SELECT id, enabled, settings FROM connector_configs WHERE id = ?
      `).get(input.connectorInstanceId) as
        { id: string; enabled: number; settings: unknown } | undefined;

      if (existing) {
        return {
          existed: true,
          enabled: existing.enabled === 1,
          settings: existing.settings,
        };
      }

      this.db.prepare(`
        INSERT INTO connector_configs (
          id, type, name, enabled, sync_mode, poll_interval_minutes,
          capabilities, credentials, settings, synced_lists, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
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
        input.now,
      );

      for (const definition of input.sourceLists) {
        this.insertSourceList(definition, input.connectorInstanceId, input.now);
      }

      return { existed: false, enabled: true, settings: null };
    });
    return transaction.immediate();
  }

  async ensureSourceList(input: {
    readonly connectorInstanceId: string;
    readonly definition: ScoutSourceListDefinition;
    readonly now: string;
  }): Promise<{ readonly created: boolean }> {
    const transaction = this.db.transaction((): { created: boolean } => {
      const existing = this.db.prepare(`
        SELECT id FROM source_lists WHERE source_id = ?
      `).get(input.definition.sourceId) as { id: string } | undefined;
      if (existing) return { created: false };
      const changes = this.insertSourceList(
        input.definition,
        input.connectorInstanceId,
        input.now,
      );
      return { created: changes > 0 };
    });
    return transaction.immediate();
  }

  async listCrossConnectorCandidates(input: {
    readonly excludeConnectorType: string;
    readonly closedStatuses: readonly string[];
  }): Promise<ScoutCrossConnectorCandidate[]> {
    const rows = this.db.prepare(`
      SELECT id, title, connector_type, connector_instance_id, source_id, metadata
      FROM tasks
      WHERE connector_type != ?
        AND status NOT IN (${placeholders(input.closedStatuses.length)})
      ORDER BY id
    `).all(input.excludeConnectorType, ...input.closedStatuses) as {
      id: string;
      title: string;
      connector_type: string;
      connector_instance_id: string;
      source_id: string;
      metadata: unknown;
    }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      connectorType: row.connector_type,
      connectorInstanceId: row.connector_instance_id,
      sourceId: row.source_id,
      metadata: row.metadata,
    }));
  }

  async findExistingTask(input: {
    readonly connectorType: string;
    readonly sourceId: string;
  }): Promise<ScoutExistingTask | null> {
    const row = this.db.prepare(`
      SELECT id, title, description, priority, due_date, metadata, status, snoozed_until
      FROM tasks
      WHERE connector_type = ? AND source_id = ?
      ORDER BY id
      LIMIT 1
    `).get(input.connectorType, input.sourceId) as TaskRow | undefined;
    return row ? mapExistingTask(row) : null;
  }

  async findTriageItem(input: {
    readonly sourcePlatform: string;
    readonly sourceId: string;
  }): Promise<ScoutTriageItemState | null> {
    const row = this.db.prepare(`
      SELECT id, status FROM triage_items
      WHERE source_platform = ? AND source_id = ?
    `).get(input.sourcePlatform, input.sourceId) as
      { id: string; status: string } | undefined;
    return row ?? null;
  }

  async filterExistingProjectIds(projectIds: readonly string[]): Promise<string[]> {
    if (projectIds.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT id FROM hub_projects WHERE id IN (${placeholders(projectIds.length)})
    `).all(...projectIds) as { id: string }[];
    const present = new Set(rows.map((row) => row.id));
    return projectIds.filter((id) => present.has(id));
  }

  async readIngestGuard(input: {
    readonly connectorInstanceId: string;
    readonly sourceId: string;
  }): Promise<ScoutIngestGuard> {
    const tombstone = this.db.prepare(`
      SELECT source_id FROM task_ingest_suppressions
      WHERE connector_instance_id = ? AND source_id = ?
    `).get(input.connectorInstanceId, input.sourceId) as { source_id: string } | undefined;
    if (tombstone) return { suppressed: true, linkedTaskId: null };

    const linked = this.db.prepare(`
      SELECT task_id FROM task_linked_sources
      WHERE connector_instance_id = ? AND source_id = ?
    `).get(input.connectorInstanceId, input.sourceId) as { task_id: string } | undefined;
    return { suppressed: false, linkedTaskId: linked?.task_id ?? null };
  }

  async mergeExistingTask(input: ScoutTaskMergeInput): Promise<ScoutTaskMergeDecision> {
    const transaction = this.db.transaction((): ScoutTaskMergeDecision => {
      const current = this.db.prepare(`
        SELECT id, title, description, priority, due_date, metadata, status, snoozed_until
        FROM tasks WHERE id = ?
      `).get(input.taskId) as TaskRow | undefined;

      const fieldStateRows = current
        ? this.db.prepare(`
            SELECT task_id, field_name, source_value, locally_overridden,
                   source_observed_at, local_edited_at, updated_at
            FROM task_field_states WHERE task_id = ?
            ORDER BY field_name
          `).all(input.taskId) as {
            task_id: string;
            field_name: string;
            source_value: string;
            locally_overridden: number;
            source_observed_at: string | null;
            local_edited_at: string | null;
            updated_at: string;
          }[]
        : [];

      const fieldStates: TaskFieldStateRecord[] = fieldStateRows.map((row) => ({
        taskId: row.task_id,
        fieldName: row.field_name,
        sourceValue: row.source_value,
        locallyOverridden: row.locally_overridden === 1,
        sourceObservedAt: row.source_observed_at,
        localEditedAt: row.local_edited_at,
        updatedAt: row.updated_at,
      }));

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
          assignments.push(`${column} = ?`);
          params.push(value);
        }
        assignments.push('metadata = ?', 'updated_at = ?', 'last_synced_at = ?');
        params.push(
          decision.taskWrite.metadata,
          decision.taskWrite.updatedAt,
          decision.taskWrite.lastSyncedAt,
          input.taskId,
        );
        this.db.prepare(`
          UPDATE tasks SET ${assignments.join(', ')} WHERE id = ?
        `).run(...params);
      }

      const upsert = this.db.prepare(`
        INSERT INTO task_field_states (
          task_id, field_name, source_value, locally_overridden,
          source_observed_at, local_edited_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (task_id, field_name) DO UPDATE SET
          source_value = excluded.source_value,
          locally_overridden = excluded.locally_overridden,
          source_observed_at = excluded.source_observed_at,
          local_edited_at = excluded.local_edited_at,
          updated_at = excluded.updated_at
      `);
      for (const observation of decision.observations) {
        upsert.run(
          input.taskId,
          observation.fieldName,
          observation.sourceValue,
          observation.locallyOverridden ? 1 : 0,
          observation.sourceObservedAt,
          observation.localEditedAt,
          observation.updatedAt,
        );
      }
      return decision;
    });
    return transaction.immediate();
  }

  async createTask(input: ScoutTaskCreationInput): Promise<ScoutTaskCreationOutcome> {
    const transaction = this.db.transaction((): ScoutTaskCreationOutcome => {
      const tombstone = this.db.prepare(`
        SELECT source_id FROM task_ingest_suppressions
        WHERE connector_instance_id = ? AND source_id = ?
      `).get(input.connectorInstanceId, input.sourceId) as { source_id: string } | undefined;
      if (tombstone) return { kind: 'suppressed' };

      const insertion = this.db.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title, description,
          status, priority, due_date, created_at, updated_at, depth,
          is_checklist_item, source_list_id, source_list_name, sync_status,
          last_synced_at, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, 'synced', ?, ?)
        ON CONFLICT (source_id, connector_instance_id) DO NOTHING
      `).run(
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
        input.now,
        input.sourceListId,
        input.sourceListName,
        input.now,
        input.metadata,
      );

      if (insertion.changes === 0) {
        const winner = this.db.prepare(`
          SELECT id FROM tasks
          WHERE connector_instance_id = ? AND source_id = ?
        `).get(input.connectorInstanceId, input.sourceId) as { id: string } | undefined;
        if (!winner) {
          throw new Error(`Scout ingest conflict for ${input.sourceId} had no winning task`);
        }
        return { kind: 'conflict', taskId: winner.id };
      }

      const insertFieldState = this.db.prepare(`
        INSERT INTO task_field_states (
          task_id, field_name, source_value, locally_overridden,
          source_observed_at, local_edited_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const state of input.fieldStates) {
        insertFieldState.run(
          input.taskId,
          state.fieldName,
          state.sourceValue,
          state.locallyOverridden ? 1 : 0,
          state.sourceObservedAt,
          state.localEditedAt,
          state.updatedAt,
        );
      }

      if (input.tags.length > 0) {
        const insertTag = this.db.prepare(`
          INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT DO NOTHING
        `);
        const insertTaskTag = this.db.prepare(
          'INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)',
        );
        for (const tag of input.tags) {
          insertTag.run(
            tag.id,
            tag.name,
            tag.slug,
            tag.type,
            tag.source,
            tag.color,
            tag.confirmed ? 1 : 0,
            tag.createdAt,
          );
          insertTaskTag.run(input.taskId, tag.id);
        }
      }

      if (input.projectId) {
        this.db.prepare(
          'INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)',
        ).run(input.taskId, input.projectId);
      }

      return { kind: 'created' };
    });
    return transaction.immediate();
  }

  async linkSourceToTask(input: ScoutLinkSourceInput): Promise<ScoutLinkSourceOutcome> {
    const transaction = this.db.transaction((): ScoutLinkSourceOutcome => {
      const tombstone = this.db.prepare(`
        SELECT source_id FROM task_ingest_suppressions
        WHERE connector_instance_id = ? AND source_id = ?
      `).get(input.connectorInstanceId, input.sourceId) as { source_id: string } | undefined;
      if (tombstone) return { kind: 'suppressed' };

      this.db.prepare(`
        INSERT INTO task_linked_sources (
          id, task_id, connector_type, connector_instance_id, source_id,
          title, linked_at, match_confidence, metadata
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).run(
        input.id,
        input.taskId,
        input.connectorType,
        input.connectorInstanceId,
        input.sourceId,
        input.title,
        input.linkedAt,
        input.matchConfidence,
        input.metadata,
      );
      return { kind: 'linked' };
    });
    return transaction.immediate();
  }

  async upsertTriageItem(input: ScoutTriageUpsertInput): Promise<ScoutTriageUpsertOutcome> {
    const values = input.values;
    const transaction = this.db.transaction((): ScoutTriageUpsertOutcome => {
      const existing = this.db.prepare(`
        SELECT id, status FROM triage_items
        WHERE source_platform = ? AND source_id = ?
      `).get(input.sourcePlatform, input.sourceId) as
        { id: string; status: string } | undefined;

      if (existing && (existing.status === 'actioned' || existing.status === 'dismissed')) {
        return { kind: 'closed', triageItemId: existing.id };
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
        this.db.prepare(`
          UPDATE triage_items SET
            source_url = ?, canonical_url = ?, title = ?, description = ?,
            content_type = ?, captured_at = ?, ai_summary = ?, ai_categories = ?,
            ai_suggested_actions = ?, ai_relevance_score = ?, ai_urgency = ?,
            raw_metadata = ?
          WHERE id = ?
        `).run(...refreshParams, existing.id);
        return { kind: 'updated', triageItemId: existing.id };
      }

      this.db.prepare(`
        INSERT INTO triage_items (
          id, source_platform, source_id, source_url, canonical_url, title,
          description, content_type, captured_at, ingested_at, status,
          ai_summary, ai_categories, ai_suggested_actions, ai_relevance_score,
          ai_urgency, raw_metadata, actions_taken
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, '[]')
        ON CONFLICT (source_platform, source_id) DO UPDATE SET
          source_url = excluded.source_url,
          canonical_url = excluded.canonical_url,
          title = excluded.title,
          description = excluded.description,
          content_type = excluded.content_type,
          captured_at = excluded.captured_at,
          ai_summary = excluded.ai_summary,
          ai_categories = excluded.ai_categories,
          ai_suggested_actions = excluded.ai_suggested_actions,
          ai_relevance_score = excluded.ai_relevance_score,
          ai_urgency = excluded.ai_urgency,
          raw_metadata = excluded.raw_metadata
        WHERE triage_items.status NOT IN ('actioned', 'dismissed')
      `).run(
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
      );

      const stored = this.db.prepare(`
        SELECT id, status FROM triage_items
        WHERE source_platform = ? AND source_id = ?
      `).get(input.sourcePlatform, input.sourceId) as
        { id: string; status: string } | undefined;
      if (stored && (stored.status === 'actioned' || stored.status === 'dismissed')) {
        return { kind: 'closed', triageItemId: stored.id };
      }
      return { kind: 'created', triageItemId: stored?.id ?? input.triageItemId };
    });
    return transaction.immediate();
  }

  async refreshSourceListCounts(
    refreshes: readonly ScoutSourceListCountRefresh[],
  ): Promise<void> {
    if (refreshes.length === 0) return;
    const transaction = this.db.transaction(() => {
      const update = this.db.prepare(`
        UPDATE source_lists SET
          task_count = (
            SELECT COUNT(*) FROM tasks
            WHERE tasks.connector_type = ? AND tasks.source_list_id = ?
          ),
          last_synced_at = ?
        WHERE source_id = ?
      `);
      for (const refresh of refreshes) {
        update.run(
          refresh.connectorType,
          refresh.sourceListId,
          refresh.syncedAt,
          refresh.sourceListId,
        );
      }
    });
    transaction.immediate();
  }
}

class SqliteScoutComparisonRepository implements ScoutComparisonRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private listTasks(connectorType: string, since: string): ScoutComparisonTask[] {
    const rows = this.db.prepare(`
      SELECT id, title, source_id, created_at, priority, status, metadata
      FROM tasks
      WHERE connector_type = ? AND created_at >= ?
      ORDER BY created_at, id
    `).all(connectorType, since) as {
      id: string;
      title: string;
      source_id: string;
      created_at: string;
      priority: string;
      status: string;
      metadata: unknown;
    }[];
    return rows.map((row) => ({
      id: row.id,
      title: row.title,
      sourceId: row.source_id,
      createdAt: row.created_at,
      priority: row.priority,
      status: row.status,
      metadata: row.metadata,
    }));
  }

  async readWindow(input: {
    readonly since: string;
    readonly scoutConnectorType: string;
    readonly comparisonConnectorType: string;
  }): Promise<ScoutComparisonWindow> {
    const linkedRows = this.db.prepare(`
      SELECT task_id, source_id, connector_type FROM task_linked_sources
      ORDER BY id
    `).all() as { task_id: string; source_id: string; connector_type: string }[];
    const linkedPairs: ScoutComparisonLinkedPair[] = linkedRows.map((row) => ({
      taskId: row.task_id,
      sourceId: row.source_id,
      connectorType: row.connector_type,
    }));
    return {
      scoutTasks: this.listTasks(input.scoutConnectorType, input.since),
      comparisonTasks: this.listTasks(input.comparisonConnectorType, input.since),
      linkedPairs,
    };
  }
}

class SqliteScoutReconciliationRepository implements ScoutReconciliationRepository {
  constructor(private readonly db: SqliteDatabase) {}

  private readConnector(
    connectorType: string,
    connectorInstanceId?: string,
  ): ScoutConnectorConfigurationRecord | null {
    const row = this.db.prepare(`
      SELECT enabled, settings FROM connector_configs
      WHERE type = ? AND deleted_at IS NULL
        ${connectorInstanceId ? 'AND id = ?' : ''}
      ORDER BY id
      LIMIT 1
    `).get(
      ...(connectorInstanceId ? [connectorType, connectorInstanceId] : [connectorType]),
    ) as { enabled: number; settings: unknown } | undefined;
    return row ? { enabled: row.enabled === 1, settings: row.settings } : null;
  }

  async getConnectorConfiguration(input: {
    readonly connectorType: string;
    readonly connectorInstanceId?: string;
  }): Promise<ScoutConnectorConfigurationRecord | null> {
    return this.readConnector(input.connectorType, input.connectorInstanceId);
  }

  async expireStaleRuns(input: {
    readonly scopeKey: string;
    readonly startedBefore: string;
    readonly completedAt: string;
    readonly error: string;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE scout_reconciliation_runs
      SET status = 'failed', error = ?, completed_at = ?
      WHERE scope_key = ? AND status = 'running' AND started_at <= ?
    `).run(input.error, input.completedAt, input.scopeKey, input.startedBefore);
  }

  async findRunByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<ScoutReconciliationRunRecord | null> {
    const row = this.db.prepare(`
      SELECT id, scope_key, request_hash, status, dry_run, started_at, summary
      FROM scout_reconciliation_runs WHERE idempotency_key = ?
      LIMIT 1
    `).get(idempotencyKey) as RunRow | undefined;
    return row ? mapRun(row) : null;
  }

  async loadRunEvaluations(runId: string): Promise<ScoutReconciliationEvaluationView[]> {
    const rows = this.db.prepare(`
      SELECT
        e.task_id, t.title, e.candidate_action, e.action, e.confidence,
        e.evidence, e.policy_decision, e.policy_reason, e.applied, e.applied_result
      FROM scout_reconciliation_evaluations e
      INNER JOIN tasks t ON t.id = e.task_id
      WHERE e.run_id = ?
      ORDER BY e.created_at, e.id
    `).all(runId) as {
      task_id: string;
      title: string;
      candidate_action: string;
      action: string;
      confidence: number;
      evidence: unknown;
      policy_decision: string;
      policy_reason: string;
      applied: number;
      applied_result: unknown;
    }[];
    return rows.map((row) => ({
      taskId: row.task_id,
      title: row.title,
      candidateAction: row.candidate_action,
      action: row.action,
      confidence: row.confidence,
      evidence: parseJsonColumn(row.evidence),
      policyDecision: row.policy_decision,
      policyReason: row.policy_reason,
      applied: row.applied === 1,
      appliedResult: parseJsonObjectColumn(row.applied_result),
    }));
  }

  async findRecentCompletedRun(input: {
    readonly scopeKey: string;
    readonly startedAtOrAfter: string;
  }): Promise<{ readonly startedAt: string } | null> {
    const row = this.db.prepare(`
      SELECT started_at FROM scout_reconciliation_runs
      WHERE scope_key = ? AND dry_run = 0 AND status = 'completed' AND started_at >= ?
      ORDER BY started_at DESC
      LIMIT 1
    `).get(input.scopeKey, input.startedAtOrAfter) as { started_at: string } | undefined;
    return row ? { startedAt: row.started_at } : null;
  }

  async createRun(
    record: ScoutReconciliationRunInsert,
  ): Promise<{ readonly kind: 'created' } | { readonly kind: 'conflict' }> {
    try {
      this.db.prepare(`
        INSERT INTO scout_reconciliation_runs (
          id, scope_key, scope_type, scope_id, lookback_hours, dry_run, source,
          source_identity, idempotency_key, request_hash, lease_token, status, started_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)
      `).run(
        record.id,
        record.scopeKey,
        record.scopeType,
        record.scopeId,
        record.lookbackHours,
        record.dryRun ? 1 : 0,
        record.source,
        record.sourceIdentity,
        record.idempotencyKey,
        record.requestHash,
        record.leaseToken,
        record.startedAt,
      );
      return { kind: 'created' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('UNIQUE constraint failed')) throw error;
      return { kind: 'conflict' };
    }
  }

  async resumeFailedRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly startedAt: string;
  }): Promise<boolean> {
    const resumed = this.db.prepare(`
      UPDATE scout_reconciliation_runs
      SET lease_token = ?, status = 'running', error = NULL, summary = NULL,
          started_at = ?, completed_at = NULL
      WHERE id = ? AND status = 'failed'
    `).run(input.leaseToken, input.startedAt, input.runId);
    return resumed.changes === 1;
  }

  async failRun(input: {
    readonly runId: string;
    readonly leaseToken: string;
    readonly error: string;
    readonly completedAt: string;
  }): Promise<void> {
    this.db.prepare(`
      UPDATE scout_reconciliation_runs
      SET status = 'failed', error = ?, completed_at = ?
      WHERE id = ? AND status = 'running' AND lease_token = ?
    `).run(input.error, input.completedAt, input.runId, input.leaseToken);
  }

  async listScopedTasks(
    scope: ScoutReconciliationScopeQuery,
  ): Promise<ScoutReconciliationTask[]> {
    const statusPlaceholders = placeholders(scope.openStatuses.length);
    const rows = scope.type === 'project'
      ? this.db.prepare(`
          SELECT ${RECONCILIATION_TASK_COLUMNS_T}
          FROM tasks t
          INNER JOIN task_projects tp ON tp.task_id = t.id
          WHERE t.connector_type = ? AND t.status IN (${statusPlaceholders})
            AND tp.project_id = ?
          ORDER BY t.id
          LIMIT ?
        `).all(
          scope.connectorType,
          ...scope.openStatuses,
          scope.id,
          scope.limit,
        ) as ReconciliationTaskRow[]
      : this.db.prepare(`
          SELECT ${RECONCILIATION_TASK_COLUMNS}
          FROM tasks
          WHERE connector_type = ? AND status IN (${statusPlaceholders})
            ${scope.type === 'task' ? 'AND id = ?' : ''}
          ORDER BY id
          LIMIT ?
        `).all(
          scope.connectorType,
          ...scope.openStatuses,
          ...(scope.type === 'task' ? [scope.id] : []),
          scope.limit,
        ) as ReconciliationTaskRow[];
    return rows.map(mapReconciliationTask);
  }

  async listTaskStates(
    taskIds: readonly string[],
  ): Promise<ScoutReconciliationTaskStateRecord[]> {
    if (taskIds.length === 0) return [];
    const rows = this.db.prepare(`
      SELECT task_id, never_auto_complete, reason, source_run_id, updated_at, updated_by
      FROM scout_reconciliation_task_state
      WHERE task_id IN (${placeholders(taskIds.length)})
      ORDER BY task_id
    `).all(...taskIds) as TaskStateRow[];
    return rows.map(mapTaskState);
  }

  private readEvaluationContext(
    taskId: string,
    connectorInstanceId: string,
    evidenceHash: string,
  ): ScoutEvaluationContext {
    const currentTask = this.db.prepare(`
      SELECT ${RECONCILIATION_TASK_COLUMNS} FROM tasks WHERE id = ? LIMIT 1
    `).get(taskId) as ReconciliationTaskRow | undefined;
    const taskState = this.db.prepare(`
      SELECT task_id, never_auto_complete, reason, source_run_id, updated_at, updated_by
      FROM scout_reconciliation_task_state WHERE task_id = ? LIMIT 1
    `).get(currentTask?.id ?? taskId) as TaskStateRow | undefined;
    const connector = this.readConnector(
      'scout',
      currentTask?.connector_instance_id ?? connectorInstanceId,
    );
    const dismissed = this.db.prepare(`
      SELECT id FROM scout_reconciliation_suggestions
      WHERE task_id = ? AND evidence_hash = ? AND status = 'dismissed'
      ORDER BY created_at DESC, id
      LIMIT 1
    `).get(taskId, evidenceHash) as { id: string } | undefined;
    const pending = this.db.prepare(`
      SELECT id, evidence_hash FROM scout_reconciliation_suggestions
      WHERE task_id = ? AND status = 'pending'
      LIMIT 1
    `).get(taskId) as { id: string; evidence_hash: string } | undefined;

    return {
      currentTask: currentTask ? mapReconciliationTask(currentTask) : null,
      taskState: taskState ? mapTaskState(taskState) : null,
      connector,
      dismissedSuggestionId: dismissed?.id ?? null,
      pendingSuggestion: pending
        ? { id: pending.id, evidenceHash: pending.evidence_hash }
        : null,
    };
  }

  private insertEvaluation(evaluation: {
    id: string;
    runId: string;
    taskId: string;
    candidateAction: string;
    action: string;
    confidence: number;
    evidenceHash: string;
    evidence: unknown;
    policyDecision: string;
    policyReason: string;
    payloadHash: string;
    applied: boolean;
    appliedResult: Record<string, unknown> | null;
    createdAt: string;
  }): void {
    this.db.prepare(`
      INSERT INTO scout_reconciliation_evaluations (
        id, run_id, task_id, candidate_action, action, confidence, evidence_hash,
        evidence, policy_decision, policy_reason, payload_hash, applied,
        applied_result, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
      evaluation.applied ? 1 : 0,
      evaluation.appliedResult === null ? null : JSON.stringify(evaluation.appliedResult),
      evaluation.createdAt,
    );
  }

  private completeTask(
    taskId: string,
    columns: Readonly<Record<string, string | null>>,
    expectedStatuses: readonly string[],
  ): void {
    const entries = Object.entries(columns);
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    const changed = this.db.prepare(`
      UPDATE tasks SET ${assignments}
      WHERE id = ? AND status IN (${placeholders(expectedStatuses.length)})
    `).run(...entries.map(([, value]) => value), taskId, ...expectedStatuses);
    if (changed.changes !== 1) {
      throw new ScoutPersistenceConflictError(
        'task-changed-before-completion',
        'Task changed before completion could be applied',
      );
    }
  }

  async commitRun<TPlan, TResult>(
    input: ScoutReconciliationCommitInput<TPlan, TResult>,
  ): Promise<ScoutReconciliationCommitResult<TResult>> {
    const transaction = this.db.transaction((): ScoutReconciliationCommitResult<TResult> => {
      const results: TResult[] = [];
      for (const envelope of input.plans) {
        const context = this.readEvaluationContext(
          envelope.taskId,
          envelope.connectorInstanceId,
          envelope.evidenceHash,
        );
        const decision = input.decide(envelope.plan, context);
        this.insertEvaluation(decision.evaluation);

        const effect = decision.effect;
        if (effect.kind === 'complete-task') {
          this.completeTask(
            effect.taskId,
            effect.completion.columns,
            effect.completion.expectedStatuses,
          );
          this.db.prepare(`
            UPDATE scout_reconciliation_suggestions
            SET status = ?, updated_at = ?, acted_at = ?, acted_by = ?
            WHERE task_id = ? AND status = 'pending'
          `).run(
            effect.supersedePending.status,
            effect.supersedePending.updatedAt,
            effect.supersedePending.actedAt,
            effect.supersedePending.actedBy,
            effect.taskId,
          );
        } else if (effect.kind === 'insert-suggestion') {
          if (effect.supersede) {
            this.db.prepare(`
              UPDATE scout_reconciliation_suggestions
              SET status = ?, updated_at = ?, acted_at = ?, acted_by = ?
              WHERE id = ? AND status = 'pending'
            `).run(
              effect.supersede.update.status,
              effect.supersede.update.updatedAt,
              effect.supersede.update.actedAt,
              effect.supersede.update.actedBy,
              effect.supersede.suggestionId,
            );
          }
          const suggestion = effect.suggestion;
          this.db.prepare(`
            INSERT INTO scout_reconciliation_suggestions (
              id, task_id, run_id, evaluation_id, action, status, confidence,
              evidence_hash, evidence, policy_decision, policy_reason, payload_hash,
              proposed_effect, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
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
          );
        }

        if (effect.kind !== 'none') {
          this.db.prepare(`
            UPDATE scout_reconciliation_evaluations
            SET applied = ?, applied_result = ?
            WHERE id = ?
          `).run(
            effect.kind === 'complete-task' ? 1 : 0,
            JSON.stringify(effect.appliedResult),
            decision.evaluation.id,
          );
        }

        results.push(decision.result);
      }

      const summary = input.summarize(results);
      const digest = input.digest(summary);
      if (digest) {
        this.db.prepare(`
          INSERT INTO notifications (
            id, source_id, connector_type, connector_instance_id, title, body,
            level, level_rank, category, template_key, state, is_actionable,
            received_at, sort_at, group_key, dedupe_key, navigation_target,
            metadata, presentation
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
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
          digest.isActionable ? 1 : 0,
          digest.receivedAt,
          digest.sortAt,
          digest.groupKey,
          digest.dedupeKey,
          digest.navigationTarget,
          JSON.stringify(digest.metadata),
          JSON.stringify(digest.presentation),
        );
      }

      const completion = this.db.prepare(`
        UPDATE scout_reconciliation_runs
        SET status = 'completed', summary = ?, completed_at = ?
        WHERE id = ? AND status = 'running' AND lease_token = ?
      `).run(
        JSON.stringify(summary),
        input.completedAt,
        input.runId,
        input.leaseToken,
      );
      if (completion.changes !== 1) {
        throw new ScoutPersistenceConflictError(
          'run-claim-lost',
          'Reconciliation run lost its active claim',
        );
      }
      return { results, summary };
    });
    return transaction.immediate();
  }

  async listPendingSuggestions(input: {
    readonly now: string;
    readonly limit: number;
    readonly openStatuses: readonly string[];
    readonly terminalStatuses: readonly string[];
  }): Promise<ScoutReconciliationSuggestionRow[]> {
    this.db.prepare(`
      UPDATE scout_reconciliation_suggestions
      SET status = 'superseded', updated_at = ?, acted_at = ?, acted_by = 'expiration'
      WHERE status = 'pending' AND expires_at <= ?
    `).run(input.now, input.now, input.now);

    this.db.prepare(`
      UPDATE scout_reconciliation_suggestions
      SET status = 'superseded', updated_at = ?, acted_at = ?, acted_by = 'task-terminal'
      WHERE status = 'pending' AND EXISTS (
        SELECT 1 FROM tasks
        WHERE tasks.id = scout_reconciliation_suggestions.task_id
          AND tasks.status IN (${placeholders(input.terminalStatuses.length)})
      )
    `).run(input.now, input.now, ...input.terminalStatuses);

    const rows = this.db.prepare(`
      SELECT
        s.id, s.task_id, t.title AS task_title, t.priority AS task_priority,
        t.due_date AS task_due_date, s.action, s.confidence, s.evidence,
        s.policy_reason, s.payload_hash, s.proposed_effect, s.created_at, s.expires_at
      FROM scout_reconciliation_suggestions s
      INNER JOIN tasks t ON t.id = s.task_id
      WHERE s.status = 'pending' AND t.status IN (${placeholders(input.openStatuses.length)})
      ORDER BY s.confidence DESC, s.created_at DESC
      LIMIT ?
    `).all(...input.openStatuses, input.limit) as {
      id: string;
      task_id: string;
      task_title: string;
      task_priority: string;
      task_due_date: string | null;
      action: 'suggest-complete' | 'escalate';
      confidence: number;
      evidence: unknown;
      policy_reason: string;
      payload_hash: string;
      proposed_effect: unknown;
      created_at: string;
      expires_at: string;
    }[];

    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      taskTitle: row.task_title,
      taskPriority: row.task_priority,
      taskDueDate: row.task_due_date,
      action: row.action,
      confidence: row.confidence,
      evidence: parseJsonColumn(row.evidence),
      policyReason: row.policy_reason,
      payloadHash: row.payload_hash,
      proposedEffect: parseJsonObjectColumn(row.proposed_effect) ?? {},
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    }));
  }

  async actOnSuggestion<TResult>(input: {
    readonly suggestionId: string;
    readonly decide: (
      snapshot: ScoutSuggestionActionSnapshot,
    ) => ScoutSuggestionActionDecision<TResult>;
  }): Promise<TResult> {
    const transaction = this.db.transaction((): TResult => {
      const suggestionRow = this.db.prepare(`
        SELECT id, task_id, run_id, evaluation_id, action, status, payload_hash,
               evidence_hash, expires_at
        FROM scout_reconciliation_suggestions WHERE id = ? LIMIT 1
      `).get(input.suggestionId) as {
        id: string;
        task_id: string;
        run_id: string;
        evaluation_id: string;
        action: 'suggest-complete' | 'escalate';
        status: 'pending' | 'accepted' | 'dismissed' | 'superseded';
        payload_hash: string;
        evidence_hash: string;
        expires_at: string;
      } | undefined;

      const suggestion: ScoutSuggestionRecord | null = suggestionRow
        ? {
            id: suggestionRow.id,
            taskId: suggestionRow.task_id,
            runId: suggestionRow.run_id,
            evaluationId: suggestionRow.evaluation_id,
            action: suggestionRow.action,
            status: suggestionRow.status,
            payloadHash: suggestionRow.payload_hash,
            evidenceHash: suggestionRow.evidence_hash,
            expiresAt: suggestionRow.expires_at,
          }
        : null;

      const taskRow = suggestion
        ? this.db.prepare(`
            SELECT ${RECONCILIATION_TASK_COLUMNS} FROM tasks WHERE id = ? LIMIT 1
          `).get(suggestion.taskId) as ReconciliationTaskRow | undefined
        : undefined;
      const task = taskRow ? mapReconciliationTask(taskRow) : null;
      const connector = task
        ? this.readConnector('scout', task.connectorInstanceId)
        : null;

      const decision = input.decide({ suggestion, task, connector });
      if (decision.kind === 'replay') return decision.result;

      const claimed = this.db.prepare(`
        UPDATE scout_reconciliation_suggestions
        SET status = ?, updated_at = ?, acted_at = ?, acted_by = ?
        WHERE id = ? AND status = 'pending' AND payload_hash = ?
      `).run(
        decision.suggestionUpdate.status,
        decision.suggestionUpdate.updatedAt,
        decision.suggestionUpdate.actedAt,
        decision.suggestionUpdate.actedBy,
        input.suggestionId,
        decision.expectedPayloadHash,
      );
      if (claimed.changes !== 1) {
        throw new ScoutPersistenceConflictError(
          'suggestion-acted-concurrently',
          'Suggestion was acted on concurrently',
        );
      }

      if (decision.kind === 'accept') {
        const entries = Object.entries(decision.completion.columns);
        const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
        const completed = this.db.prepare(`
          UPDATE tasks SET ${assignments}
          WHERE id = ? AND status IN (${
            placeholders(decision.completion.expectedStatuses.length)
          })
        `).run(
          ...entries.map(([, value]) => value),
          decision.taskId,
          ...decision.completion.expectedStatuses,
        );
        if (completed.changes !== 1) {
          throw new ScoutPersistenceConflictError(
            'task-changed-before-confirmation',
            'Task changed before confirmation could be applied',
          );
        }
        this.db.prepare(`
          UPDATE scout_reconciliation_evaluations
          SET applied = 1, applied_result = ?
          WHERE id = ?
        `).run(JSON.stringify(decision.appliedResult), decision.evaluationId);
        return decision.result;
      }

      if (decision.taskState) {
        const state = decision.taskState;
        this.db.prepare(`
          INSERT INTO scout_reconciliation_task_state (
            task_id, never_auto_complete, reason, source_run_id, updated_at, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (task_id) DO UPDATE SET
            never_auto_complete = excluded.never_auto_complete,
            reason = excluded.reason,
            source_run_id = excluded.source_run_id,
            updated_at = excluded.updated_at,
            updated_by = excluded.updated_by
        `).run(
          state.taskId,
          state.neverAutoComplete ? 1 : 0,
          state.reason,
          state.sourceRunId,
          state.updatedAt,
          state.updatedBy,
        );
      }
      return decision.result;
    });
    return transaction.immediate();
  }

  async hasAppliedAutoCompletion(taskId: string): Promise<boolean> {
    const row = this.db.prepare(`
      SELECT id FROM scout_reconciliation_evaluations
      WHERE task_id = ? AND action = 'auto-complete' AND applied = 1
      LIMIT 1
    `).get(taskId) as { id: string } | undefined;
    return Boolean(row);
  }
}

export function createSqliteScoutIngestionReconciliationRepository(
  db: SqliteDatabase,
): ScoutIngestionReconciliationPersistence {
  return {
    ingestion: new SqliteScoutIngestionRepository(db),
    comparison: new SqliteScoutComparisonRepository(db),
    reconciliation: new SqliteScoutReconciliationRepository(db),
  };
}
