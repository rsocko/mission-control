import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  ProjectHierarchyServiceError,
  resolveCommittedProjectHierarchyCommand,
  type ApplyProjectHierarchyCommandInput,
  type CommittedProjectHierarchyCommand,
  type ProjectHierarchyPersistence,
} from './project-hierarchy';
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

const QUERY_BATCH_SIZE = 500;

const PHASE_ITEM_METADATA_COLUMNS = {
  estimatedEffortHours: 'estimated_effort_hours',
  isProposed: 'is_proposed',
  proposalType: 'proposal_type',
} as const;

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
  isProposed: number;
  proposalType: string | null;
  createdAt: string;
}

interface CommandRow {
  projectId: string;
  request: string;
  result: string;
}

const PHASE_COLUMNS = `
  id, project_id AS projectId, name, description, status, color,
  estimated_days AS estimatedDays, target_start AS targetStart,
  target_end AS targetEnd, start_after_phase_id AS startAfterPhaseId,
  sort_order AS sortOrder, completed_at AS completedAt,
  created_at AS createdAt, updated_at AS updatedAt
`;

const PHASE_ITEM_COLUMNS = `
  id, phase_id AS phaseId, task_id AS taskId, sort_order AS sortOrder,
  estimated_effort_hours AS estimatedEffortHours, is_proposed AS isProposed,
  proposal_type AS proposalType, created_at AS createdAt
`;

const QUALIFIED_PHASE_ITEM_COLUMNS = `
  item.id AS id, item.phase_id AS phaseId, item.task_id AS taskId,
  item.sort_order AS sortOrder, item.estimated_effort_hours AS estimatedEffortHours,
  item.is_proposed AS isProposed, item.proposal_type AS proposalType,
  item.created_at AS createdAt
`;

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_BATCH_SIZE) {
    result.push(values.slice(index, index + QUERY_BATCH_SIZE));
  }
  return result;
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
  return { ...row, isProposed: row.isProposed !== 0 };
}

function loadSnapshot(
  sqlite: Database.Database,
  projectId: string,
): ProjectHierarchySnapshot | null {
  const project = sqlite.prepare(`
    SELECT id, hierarchy_revision AS hierarchyRevision
    FROM hub_projects
    WHERE id = ?
  `).get(projectId) as ProjectRow | undefined;
  if (!project) return null;

  const phases = (sqlite.prepare(`
    SELECT ${PHASE_COLUMNS}
    FROM project_phases
    WHERE project_id = ?
    ORDER BY sort_order ASC, created_at ASC, id ASC
  `).all(projectId) as PhaseRow[]).map(phaseFromRow);
  const items = (sqlite.prepare(`
    SELECT ${QUALIFIED_PHASE_ITEM_COLUMNS}
    FROM project_phase_items item
    INNER JOIN project_phases phase ON phase.id = item.phase_id
    WHERE phase.project_id = ?
    ORDER BY item.phase_id ASC, item.sort_order ASC, item.created_at ASC, item.id ASC
  `).all(projectId) as PhaseItemRow[]).map(phaseItemFromRow);

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

function loadTaskStates(
  sqlite: Database.Database,
  projectId: string,
  taskIds: readonly string[],
): ProjectHierarchyTaskState[] {
  const unique = [...new Set(taskIds)];
  if (unique.length === 0) return [];

  const existing = new Set<string>();
  const members = new Set<string>();
  const exclusions = new Map<string, string>();
  for (const batch of batches(unique)) {
    const placeholders = batch.map(() => '?').join(', ');
    for (const row of sqlite.prepare(`
      SELECT id FROM tasks WHERE id IN (${placeholders})
    `).all(...batch) as Array<{ id: string }>) {
      existing.add(row.id);
    }
    for (const row of sqlite.prepare(`
      SELECT task_id AS taskId FROM task_projects
      WHERE project_id = ? AND task_id IN (${placeholders})
    `).all(projectId, ...batch) as Array<{ taskId: string }>) {
      members.add(row.taskId);
    }
    for (const row of sqlite.prepare(`
      SELECT task_id AS taskId, excluded_at AS excludedAt
      FROM project_auto_include_exclusions
      WHERE project_id = ? AND task_id IN (${placeholders})
    `).all(projectId, ...batch) as Array<{ taskId: string; excludedAt: string }>) {
      exclusions.set(row.taskId, row.excludedAt);
    }
  }

  if (unique.some((taskId) => !existing.has(taskId))) {
    throw new ProjectHierarchyServiceError('Task not found', 404, 'TASK_NOT_FOUND');
  }

  return unique.map((taskId) => ({
    taskId,
    member: members.has(taskId),
    excludedAt: exclusions.get(taskId) ?? null,
  }));
}

function applyMutations(
  sqlite: Database.Database,
  projectId: string,
  mutations: readonly ProjectHierarchyMutation[],
): void {
  for (const mutation of mutations) {
    switch (mutation.kind) {
      case 'add_task_membership':
        sqlite.prepare(`
          INSERT OR IGNORE INTO task_projects (task_id, project_id) VALUES (?, ?)
        `).run(mutation.taskId, projectId);
        break;
      case 'remove_task_membership':
        sqlite.prepare(`
          DELETE FROM task_projects WHERE task_id = ? AND project_id = ?
        `).run(mutation.taskId, projectId);
        break;
      case 'upsert_task_exclusion':
        sqlite.prepare(`
          INSERT INTO project_auto_include_exclusions (project_id, task_id, excluded_at)
          VALUES (?, ?, ?)
          ON CONFLICT (project_id, task_id)
          DO UPDATE SET excluded_at = excluded.excluded_at
        `).run(projectId, mutation.taskId, mutation.excludedAt);
        break;
      case 'delete_task_exclusion':
        sqlite.prepare(`
          DELETE FROM project_auto_include_exclusions
          WHERE project_id = ? AND task_id = ?
        `).run(projectId, mutation.taskId);
        break;
      case 'delete_phase_item':
        sqlite.prepare('DELETE FROM project_phase_items WHERE id = ?')
          .run(mutation.itemId);
        break;
      case 'insert_phase_item':
        sqlite.prepare(`
          INSERT INTO project_phase_items (
            id, phase_id, task_id, sort_order, estimated_effort_hours,
            is_proposed, proposal_type, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          mutation.item.id,
          mutation.item.phaseId,
          mutation.item.taskId,
          mutation.item.sortOrder,
          mutation.item.estimatedEffortHours,
          mutation.item.isProposed ? 1 : 0,
          mutation.item.proposalType,
          mutation.item.createdAt,
        );
        break;
      case 'move_phase_item':
        sqlite.prepare(`
          UPDATE project_phase_items SET phase_id = ?, sort_order = ? WHERE id = ?
        `).run(mutation.phaseId, mutation.sortOrder, mutation.itemId);
        break;
      case 'update_phase_item_metadata': {
        const fields = Object.keys(mutation.updates)
          .filter((field): field is keyof typeof PHASE_ITEM_METADATA_COLUMNS => (
            field in PHASE_ITEM_METADATA_COLUMNS
          ));
        if (fields.length === 0) break;
        const assignments = fields
          .map((field) => `${PHASE_ITEM_METADATA_COLUMNS[field]} = ?`)
          .join(', ');
        const values = fields.map((field) => {
          const value = mutation.updates[field];
          return typeof value === 'boolean' ? (value ? 1 : 0) : value ?? null;
        });
        sqlite.prepare(`
          UPDATE project_phase_items SET ${assignments} WHERE id = ?
        `).run(...values, mutation.itemId);
        break;
      }
      case 'set_phase_sort_order':
        sqlite.prepare(`
          UPDATE project_phases SET sort_order = ?, updated_at = ? WHERE id = ?
        `).run(mutation.sortOrder, mutation.updatedAt, mutation.phaseId);
        break;
    }
  }
}

function findCommand(
  sqlite: Database.Database,
  commandId: string,
): CommittedProjectHierarchyCommand | null {
  const row = sqlite.prepare(`
    SELECT project_id AS projectId, request_json AS request, result_json AS result
    FROM project_hierarchy_commands
    WHERE id = ?
  `).get(commandId) as CommandRow | undefined;
  if (!row) return null;
  return {
    projectId: row.projectId,
    request: JSON.parse(row.request) as ProjectHierarchyCommandRequest,
    result: JSON.parse(row.result) as ProjectHierarchyCommandResult,
  };
}

function insertCommand(
  sqlite: Database.Database,
  input: ApplyProjectHierarchyCommandInput,
  values: {
    baseRevision: number;
    resultRevision: number;
    inverseCommand: unknown;
    result: ProjectHierarchyCommandResult;
    createdAt: string;
  },
): void {
  sqlite.prepare(`
    INSERT INTO project_hierarchy_commands (
      id, project_id, base_revision, result_revision, command_type,
      request_json, inverse_command_json, result_json,
      actor_type, actor_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
  );
}

function requireSnapshot(
  sqlite: Database.Database,
  projectId: string,
): ProjectHierarchySnapshot {
  const snapshot = loadSnapshot(sqlite, projectId);
  if (!snapshot) {
    throw new ProjectHierarchyServiceError('Project not found', 404, 'PROJECT_NOT_FOUND');
  }
  return snapshot;
}

function applyCommandInTransaction(
  sqlite: Database.Database,
  input: ApplyProjectHierarchyCommandInput,
): ProjectHierarchyCommandResult {
  const existing = findCommand(sqlite, input.request.commandId);
  if (existing) return resolveCommittedProjectHierarchyCommand(existing, input);

  const before = requireSnapshot(sqlite, input.projectId);
  if (before.revision !== input.request.expectedRevision) {
    throw new ProjectHierarchyServiceError(
      'Project hierarchy changed; reload the latest plan and try again',
      409,
      'HIERARCHY_REVISION_CONFLICT',
      before,
    );
  }

  const taskStates = loadTaskStates(
    sqlite,
    input.projectId,
    projectHierarchyCommandTaskIds(input.request.command),
  );
  const now = new Date().toISOString();

  // The mutation-context row suppresses the SQLite hierarchy revision triggers
  // so an adapter-owned command advances the revision exactly once.
  sqlite.prepare(`
    INSERT INTO project_hierarchy_mutation_context (project_id) VALUES (?)
  `).run(input.projectId);

  const plan = planProjectHierarchyCommand({
    snapshot: before,
    taskStates,
    command: input.request.command,
    now,
    newItemId: randomUUID,
  });
  applyMutations(sqlite, input.projectId, plan.mutations);

  const clearMutationContext = () => {
    sqlite.prepare(`
      DELETE FROM project_hierarchy_mutation_context WHERE project_id = ?
    `).run(input.projectId);
  };

  if (!plan.changed) {
    clearMutationContext();
    const result: ProjectHierarchyCommandResult = {
      commandId: input.request.commandId,
      revision: before.revision,
      hierarchy: before,
      inverseCommand: plan.inverseCommand,
    };
    insertCommand(sqlite, input, {
      baseRevision: before.revision,
      resultRevision: before.revision,
      inverseCommand: plan.inverseCommand,
      result,
      createdAt: now,
    });
    return result;
  }

  const nextRevision = before.revision + 1;
  const revisionUpdate = sqlite.prepare(`
    UPDATE hub_projects SET hierarchy_revision = ?, updated_at = ?
    WHERE id = ? AND hierarchy_revision = ?
  `).run(nextRevision, now, input.projectId, before.revision);
  if (revisionUpdate.changes !== 1) {
    throw new ProjectHierarchyServiceError(
      'Project hierarchy changed; reload the latest plan and try again',
      409,
      'HIERARCHY_REVISION_CONFLICT',
      requireSnapshot(sqlite, input.projectId),
    );
  }
  clearMutationContext();

  const result: ProjectHierarchyCommandResult = {
    commandId: input.request.commandId,
    revision: nextRevision,
    hierarchy: requireSnapshot(sqlite, input.projectId),
    inverseCommand: plan.inverseCommand,
  };
  insertCommand(sqlite, input, {
    baseRevision: before.revision,
    resultRevision: nextRevision,
    inverseCommand: plan.inverseCommand,
    result,
    createdAt: now,
  });
  return result;
}

export function createSqliteProjectHierarchyRepository(
  sqlite: Database.Database,
): ProjectHierarchyPersistence {
  return {
    getSnapshot(projectId) {
      return Promise.resolve(
        sqlite.transaction(() => loadSnapshot(sqlite, projectId)).deferred(),
      );
    },
    findCommittedCommand(commandId) {
      return Promise.resolve(findCommand(sqlite, commandId));
    },
    applyAuthorizedCommand(input) {
      return Promise.resolve(
        sqlite.transaction(() => applyCommandInTransaction(sqlite, input)).immediate(),
      );
    },
    findPhaseProjectId(phaseId) {
      const row = sqlite.prepare(`
        SELECT project_id AS projectId FROM project_phases WHERE id = ?
      `).get(phaseId) as { projectId: string | null } | undefined;
      return Promise.resolve(row?.projectId ?? null);
    },
    listPhaseItems(phaseId) {
      return Promise.resolve((sqlite.prepare(`
        SELECT ${PHASE_ITEM_COLUMNS}
        FROM project_phase_items
        WHERE phase_id = ?
        ORDER BY sort_order ASC, created_at ASC, id ASC
      `).all(phaseId) as PhaseItemRow[]).map(phaseItemFromRow));
    },
    findPhaseItemTask(phaseId, itemId) {
      const row = sqlite.prepare(`
        SELECT task_id AS taskId FROM project_phase_items
        WHERE id = ? AND phase_id = ?
      `).get(itemId, phaseId) as { taskId: string } | undefined;
      return Promise.resolve(row?.taskId ?? null);
    },
  };
}
