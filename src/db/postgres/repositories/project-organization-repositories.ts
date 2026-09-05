import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  ListOrganizationGroup,
  ListOrganizationGroupUpdate,
  ListOrganizationPersistence,
  ListOrganizationSnapshot,
  ListOrganizationSourceList,
  ProjectAdministrationPersistence,
  ProjectOrganizationProject,
  ProjectOrganizationProjectUpdate,
  ProjectPhaseUpdate,
} from '@/db/persistence/project-organization';
import type { ProjectPhase, ProjectPhaseItem } from '@/types';

const MAX_TRANSACTION_ATTEMPTS = 3;
const LIST_ORGANIZATION_LOCK = 'list-organization';
const CROSS_PROJECT_PHASE_LOCK = 'project-phase:cross-project';

interface ProjectRow extends ProjectOrganizationProject {}
interface PhaseRow extends Omit<ProjectPhase, 'status'> {
  status: string;
}
interface PhaseItemRow extends ProjectPhaseItem {}
interface SourceListRow extends ListOrganizationSourceList {}

const PROJECT_COLUMNS = `
  id, name, description, color, icon, icon_color AS "iconColor",
  source_bindings AS "sourceBindings", auto_include_rules AS "autoIncludeRules",
  kanban_columns AS "kanbanColumns", default_view AS "defaultView",
  default_filters AS "defaultFilters", status, status_override AS "statusOverride",
  hidden, category, target_date AS "targetDate", started_at AS "startedAt",
  completed_at AS "completedAt", sort_order AS "sortOrder",
  hierarchy_revision AS "hierarchyRevision", metadata,
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const PHASE_COLUMNS = `
  id, project_id AS "projectId", name, description, status, color,
  estimated_days AS "estimatedDays", target_start AS "targetStart",
  target_end AS "targetEnd", start_after_phase_id AS "startAfterPhaseId",
  sort_order AS "sortOrder", completed_at AS "completedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

const PHASE_ITEM_COLUMNS = `
  id, phase_id AS "phaseId", task_id AS "taskId", sort_order AS "sortOrder",
  estimated_effort_hours AS "estimatedEffortHours", is_proposed AS "isProposed",
  proposal_type AS "proposalType", created_at AS "createdAt"
`;

const SOURCE_LIST_COLUMNS = `
  id, connector_instance_id AS "connectorInstanceId", source_id AS "sourceId",
  name, type, task_count AS "taskCount", last_synced_at AS "lastSyncedAt",
  well_known_list_name AS "wellKnownListName", group_id AS "groupId",
  sort_order AS "sortOrder", hidden,
  last_known_remote_name AS "lastKnownRemoteName",
  user_display_name AS "userDisplayName", icon, icon_color AS "iconColor"
`;

const PROJECT_UPDATE_COLUMNS: Record<
  Exclude<keyof ProjectOrganizationProjectUpdate, 'updatedAt'>,
  string
> = {
  name: 'name',
  description: 'description',
  color: 'color',
  icon: 'icon',
  iconColor: 'icon_color',
  sourceBindings: 'source_bindings',
  autoIncludeRules: 'auto_include_rules',
  kanbanColumns: 'kanban_columns',
  defaultView: 'default_view',
  defaultFilters: 'default_filters',
  statusOverride: 'status_override',
  hidden: 'hidden',
  category: 'category',
  targetDate: 'target_date',
  sortOrder: 'sort_order',
  metadata: 'metadata',
};

const PHASE_UPDATE_COLUMNS: Record<
  Exclude<keyof ProjectPhaseUpdate, 'updatedAt'>,
  string
> = {
  name: 'name',
  description: 'description',
  status: 'status',
  color: 'color',
  estimatedDays: 'estimated_days',
  targetStart: 'target_start',
  targetEnd: 'target_end',
  sortOrder: 'sort_order',
  completedAt: 'completed_at',
  projectId: 'project_id',
  startAfterPhaseId: 'start_after_phase_id',
};

const GROUP_UPDATE_COLUMNS: Record<keyof ListOrganizationGroupUpdate, string> = {
  name: 'name',
  icon: 'icon',
  iconColor: 'icon_color',
  sortOrder: 'sort_order',
};

const JSON_FIELDS = new Set([
  'sourceBindings',
  'autoIncludeRules',
  'kanbanColumns',
  'defaultFilters',
  'metadata',
]);

async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : '';
}

function retryable(error: unknown): boolean {
  const code = errorCode(error);
  return code === '40001' || code === '40P01';
}

async function withReadTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function withMutationTransaction<T>(
  pool: Pool,
  lockKeys: readonly string[],
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const keys = [...new Set(lockKeys)].sort();
  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt++) {
    const client = await pool.connect();
    const acquired: string[] = [];
    let operationError: unknown;
    try {
      for (const key of keys) {
        await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
        acquired.push(key);
      }
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      try {
        const value = await work(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        operationError = error;
        await client.query('ROLLBACK');
        if (!retryable(error) || attempt === MAX_TRANSACTION_ATTEMPTS) throw error;
      }
    } finally {
      let unlockError: unknown;
      for (const key of acquired.reverse()) {
        try {
          await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]);
        } catch (error) {
          unlockError ??= error;
        }
      }
      client.release(unlockError instanceof Error ? unlockError : unlockError ? true : undefined);
      if (unlockError && operationError === undefined) throw unlockError;
    }
  }
  throw new Error('Project organization transaction exhausted retries');
}

async function withPhaseMutationTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withMutationTransaction(pool, [CROSS_PROJECT_PHASE_LOCK], work);
}

async function lockProjectNamespaces(
  client: PoolClient,
  projectIds: readonly (string | null | undefined)[],
): Promise<void> {
  const keys = [...new Set(projectIds.flatMap((projectId) => projectId ? [projectId] : []))]
    .sort();
  for (const key of keys) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
  }
}

function phaseFromRow(row: PhaseRow): ProjectPhase {
  return { ...row, status: row.status as ProjectPhase['status'] };
}

function projectFromRow(row: ProjectRow): ProjectOrganizationProject {
  return {
    ...row,
    sourceBindings: Array.isArray(row.sourceBindings) ? row.sourceBindings : [],
    autoIncludeRules: Array.isArray(row.autoIncludeRules) ? row.autoIncludeRules : [],
    kanbanColumns: Array.isArray(row.kanbanColumns) ? row.kanbanColumns : [],
    defaultFilters: row.defaultFilters ?? null,
    metadata: row.metadata ?? {},
  };
}

async function loadProject(
  client: Pool | PoolClient,
  projectId: string,
): Promise<ProjectOrganizationProject | null> {
  const [row] = await query<ProjectRow>(client, `
    SELECT ${PROJECT_COLUMNS} FROM hub_projects WHERE id = $1
  `, [projectId]);
  return row ? projectFromRow(row) : null;
}

async function loadPhase(
  client: Pool | PoolClient,
  phaseId: string,
): Promise<ProjectPhase | null> {
  const [row] = await query<PhaseRow>(client, `
    SELECT ${PHASE_COLUMNS} FROM project_phases WHERE id = $1
  `, [phaseId]);
  return row ? phaseFromRow(row) : null;
}

async function updateRow(
  client: PoolClient,
  table: string,
  id: string,
  updates: Record<string, unknown>,
  columns: Record<string, string>,
): Promise<void> {
  const fields = Object.keys(updates).filter((key) => key in columns);
  if (fields.length === 0) return;
  const assignments = fields.map((field, index) => (
    `${columns[field]} = $${index + 1}${JSON_FIELDS.has(field) && updates[field] !== null ? '::jsonb' : ''}`
  )).join(', ');
  const values = fields.map((field) => (
    JSON_FIELDS.has(field) && updates[field] !== null
      ? JSON.stringify(updates[field])
      : updates[field]
  ));
  await client.query(
    `UPDATE ${table} SET ${assignments} WHERE id = $${fields.length + 1}`,
    [...values, id],
  );
}

export function createPostgresProjectAdministrationRepository(
  pool: Pool,
): ProjectAdministrationPersistence {
  return {
    async listProjects({ includeHidden, includePhases }) {
      return withReadTransaction(pool, async (client) => {
        const rows = await query<ProjectRow>(client, `
          SELECT ${PROJECT_COLUMNS}
          FROM hub_projects
          ${includeHidden ? '' : 'WHERE hidden = FALSE'}
          ORDER BY name COLLATE "C" ASC, id COLLATE "C" ASC
        `);
        const projects = rows.map(projectFromRow);
        if (!includePhases) return projects;
        const phases = await query<{ id: string; projectId: string | null; name: string }>(
          client,
          `
            SELECT id, project_id AS "projectId", name
            FROM project_phases
            ORDER BY sort_order ASC, created_at COLLATE "C" ASC, id COLLATE "C" ASC
          `,
        );
        return projects.map((project) => ({
          ...project,
          phases: phases
            .filter((phase) => phase.projectId === project.id)
            .map(({ id, name }) => ({ id, name })),
        }));
      });
    },
    async getProject(projectId) {
      return loadProject(pool, projectId);
    },
    async projectExists(projectId) {
      const rows = await query(pool, 'SELECT 1 FROM hub_projects WHERE id = $1', [projectId]);
      return rows.length > 0;
    },
    async createProject(project) {
      await withMutationTransaction(pool, [project.id], async (client) => {
        await client.query(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, icon_color, source_bindings,
            auto_include_rules, kanban_columns, default_view, default_filters,
            status, status_override, hidden, category, target_date, started_at,
            completed_at, sort_order, hierarchy_revision, metadata, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10,
            $11::jsonb, $12, $13, $14, $15, $16, $17, $18, $19, $20,
            $21::jsonb, $22, $23
          )
        `, [
          project.id,
          project.name,
          project.description,
          project.color,
          project.icon,
          project.iconColor,
          JSON.stringify(project.sourceBindings),
          JSON.stringify(project.autoIncludeRules),
          JSON.stringify(project.kanbanColumns),
          project.defaultView,
          project.defaultFilters === null ? null : JSON.stringify(project.defaultFilters),
          project.status,
          project.statusOverride,
          project.hidden,
          project.category,
          project.targetDate,
          project.startedAt,
          project.completedAt,
          project.sortOrder,
          project.hierarchyRevision,
          JSON.stringify(project.metadata),
          project.createdAt,
          project.updatedAt,
        ]);
      });
    },
    async updateProject(projectId, updates) {
      return withMutationTransaction(pool, [projectId], async (client) => {
        await updateRow(client, 'hub_projects', projectId, updates, {
          ...PROJECT_UPDATE_COLUMNS,
          updatedAt: 'updated_at',
        });
        const affected = await query<{ taskId: string }>(client, `
          SELECT task_id AS "taskId"
          FROM task_projects
          WHERE project_id = $1
          ORDER BY task_id COLLATE "C" ASC
        `, [projectId]);
        return { affectedTaskIds: affected.map(({ taskId }) => taskId) };
      });
    },
    async deleteProject(projectId, cascade) {
      return withMutationTransaction(pool, [projectId], async (client) => {
        const affected = await query<{ taskId: string }>(client, `
          SELECT task_id AS "taskId"
          FROM task_projects
          WHERE project_id = $1
          ORDER BY task_id COLLATE "C" ASC
          FOR UPDATE
        `, [projectId]);
        if (cascade === 'owned-hierarchy') {
          await client.query(`
            DELETE FROM project_phase_items
            WHERE phase_id IN (SELECT id FROM project_phases WHERE project_id = $1)
          `, [projectId]);
          await client.query('DELETE FROM project_phases WHERE project_id = $1', [projectId]);
          await client.query('DELETE FROM project_tags WHERE project_id = $1', [projectId]);
          await client.query('DELETE FROM project_milestones WHERE project_id = $1', [projectId]);
          await client.query('DELETE FROM project_hierarchy_commands WHERE project_id = $1', [projectId]);
          await client.query(
            'DELETE FROM project_hierarchy_mutation_context WHERE project_id = $1',
            [projectId],
          );
        }
        await client.query(
          'DELETE FROM project_auto_include_exclusions WHERE project_id = $1',
          [projectId],
        );
        await client.query('DELETE FROM task_projects WHERE project_id = $1', [projectId]);
        await client.query('DELETE FROM hub_projects WHERE id = $1', [projectId]);
        return { affectedTaskIds: affected.map(({ taskId }) => taskId) };
      });
    },
    async listPhases({ projectId, crossProject }) {
      return withReadTransaction(pool, async (client) => {
        const where = crossProject
          ? 'WHERE project_id IS NULL'
          : projectId
            ? 'WHERE project_id = $1'
            : '';
        const rows = await query<PhaseRow>(client, `
          SELECT ${PHASE_COLUMNS}
          FROM project_phases
          ${where}
          ORDER BY sort_order ASC, created_at COLLATE "C" ASC, id COLLATE "C" ASC
        `, projectId && !crossProject ? [projectId] : []);
        return rows.map(phaseFromRow);
      });
    },
    async createPhase(phase) {
      return withPhaseMutationTransaction(pool, async (client) => {
        const dependency = phase.startAfterPhaseId
          ? await loadPhase(client, phase.startAfterPhaseId)
          : null;
        await lockProjectNamespaces(client, [phase.projectId, dependency?.projectId]);
        await client.query(`
          INSERT INTO project_phases (
            id, project_id, name, description, status, color, estimated_days,
            target_start, target_end, start_after_phase_id, sort_order,
            completed_at, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
          )
        `, [
          phase.id,
          phase.projectId,
          phase.name,
          phase.description,
          phase.status,
          phase.color,
          phase.estimatedDays,
          phase.targetStart,
          phase.targetEnd,
          phase.startAfterPhaseId,
          phase.sortOrder,
          phase.completedAt,
          phase.createdAt,
          phase.updatedAt,
        ]);
        return (await loadPhase(client, phase.id))!;
      });
    },
    async getPhase(phaseId) {
      return withReadTransaction(pool, async (client) => {
        const phase = await loadPhase(client, phaseId);
        if (!phase) return null;
        const items = await query<PhaseItemRow>(client, `
          SELECT ${PHASE_ITEM_COLUMNS}
          FROM project_phase_items
          WHERE phase_id = $1
          ORDER BY sort_order ASC, created_at COLLATE "C" ASC, id COLLATE "C" ASC
        `, [phaseId]);
        return { phase, items };
      });
    },
    async updatePhase(phaseId, updates) {
      return withPhaseMutationTransaction(pool, async (client) => {
        const current = await loadPhase(client, phaseId);
        const dependencyId = typeof updates.startAfterPhaseId === 'string'
          ? updates.startAfterPhaseId
          : null;
        const dependency = dependencyId ? await loadPhase(client, dependencyId) : null;
        await lockProjectNamespaces(client, [
          current?.projectId,
          typeof updates.projectId === 'string' ? updates.projectId : null,
          dependency?.projectId,
        ]);
        await updateRow(client, 'project_phases', phaseId, updates, {
          ...PHASE_UPDATE_COLUMNS,
          updatedAt: 'updated_at',
        });
        return loadPhase(client, phaseId);
      });
    },
    async deletePhase(phaseId) {
      await withPhaseMutationTransaction(pool, async (client) => {
        const related = await query<{ projectId: string | null }>(client, `
          SELECT project_id AS "projectId" FROM project_phases
          WHERE id = $1 OR start_after_phase_id = $1
        `, [phaseId]);
        await lockProjectNamespaces(client, related.map(({ projectId }) => projectId));
        await client.query(`
          UPDATE project_phases SET start_after_phase_id = NULL
          WHERE start_after_phase_id = $1
        `, [phaseId]);
        await client.query('DELETE FROM project_phase_items WHERE phase_id = $1', [phaseId]);
        await client.query('DELETE FROM project_phases WHERE id = $1', [phaseId]);
      });
    },
  };
}

async function loadListOrganizationSnapshot(
  client: PoolClient,
): Promise<ListOrganizationSnapshot> {
  const groups = await query<ListOrganizationGroup>(client, `
    SELECT id, name, icon, icon_color AS "iconColor", source_id AS "sourceId",
           sort_order AS "sortOrder", created_at AS "createdAt"
    FROM list_groups
    ORDER BY sort_order ASC, name COLLATE "C" ASC, id COLLATE "C" ASC
  `);
  const lists = await query<SourceListRow>(client, `
    SELECT ${SOURCE_LIST_COLUMNS}
    FROM source_lists
    ORDER BY name COLLATE "C" ASC, id COLLATE "C" ASC
  `);
  const taskCounts = await query<{
    sourceListId: string | null;
    connectorInstanceId: string;
    count: string;
  }>(client, `
    SELECT source_list_id AS "sourceListId",
           connector_instance_id AS "connectorInstanceId",
           count(*)::text AS count
    FROM tasks
    WHERE status NOT IN ('done', 'cancelled')
      AND parent_id IS NULL
      AND is_checklist_item = FALSE
    GROUP BY source_list_id, connector_instance_id
  `);
  const countByIdentity = new Map(taskCounts.map((row) => [
    `${row.connectorInstanceId}:${row.sourceListId}`,
    Number(row.count),
  ]));
  const enriched = lists.map((list) => ({
    ...list,
    name: list.userDisplayName || list.name,
    taskCount: countByIdentity.get(`${list.connectorInstanceId}:${list.sourceId}`) ?? 0,
  }));
  return {
    groups: groups.map((group) => ({
      ...group,
      sourceLists: enriched
        .filter((list) => list.groupId === group.id)
        .sort((left, right) => (
          left.sortOrder - right.sortOrder
          || left.name.localeCompare(right.name)
          || left.id.localeCompare(right.id)
        )),
    })),
    ungroupedLists: enriched.filter((list) => !list.groupId),
  };
}

export function createPostgresListOrganizationRepository(
  pool: Pool,
): ListOrganizationPersistence {
  return {
    async getSnapshot() {
      return withReadTransaction(pool, loadListOrganizationSnapshot);
    },
    async createGroup(group) {
      await withMutationTransaction(pool, [LIST_ORGANIZATION_LOCK], async (client) => {
        const [maximum] = await query<{ value: number }>(client, `
          SELECT coalesce(max(sort_order), -1) AS value FROM list_groups
        `);
        await client.query(`
          INSERT INTO list_groups (
            id, name, icon, icon_color, source_id, sort_order, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
          group.id,
          group.name,
          group.icon,
          group.iconColor,
          group.sourceId,
          Number(maximum?.value ?? -1) + 1,
          group.createdAt,
        ]);
      });
    },
    async updateGroup(groupId, updates) {
      await withMutationTransaction(pool, [LIST_ORGANIZATION_LOCK], async (client) => {
        await updateRow(client, 'list_groups', groupId, updates, GROUP_UPDATE_COLUMNS);
      });
    },
    async deleteGroup(groupId) {
      await withMutationTransaction(pool, [LIST_ORGANIZATION_LOCK], async (client) => {
        await client.query('UPDATE source_lists SET group_id = NULL WHERE group_id = $1', [groupId]);
        await client.query('DELETE FROM list_groups WHERE id = $1', [groupId]);
      });
    },
    async reorderGroups(orderedIds) {
      await withMutationTransaction(pool, [LIST_ORGANIZATION_LOCK], async (client) => {
        for (const [index, id] of orderedIds.entries()) {
          await client.query('UPDATE list_groups SET sort_order = $1 WHERE id = $2', [index, id]);
        }
      });
    },
  };
}
