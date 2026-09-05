import type Database from 'better-sqlite3';
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
} from './project-organization';
import { decodeLenientJsonArray } from './value-codecs';
import type { ProjectPhase, ProjectPhaseItem } from '@/types';

interface ProjectRow extends Omit<
  ProjectOrganizationProject,
  'sourceBindings' | 'autoIncludeRules' | 'kanbanColumns' | 'defaultFilters' | 'metadata' | 'hidden'
> {
  sourceBindings: string;
  autoIncludeRules: string;
  kanbanColumns: string;
  defaultFilters: string | null;
  metadata: string;
  hidden: number;
}

interface PhaseRow extends Omit<ProjectPhase, 'status'> {
  status: string;
}

interface PhaseItemRow extends Omit<ProjectPhaseItem, 'isProposed'> {
  isProposed: number;
}

interface SourceListRow extends Omit<ListOrganizationSourceList, 'hidden'> {
  hidden: number;
}

const PROJECT_COLUMNS = `
  id, name, description, color, icon, icon_color AS iconColor,
  source_bindings AS sourceBindings, auto_include_rules AS autoIncludeRules,
  kanban_columns AS kanbanColumns, default_view AS defaultView,
  default_filters AS defaultFilters, status, status_override AS statusOverride,
  hidden, category, target_date AS targetDate, started_at AS startedAt,
  completed_at AS completedAt, sort_order AS sortOrder,
  hierarchy_revision AS hierarchyRevision, metadata,
  created_at AS createdAt, updated_at AS updatedAt
`;

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

const SOURCE_LIST_COLUMNS = `
  id, connector_instance_id AS connectorInstanceId, source_id AS sourceId,
  name, type, task_count AS taskCount, last_synced_at AS lastSyncedAt,
  well_known_list_name AS wellKnownListName, group_id AS groupId,
  sort_order AS sortOrder, hidden,
  last_known_remote_name AS lastKnownRemoteName,
  user_display_name AS userDisplayName, icon, icon_color AS iconColor
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

function parseJson<T>(value: string | T): T {
  return typeof value === 'string' ? JSON.parse(value) as T : value;
}

function projectFromRow(row: ProjectRow): ProjectOrganizationProject {
  return {
    ...row,
    hidden: row.hidden !== 0,
    sourceBindings: decodeLenientJsonArray(row.sourceBindings),
    autoIncludeRules: decodeLenientJsonArray(row.autoIncludeRules),
    kanbanColumns: decodeLenientJsonArray(row.kanbanColumns),
    defaultFilters: row.defaultFilters === null ? null : parseJson(row.defaultFilters),
    metadata: parseJson(row.metadata),
  };
}

function phaseFromRow(row: PhaseRow): ProjectPhase {
  return { ...row, status: row.status as ProjectPhase['status'] };
}

function phaseItemFromRow(row: PhaseItemRow): ProjectPhaseItem {
  return { ...row, isProposed: row.isProposed !== 0 };
}

function sourceListFromRow(row: SourceListRow): ListOrganizationSourceList {
  return { ...row, hidden: row.hidden !== 0 };
}

function sqliteValue(key: string, value: unknown): unknown {
  if (
    key === 'sourceBindings'
    || key === 'autoIncludeRules'
    || key === 'kanbanColumns'
    || key === 'defaultFilters'
    || key === 'metadata'
  ) {
    return value === null ? null : JSON.stringify(value);
  }
  if (key === 'hidden' && typeof value === 'boolean') return value ? 1 : 0;
  return value;
}

function updateStatement(
  sqlite: Database.Database,
  table: string,
  id: string,
  updates: Record<string, unknown>,
  columns: Record<string, string>,
): void {
  const fields = Object.keys(updates).filter((key) => key in columns);
  if (fields.length === 0) return;
  const assignments = fields.map((key) => `${columns[key]} = ?`).join(', ');
  sqlite.prepare(`UPDATE ${table} SET ${assignments} WHERE id = ?`)
    .run(...fields.map((key) => sqliteValue(key, updates[key])), id);
}

function loadProject(
  sqlite: Database.Database,
  projectId: string,
): ProjectOrganizationProject | null {
  const row = sqlite.prepare(`
    SELECT ${PROJECT_COLUMNS} FROM hub_projects WHERE id = ?
  `).get(projectId) as ProjectRow | undefined;
  return row ? projectFromRow(row) : null;
}

function loadPhase(sqlite: Database.Database, phaseId: string): ProjectPhase | null {
  const row = sqlite.prepare(`
    SELECT ${PHASE_COLUMNS} FROM project_phases WHERE id = ?
  `).get(phaseId) as PhaseRow | undefined;
  return row ? phaseFromRow(row) : null;
}

export function createSqliteProjectAdministrationRepository(
  sqlite: Database.Database,
): ProjectAdministrationPersistence {
  return {
    async listProjects({ includeHidden, includePhases }) {
      return sqlite.transaction(() => {
        const rows = sqlite.prepare(`
          SELECT ${PROJECT_COLUMNS}
          FROM hub_projects
          ${includeHidden ? '' : 'WHERE hidden = 0'}
          ORDER BY name COLLATE BINARY ASC, id COLLATE BINARY ASC
        `).all() as ProjectRow[];
        const projects = rows.map(projectFromRow);
        if (!includePhases) return projects;

        const phases = sqlite.prepare(`
          SELECT id, project_id AS projectId, name
          FROM project_phases
          ORDER BY sort_order ASC, created_at COLLATE BINARY ASC, id COLLATE BINARY ASC
        `).all() as Array<{ id: string; projectId: string | null; name: string }>;
        return projects.map((project) => ({
          ...project,
          phases: phases
            .filter((phase) => phase.projectId === project.id)
            .map(({ id, name }) => ({ id, name })),
        }));
      }).deferred();
    },
    async getProject(projectId) {
      return loadProject(sqlite, projectId);
    },
    async projectExists(projectId) {
      return Boolean(sqlite.prepare('SELECT 1 FROM hub_projects WHERE id = ?').get(projectId));
    },
    async createProject(project) {
      sqlite.prepare(`
        INSERT INTO hub_projects (
          id, name, description, color, icon, icon_color, source_bindings,
          auto_include_rules, kanban_columns, default_view, default_filters,
          status, status_override, hidden, category, target_date, started_at,
          completed_at, sort_order, hierarchy_revision, metadata, created_at, updated_at
        ) VALUES (
          @id, @name, @description, @color, @icon, @iconColor, @sourceBindings,
          @autoIncludeRules, @kanbanColumns, @defaultView, @defaultFilters,
          @status, @statusOverride, @hidden, @category, @targetDate, @startedAt,
          @completedAt, @sortOrder, @hierarchyRevision, @metadata, @createdAt, @updatedAt
        )
      `).run({
        ...project,
        hidden: project.hidden ? 1 : 0,
        sourceBindings: JSON.stringify(project.sourceBindings),
        autoIncludeRules: JSON.stringify(project.autoIncludeRules),
        kanbanColumns: JSON.stringify(project.kanbanColumns),
        defaultFilters: project.defaultFilters === null
          ? null
          : JSON.stringify(project.defaultFilters),
        metadata: JSON.stringify(project.metadata),
      });
    },
    async updateProject(projectId, updates) {
      return sqlite.transaction(() => {
        updateStatement(sqlite, 'hub_projects', projectId, {
          ...updates,
          updatedAt: updates.updatedAt,
        }, { ...PROJECT_UPDATE_COLUMNS, updatedAt: 'updated_at' });
        const affectedTaskIds = (sqlite.prepare(`
          SELECT task_id AS taskId
          FROM task_projects
          WHERE project_id = ?
          ORDER BY task_id COLLATE BINARY ASC
        `).all(projectId) as Array<{ taskId: string }>).map(({ taskId }) => taskId);
        return { affectedTaskIds };
      }).immediate();
    },
    async deleteProject(projectId, cascade) {
      return sqlite.transaction(() => {
        const affectedTaskIds = (sqlite.prepare(`
          SELECT task_id AS taskId
          FROM task_projects
          WHERE project_id = ?
          ORDER BY task_id COLLATE BINARY ASC
        `).all(projectId) as Array<{ taskId: string }>).map(({ taskId }) => taskId);
        if (cascade === 'owned-hierarchy') {
          sqlite.prepare(`
            DELETE FROM project_phase_items
            WHERE phase_id IN (SELECT id FROM project_phases WHERE project_id = ?)
          `).run(projectId);
          sqlite.prepare('DELETE FROM project_phases WHERE project_id = ?').run(projectId);
          sqlite.prepare('DELETE FROM project_tags WHERE project_id = ?').run(projectId);
          sqlite.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(projectId);
          sqlite.prepare('DELETE FROM project_hierarchy_commands WHERE project_id = ?').run(projectId);
          sqlite.prepare('DELETE FROM project_hierarchy_mutation_context WHERE project_id = ?')
            .run(projectId);
        }
        sqlite.prepare('DELETE FROM project_auto_include_exclusions WHERE project_id = ?')
          .run(projectId);
        sqlite.prepare('DELETE FROM task_projects WHERE project_id = ?').run(projectId);
        sqlite.prepare('DELETE FROM hub_projects WHERE id = ?').run(projectId);
        return { affectedTaskIds };
      }).immediate();
    },
    async listPhases({ projectId, crossProject }) {
      const where = crossProject
        ? 'WHERE project_id IS NULL'
        : projectId
          ? 'WHERE project_id = ?'
          : '';
      const rows = sqlite.prepare(`
        SELECT ${PHASE_COLUMNS}
        FROM project_phases
        ${where}
        ORDER BY sort_order ASC, created_at COLLATE BINARY ASC, id COLLATE BINARY ASC
      `).all(...(projectId && !crossProject ? [projectId] : [])) as PhaseRow[];
      return rows.map(phaseFromRow);
    },
    async createPhase(phase) {
      sqlite.transaction(() => {
        sqlite.prepare(`
          INSERT INTO project_phases (
            id, project_id, name, description, status, color, estimated_days,
            target_start, target_end, start_after_phase_id, sort_order,
            completed_at, created_at, updated_at
          ) VALUES (
            @id, @projectId, @name, @description, @status, @color, @estimatedDays,
            @targetStart, @targetEnd, @startAfterPhaseId, @sortOrder,
            @completedAt, @createdAt, @updatedAt
          )
        `).run(phase);
      }).immediate();
      return loadPhase(sqlite, phase.id)!;
    },
    async getPhase(phaseId) {
      return sqlite.transaction(() => {
        const phase = loadPhase(sqlite, phaseId);
        if (!phase) return null;
        const items = (sqlite.prepare(`
          SELECT ${PHASE_ITEM_COLUMNS}
          FROM project_phase_items
          WHERE phase_id = ?
          ORDER BY sort_order ASC, created_at COLLATE BINARY ASC, id COLLATE BINARY ASC
        `).all(phaseId) as PhaseItemRow[]).map(phaseItemFromRow);
        return { phase, items };
      }).deferred();
    },
    async updatePhase(phaseId, updates) {
      return sqlite.transaction(() => {
        updateStatement(sqlite, 'project_phases', phaseId, updates, {
          ...PHASE_UPDATE_COLUMNS,
          updatedAt: 'updated_at',
        });
        return loadPhase(sqlite, phaseId);
      }).immediate();
    },
    async deletePhase(phaseId) {
      sqlite.transaction(() => {
        sqlite.prepare(`
          UPDATE project_phases SET start_after_phase_id = NULL
          WHERE start_after_phase_id = ?
        `).run(phaseId);
        sqlite.prepare('DELETE FROM project_phase_items WHERE phase_id = ?').run(phaseId);
        sqlite.prepare('DELETE FROM project_phases WHERE id = ?').run(phaseId);
      }).immediate();
    },
  };
}

function loadListOrganizationSnapshot(
  sqlite: Database.Database,
): ListOrganizationSnapshot {
  const groups = sqlite.prepare(`
    SELECT id, name, icon, icon_color AS iconColor, source_id AS sourceId,
           sort_order AS sortOrder, created_at AS createdAt
    FROM list_groups
    ORDER BY sort_order ASC, name COLLATE BINARY ASC, id COLLATE BINARY ASC
  `).all() as ListOrganizationGroup[];
  const lists = (sqlite.prepare(`
    SELECT ${SOURCE_LIST_COLUMNS}
    FROM source_lists
    ORDER BY name COLLATE BINARY ASC, id COLLATE BINARY ASC
  `).all() as SourceListRow[]).map(sourceListFromRow);
  const taskCounts = sqlite.prepare(`
    SELECT source_list_id AS sourceListId,
           connector_instance_id AS connectorInstanceId,
           count(*) AS count
    FROM tasks
    WHERE status NOT IN ('done', 'cancelled')
      AND parent_id IS NULL
      AND is_checklist_item = 0
    GROUP BY source_list_id, connector_instance_id
  `).all() as Array<{
    sourceListId: string | null;
    connectorInstanceId: string;
    count: number;
  }>;
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

export function createSqliteListOrganizationRepository(
  sqlite: Database.Database,
): ListOrganizationPersistence {
  return {
    async getSnapshot() {
      return sqlite.transaction(() => loadListOrganizationSnapshot(sqlite)).deferred();
    },
    async createGroup(group) {
      sqlite.transaction(() => {
        const max = sqlite.prepare(`
          SELECT coalesce(max(sort_order), -1) AS value FROM list_groups
        `).get() as { value: number };
        sqlite.prepare(`
          INSERT INTO list_groups (
            id, name, icon, icon_color, source_id, sort_order, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          group.id,
          group.name,
          group.icon,
          group.iconColor,
          group.sourceId,
          Number(max.value ?? -1) + 1,
          group.createdAt,
        );
      }).immediate();
    },
    async updateGroup(groupId, updates) {
      sqlite.transaction(() => {
        updateStatement(sqlite, 'list_groups', groupId, updates, GROUP_UPDATE_COLUMNS);
      }).immediate();
    },
    async deleteGroup(groupId) {
      sqlite.transaction(() => {
        sqlite.prepare('UPDATE source_lists SET group_id = NULL WHERE group_id = ?')
          .run(groupId);
        sqlite.prepare('DELETE FROM list_groups WHERE id = ?').run(groupId);
      }).immediate();
    },
    async reorderGroups(orderedIds) {
      sqlite.transaction(() => {
        const update = sqlite.prepare('UPDATE list_groups SET sort_order = ? WHERE id = ?');
        orderedIds.forEach((id, index) => update.run(index, id));
      }).immediate();
    },
  };
}
