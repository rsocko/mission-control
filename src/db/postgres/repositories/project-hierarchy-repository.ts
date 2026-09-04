import { randomUUID } from 'crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  ProjectHierarchyServiceError,
  resolveCommittedProjectHierarchyCommand,
  type ApplyProjectHierarchyCommandInput,
  type CommittedProjectHierarchyCommand,
  type ProjectHierarchyPersistence,
} from '@/db/persistence/project-hierarchy';
import {
  planProjectHierarchyCommand,
  projectHierarchyCommandTaskIds,
  type ProjectHierarchyMutation,
  type ProjectHierarchyTaskState,
} from '@/lib/projects/hierarchy-transitions';
import type {
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from '@/lib/projects/hierarchy-types';
import type { ProjectPhase, ProjectPhaseItem, ProjectPhaseStatus } from '@/types';

const MAX_TRANSACTION_ATTEMPTS = 3;
const COMMAND_TABLE = 'project_hierarchy_commands';

const PHASE_ITEM_METADATA_COLUMNS = {
  estimatedEffortHours: 'estimated_effort_hours',
  isProposed: 'is_proposed',
  proposalType: 'proposal_type',
} as const;

/**
 * `COLLATE "C"` pins byte-order text tie-breakers so snapshot order, dense
 * index calculation, and inverse commands cannot drift with the database or
 * session locale.
 */
const PHASE_COLUMNS = `
  id, project_id AS "projectId", name, description, status, color,
  estimated_days AS "estimatedDays", target_start AS "targetStart",
  target_end AS "targetEnd", start_after_phase_id AS "startAfterPhaseId",
  sort_order AS "sortOrder", completed_at AS "completedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;
const PHASE_ORDER = `
  ORDER BY sort_order ASC, created_at COLLATE "C" ASC, id COLLATE "C" ASC
`;
const PHASE_ITEM_COLUMNS = `
  id, phase_id AS "phaseId", task_id AS "taskId", sort_order AS "sortOrder",
  estimated_effort_hours AS "estimatedEffortHours", is_proposed AS "isProposed",
  proposal_type AS "proposalType", created_at AS "createdAt"
`;
const QUALIFIED_PHASE_ITEM_COLUMNS = `
  item.id AS id, item.phase_id AS "phaseId", item.task_id AS "taskId",
  item.sort_order AS "sortOrder",
  item.estimated_effort_hours AS "estimatedEffortHours",
  item.is_proposed AS "isProposed", item.proposal_type AS "proposalType",
  item.created_at AS "createdAt"
`;

interface ProjectRow {
  id: string;
  hierarchyRevision: number;
}

interface PhaseRow {
  id: string;
  projectId: string | null;
  name: string;
  description: string | null;
  status: string;
  color: string | null;
  estimatedDays: number | null;
  targetStart: string | null;
  targetEnd: string | null;
  startAfterPhaseId: string | null;
  sortOrder: number;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PhaseItemRow {
  id: string;
  phaseId: string;
  taskId: string;
  sortOrder: number;
  estimatedEffortHours: number | null;
  isProposed: boolean;
  proposalType: string | null;
  createdAt: string;
}

interface CommandRow {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  result: ProjectHierarchyCommandResult;
}

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code: unknown }).code)
    : '';
}

function retryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === '40001' || code === '40P01';
}

/**
 * Only a duplicate command-ID insert is eligible for the fresh-replay recovery
 * path; any other unique violation must surface unchanged.
 */
function duplicateCommandId(error: unknown): boolean {
  if (errorCode(error) !== '23505') return false;
  if (!error || typeof error !== 'object') return false;
  const details = error as { table?: unknown; constraint?: unknown };
  return String(details.table ?? '') === COMMAND_TABLE
    || String(details.constraint ?? '').includes(COMMAND_TABLE);
}

/**
 * Project automation and project hierarchy mutate the same `task_projects` and
 * `project_auto_include_exclusions` rows, so both acquire the identical
 * session-level `pg_advisory_lock(hashtext(projectId))` namespace, in the same
 * order, before opening their SERIALIZABLE transaction.
 */
async function withProjectTransaction<T>(
  pool: Pool,
  projectId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    let lockAcquired = false;
    let operationError: unknown;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [projectId]);
      lockAcquired = true;
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        operationError = error;
        await client.query('ROLLBACK');
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    } finally {
      let unlockError: unknown;
      if (lockAcquired) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [projectId]);
        } catch (error) {
          unlockError = error;
        }
      }
      client.release(unlockError instanceof Error ? unlockError : unlockError ? true : undefined);
      if (unlockError && operationError === undefined) throw unlockError;
    }
  }
  throw new Error('Project hierarchy transaction exhausted retries');
}

async function withReadTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

function parsePhaseStatus(status: string): ProjectPhaseStatus {
  if (status === 'pending' || status === 'in_progress' || status === 'completed') {
    return status;
  }
  throw new Error(`Invalid project phase status: ${status}`);
}

function phaseFromRow(row: PhaseRow): ProjectPhase {
  return { ...row, status: parsePhaseStatus(row.status) };
}

function phaseItemFromRow(row: PhaseItemRow): ProjectPhaseItem {
  return { ...row, isProposed: row.isProposed === true };
}

async function loadSnapshot(
  client: Pool | PoolClient,
  projectId: string,
  lock: boolean,
): Promise<ProjectHierarchySnapshot | null> {
  const [project] = await query<ProjectRow>(client, `
    SELECT id, hierarchy_revision AS "hierarchyRevision"
    FROM hub_projects
    WHERE id = $1
    ${lock ? 'FOR UPDATE' : ''}
  `, [projectId]);
  if (!project) return null;

  const phases = (await query<PhaseRow>(client, `
    SELECT ${PHASE_COLUMNS}
    FROM project_phases
    WHERE project_id = $1
    ${PHASE_ORDER}
    ${lock ? 'FOR UPDATE' : ''}
  `, [projectId])).map(phaseFromRow);
  const items = (await query<PhaseItemRow>(client, `
    SELECT ${QUALIFIED_PHASE_ITEM_COLUMNS}
    FROM project_phase_items item
    INNER JOIN project_phases phase ON phase.id = item.phase_id
    WHERE phase.project_id = $1
    ORDER BY item.phase_id COLLATE "C" ASC, item.sort_order ASC,
             item.created_at COLLATE "C" ASC, item.id COLLATE "C" ASC
    ${lock ? 'FOR UPDATE OF item' : ''}
  `, [projectId])).map(phaseItemFromRow);

  return {
    projectId,
    revision: project.hierarchyRevision,
    phases,
    phaseItemsByPhase: Object.fromEntries(phases.map((phase) => [
      phase.id,
      items.filter((item) => item.phaseId === phase.id),
    ])),
  };
}

async function requireSnapshot(
  client: PoolClient,
  projectId: string,
  lock: boolean,
): Promise<ProjectHierarchySnapshot> {
  const snapshot = await loadSnapshot(client, projectId, lock);
  if (!snapshot) {
    throw new ProjectHierarchyServiceError('Project not found', 404, 'PROJECT_NOT_FOUND');
  }
  return snapshot;
}

async function loadTaskStates(
  client: PoolClient,
  projectId: string,
  taskIds: readonly string[],
): Promise<ProjectHierarchyTaskState[]> {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return [];

  const existing = new Set((await query<{ id: string }>(client, `
    SELECT id FROM tasks WHERE id = ANY($1::text[]) FOR UPDATE
  `, [unique])).map((row) => row.id));
  if (unique.some((taskId) => !existing.has(taskId))) {
    throw new ProjectHierarchyServiceError('Task not found', 404, 'TASK_NOT_FOUND');
  }

  const members = new Set((await query<{ taskId: string }>(client, `
    SELECT task_id AS "taskId" FROM task_projects
    WHERE project_id = $1 AND task_id = ANY($2::text[])
    FOR UPDATE
  `, [projectId, unique])).map((row) => row.taskId));
  const exclusions = new Map((await query<{ taskId: string; excludedAt: string }>(client, `
    SELECT task_id AS "taskId", excluded_at AS "excludedAt"
    FROM project_auto_include_exclusions
    WHERE project_id = $1 AND task_id = ANY($2::text[])
    FOR UPDATE
  `, [projectId, unique])).map((row) => [row.taskId, row.excludedAt]));

  return unique.map((taskId) => ({
    taskId,
    member: members.has(taskId),
    excludedAt: exclusions.get(taskId) ?? null,
  }));
}

async function applyMutations(
  client: PoolClient,
  projectId: string,
  mutations: readonly ProjectHierarchyMutation[],
): Promise<void> {
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'add_task_membership':
        await client.query(`
          INSERT INTO task_projects (task_id, project_id) VALUES ($1, $2)
          ON CONFLICT DO NOTHING
        `, [mutation.taskId, projectId]);
        break;
      case 'remove_task_membership':
        await client.query(`
          DELETE FROM task_projects WHERE task_id = $1 AND project_id = $2
        `, [mutation.taskId, projectId]);
        break;
      case 'upsert_task_exclusion':
        await client.query(`
          INSERT INTO project_auto_include_exclusions (project_id, task_id, excluded_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (project_id, task_id)
          DO UPDATE SET excluded_at = EXCLUDED.excluded_at
        `, [projectId, mutation.taskId, mutation.excludedAt]);
        break;
      case 'delete_task_exclusion':
        await client.query(`
          DELETE FROM project_auto_include_exclusions
          WHERE project_id = $1 AND task_id = $2
        `, [projectId, mutation.taskId]);
        break;
      case 'delete_phase_item':
        await client.query('DELETE FROM project_phase_items WHERE id = $1', [mutation.itemId]);
        break;
      case 'insert_phase_item':
        await client.query(`
          INSERT INTO project_phase_items (
            id, phase_id, task_id, sort_order, estimated_effort_hours,
            is_proposed, proposal_type, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        `, [
          mutation.item.id,
          mutation.item.phaseId,
          mutation.item.taskId,
          mutation.item.sortOrder,
          mutation.item.estimatedEffortHours,
          mutation.item.isProposed,
          mutation.item.proposalType,
          mutation.item.createdAt,
        ]);
        break;
      case 'move_phase_item':
        await client.query(`
          UPDATE project_phase_items SET phase_id = $1, sort_order = $2 WHERE id = $3
        `, [mutation.phaseId, mutation.sortOrder, mutation.itemId]);
        break;
      case 'update_phase_item_metadata': {
        const fields = Object.keys(mutation.updates)
          .filter((field): field is keyof typeof PHASE_ITEM_METADATA_COLUMNS => (
            field in PHASE_ITEM_METADATA_COLUMNS
          ));
        if (fields.length === 0) break;
        const assignments = fields
          .map((field, index) => `${PHASE_ITEM_METADATA_COLUMNS[field]} = $${index + 1}`)
          .join(', ');
        await client.query(
          `UPDATE project_phase_items SET ${assignments} WHERE id = $${fields.length + 1}`,
          [
            ...fields.map((field) => mutation.updates[field] ?? null),
            mutation.itemId,
          ],
        );
        break;
      }
      case 'set_phase_sort_order':
        await client.query(`
          UPDATE project_phases SET sort_order = $1, updated_at = $2 WHERE id = $3
        `, [mutation.sortOrder, mutation.updatedAt, mutation.phaseId]);
        break;
    }
  }
}

async function findCommand(
  client: Pool | PoolClient,
  commandId: string,
): Promise<CommittedProjectHierarchyCommand | null> {
  const [row] = await query<CommandRow>(client, `
    SELECT project_id AS "projectId", request_json AS request, result_json AS result
    FROM project_hierarchy_commands
    WHERE id = $1
  `, [commandId]);
  return row
    ? { projectId: row.projectId, request: row.request, result: row.result }
    : null;
}

async function insertCommand(
  client: PoolClient,
  input: ApplyProjectHierarchyCommandInput,
  values: {
    baseRevision: number;
    resultRevision: number;
    inverseCommand: unknown;
    result: ProjectHierarchyCommandResult;
    createdAt: string;
  },
): Promise<void> {
  await client.query(`
    INSERT INTO project_hierarchy_commands (
      id, project_id, base_revision, result_revision, command_type,
      request_json, inverse_command_json, result_json,
      actor_type, actor_id, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11)
  `, [
    input.request.commandId,
    input.projectId,
    values.baseRevision,
    values.resultRevision,
    input.request.command.type,
    JSON.stringify(input.request),
    JSON.stringify(values.inverseCommand),
    JSON.stringify(values.result),
    input.actor?.type ?? 'user',
    input.actor?.id ?? null,
    values.createdAt,
  ]);
}

async function applyCommandInTransaction(
  client: PoolClient,
  input: ApplyProjectHierarchyCommandInput,
): Promise<ProjectHierarchyCommandResult> {
  const existing = await findCommand(client, input.request.commandId);
  if (existing) return resolveCommittedProjectHierarchyCommand(existing, input);

  const before = await requireSnapshot(client, input.projectId, true);
  if (before.revision !== input.request.expectedRevision) {
    throw new ProjectHierarchyServiceError(
      'Project hierarchy changed; reload the latest plan and try again',
      409,
      'HIERARCHY_REVISION_CONFLICT',
      before,
    );
  }

  const taskStates = await loadTaskStates(
    client,
    input.projectId,
    projectHierarchyCommandTaskIds(input.request.command),
  );
  const now = new Date().toISOString();

  // Suppresses the out-of-band hierarchy revision triggers so an
  // adapter-owned command advances the revision exactly once.
  await client.query(`
    INSERT INTO project_hierarchy_mutation_context (project_id) VALUES ($1)
  `, [input.projectId]);

  const plan = planProjectHierarchyCommand({
    snapshot: before,
    taskStates,
    command: input.request.command,
    now,
    newItemId: randomUUID,
  });
  await applyMutations(client, input.projectId, plan.mutations);

  const clearMutationContext = () => client.query(`
    DELETE FROM project_hierarchy_mutation_context WHERE project_id = $1
  `, [input.projectId]);

  if (!plan.changed) {
    await clearMutationContext();
    const result: ProjectHierarchyCommandResult = {
      commandId: input.request.commandId,
      revision: before.revision,
      hierarchy: before,
      inverseCommand: plan.inverseCommand,
    };
    await insertCommand(client, input, {
      baseRevision: before.revision,
      resultRevision: before.revision,
      inverseCommand: plan.inverseCommand,
      result,
      createdAt: now,
    });
    return result;
  }

  const nextRevision = before.revision + 1;
  const revisionUpdate = await client.query(`
    UPDATE hub_projects SET hierarchy_revision = $1, updated_at = $2
    WHERE id = $3 AND hierarchy_revision = $4
  `, [nextRevision, now, input.projectId, before.revision]);
  if (revisionUpdate.rowCount !== 1) {
    throw new ProjectHierarchyServiceError(
      'Project hierarchy changed; reload the latest plan and try again',
      409,
      'HIERARCHY_REVISION_CONFLICT',
      await requireSnapshot(client, input.projectId, false),
    );
  }
  await clearMutationContext();

  const result: ProjectHierarchyCommandResult = {
    commandId: input.request.commandId,
    revision: nextRevision,
    hierarchy: await requireSnapshot(client, input.projectId, false),
    inverseCommand: plan.inverseCommand,
  };
  await insertCommand(client, input, {
    baseRevision: before.revision,
    resultRevision: nextRevision,
    inverseCommand: plan.inverseCommand,
    result,
    createdAt: now,
  });
  return result;
}

export function createPostgresProjectHierarchyRepository(
  pool: Pool,
): ProjectHierarchyPersistence {
  return {
    getSnapshot(projectId) {
      return withReadTransaction(pool, (client) => loadSnapshot(client, projectId, false));
    },
    findCommittedCommand(commandId) {
      return findCommand(pool, commandId);
    },
    async applyAuthorizedCommand(input) {
      try {
        return await withProjectTransaction(
          pool,
          input.projectId,
          (client) => applyCommandInTransaction(client, input),
        );
      } catch (error) {
        if (!duplicateCommandId(error)) throw error;
        // The aborted transaction is already rolled back, so the winner is
        // re-read in a fresh read and returned only for canonical exact
        // replay; any other reuse stays a 409 command conflict.
        const committed = await findCommand(pool, input.request.commandId);
        if (!committed) throw error;
        return resolveCommittedProjectHierarchyCommand(committed, input);
      }
    },
    async findPhaseProjectId(phaseId) {
      const [row] = await query<{ projectId: string | null }>(pool, `
        SELECT project_id AS "projectId" FROM project_phases WHERE id = $1
      `, [phaseId]);
      return row?.projectId ?? null;
    },
    async listPhaseItems(phaseId) {
      return (await query<PhaseItemRow>(pool, `
        SELECT ${PHASE_ITEM_COLUMNS}
        FROM project_phase_items
        WHERE phase_id = $1
        ORDER BY sort_order ASC, created_at COLLATE "C" ASC, id COLLATE "C" ASC
      `, [phaseId])).map(phaseItemFromRow);
    },
    async findPhaseItemTask(phaseId, itemId) {
      const [row] = await query<{ taskId: string }>(pool, `
        SELECT task_id AS "taskId" FROM project_phase_items
        WHERE id = $1 AND phase_id = $2
      `, [itemId, phaseId]);
      return row?.taskId ?? null;
    },
  };
}
