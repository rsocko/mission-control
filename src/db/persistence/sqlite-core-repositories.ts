import type Database from 'better-sqlite3';
import type {
  ConnectorConfig,
  HubProject,
  NotificationAction,
  NotificationItem,
  Tag,
  TaskItem,
} from '@/types';
import { RepositoryError, type PersistenceJson } from './contracts';
import type {
  ConnectorRepository,
  ConnectorTestResultCommand,
  CorePersistenceRepositories,
  NotificationRepository,
  ProjectRepository,
  AtomicSettingsRepository,
  TaskRepository,
} from './core-repositories';
import type {
  HoustonConversationMemory,
  HoustonConversationMemoryWrite,
  HoustonMemoryEntityLink,
  HoustonMemoryListRequest,
  HoustonMemoryRepository,
} from '@/lib/houston-memory/contracts';
import {
  mergeConnectorSettings,
  patchConnectorSettingsState,
} from './connector-settings';
import {
  cleanupTaskAssociations,
} from './sqlite-task-deletion';

type SqliteDatabase = Database.Database;

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function parseJsonContainer(value: unknown): unknown {
  let parsed = value;
  for (let depth = 0; depth < 5 && typeof parsed === 'string'; depth += 1) {
    parsed = JSON.parse(parsed) as unknown;
  }
  return parsed;
}

function parseJsonObject(value: unknown, field: string): Record<string, unknown> {
  const parsed = parseJsonContainer(value);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Expected ${field} to contain a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonArray(value: unknown, field: string): unknown[] {
  const parsed = parseJsonContainer(value);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${field} to contain a JSON array`);
  }
  return parsed;
}

interface TagRow {
  id: string;
  name: string;
  slug: string;
  type: string;
  source: string | null;
  color: string | null;
  confirmed: number;
  createdAt: string;
}

function mapTag(row: TagRow): Tag {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    type: row.type as Tag['type'],
    source: row.source ?? undefined,
    color: row.color ?? undefined,
    confirmed: row.confirmed !== 0,
    createdAt: row.createdAt,
  };
}

function upsertTag(database: SqliteDatabase, tag: Tag): void {
  database.prepare(`
    INSERT INTO tags (
      id, name, slug, type, source, color, confirmed, created_at
    ) VALUES (
      @id, @name, @slug, @type, @source, @color, @confirmed, @createdAt
    )
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      slug = excluded.slug,
      type = excluded.type,
      source = excluded.source,
      color = excluded.color,
      confirmed = excluded.confirmed
  `).run({
    ...tag,
    source: tag.source ?? null,
    color: tag.color ?? null,
    confirmed: tag.confirmed ? 1 : 0,
  });
}

interface TaskRow {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  description: string | null;
  status: string;
  localDisposition: string;
  priority: string;
  planningHorizon: string | null;
  dueDate: string | null;
  pushCount: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  parentId: string | null;
  depth: number;
  isChecklistItem: number;
  sourceListId: string | null;
  sourceListName: string | null;
  assignee: string | null;
  microStatus: string | null;
  statusReason: string | null;
  metadata: unknown;
  syncStatus: string;
  lastSyncedAt: string;
  kanbanColumn: string | null;
  kanbanOrder: number | null;
  snoozedUntil: string | null;
  effort: number | null;
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly database: SqliteDatabase) {}

  private getSync(id: string): TaskItem | null {
    const row = this.database.prepare(`
      SELECT
        id,
        source_id AS sourceId,
        connector_type AS connectorType,
        connector_instance_id AS connectorInstanceId,
        title,
        description,
        status,
        local_disposition AS localDisposition,
        priority,
        planning_horizon AS planningHorizon,
        due_date AS dueDate,
        push_count AS pushCount,
        created_at AS createdAt,
        updated_at AS updatedAt,
        completed_at AS completedAt,
        parent_id AS parentId,
        depth,
        is_checklist_item AS isChecklistItem,
        source_list_id AS sourceListId,
        source_list_name AS sourceListName,
        assignee,
        micro_status AS microStatus,
        status_reason AS statusReason,
        metadata,
        sync_status AS syncStatus,
        last_synced_at AS lastSyncedAt,
        kanban_column AS kanbanColumn,
        kanban_order AS kanbanOrder,
        snoozed_until AS snoozedUntil,
        effort
      FROM tasks
      WHERE id = ?
    `).get(id) as TaskRow | undefined;
    if (!row) return null;

    const childIds = this.database.prepare(`
      SELECT id FROM tasks WHERE parent_id = ? ORDER BY created_at, id
    `).all(id) as Array<{ id: string }>;
    const projectIds = this.database.prepare(`
      SELECT project_id AS projectId
      FROM task_projects
      WHERE task_id = ?
      ORDER BY project_id
    `).all(id) as Array<{ projectId: string }>;
    const tagRows = this.database.prepare(`
      SELECT
        tag.id,
        tag.name,
        tag.slug,
        tag.type,
        tag.source,
        tag.color,
        tag.confirmed,
        tag.created_at AS createdAt
      FROM tags AS tag
      INNER JOIN task_tags AS link ON link.tag_id = tag.id
      WHERE link.task_id = ?
      ORDER BY tag.id
    `).all(id) as TagRow[];

    return {
      id: row.id,
      sourceId: row.sourceId,
      connectorType: row.connectorType,
      connectorInstanceId: row.connectorInstanceId,
      title: row.title,
      description: row.description ?? undefined,
      status: row.status as TaskItem['status'],
      localDisposition: row.localDisposition as TaskItem['localDisposition'],
      microStatus: row.microStatus === null
        ? undefined
        : row.microStatus as TaskItem['microStatus'],
      statusReason: row.statusReason === null
        ? undefined
        : row.statusReason as TaskItem['statusReason'],
      priority: row.priority as TaskItem['priority'],
      planningHorizon: row.planningHorizon as TaskItem['planningHorizon'],
      dueDate: row.dueDate ?? undefined,
      pushCount: row.pushCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      completedAt: row.completedAt ?? undefined,
      snoozedUntil: row.snoozedUntil,
      parentId: row.parentId ?? undefined,
      childIds: childIds.map((child) => child.id),
      depth: row.depth,
      isChecklistItem: row.isChecklistItem !== 0,
      sourceListId: row.sourceListId ?? undefined,
      sourceListName: row.sourceListName ?? undefined,
      hubProjectIds: projectIds.map((project) => project.projectId),
      tags: tagRows.map(mapTag),
      assignee: row.assignee ?? undefined,
      metadata: parseJsonObject(row.metadata, 'tasks.metadata'),
      syncStatus: row.syncStatus as TaskItem['syncStatus'],
      lastSyncedAt: row.lastSyncedAt,
      effort: row.effort,
      kanbanColumn: row.kanbanColumn ?? undefined,
      kanbanOrder: row.kanbanOrder ?? undefined,
    };
  }

  async get(id: string): Promise<TaskItem | null> {
    return this.getSync(id);
  }

  async upsert(task: TaskItem): Promise<TaskItem> {
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO tasks (
          id, source_id, connector_type, connector_instance_id, title,
          description, status, local_disposition, priority, planning_horizon,
          due_date, push_count, created_at, updated_at, completed_at, parent_id,
          depth, is_checklist_item, source_list_id, source_list_name, assignee,
          micro_status, status_reason, metadata, sync_status, last_synced_at,
          kanban_column, kanban_order, snoozed_until, effort
        ) VALUES (
          @id, @sourceId, @connectorType, @connectorInstanceId, @title,
          @description, @status, @localDisposition, @priority, @planningHorizon,
          @dueDate, @pushCount, @createdAt, @updatedAt, @completedAt, @parentId,
          @depth, @isChecklistItem, @sourceListId, @sourceListName, @assignee,
          @microStatus, @statusReason, @metadata, @syncStatus, @lastSyncedAt,
          @kanbanColumn, @kanbanOrder, @snoozedUntil, @effort
        )
        ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id,
          connector_type = excluded.connector_type,
          connector_instance_id = excluded.connector_instance_id,
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          local_disposition = excluded.local_disposition,
          priority = excluded.priority,
          planning_horizon = excluded.planning_horizon,
          due_date = excluded.due_date,
          push_count = excluded.push_count,
          updated_at = excluded.updated_at,
          completed_at = excluded.completed_at,
          parent_id = excluded.parent_id,
          depth = excluded.depth,
          is_checklist_item = excluded.is_checklist_item,
          source_list_id = excluded.source_list_id,
          source_list_name = excluded.source_list_name,
          assignee = excluded.assignee,
          micro_status = excluded.micro_status,
          status_reason = excluded.status_reason,
          metadata = excluded.metadata,
          sync_status = excluded.sync_status,
          last_synced_at = excluded.last_synced_at,
          kanban_column = excluded.kanban_column,
          kanban_order = excluded.kanban_order,
          snoozed_until = excluded.snoozed_until,
          effort = excluded.effort
      `).run({
        ...task,
        description: task.description ?? null,
        localDisposition: task.localDisposition ?? 'active',
        planningHorizon: task.planningHorizon ?? null,
        dueDate: task.dueDate ?? null,
        pushCount: task.pushCount ?? 0,
        completedAt: task.completedAt ?? null,
        parentId: task.parentId ?? null,
        isChecklistItem: task.isChecklistItem ? 1 : 0,
        sourceListId: task.sourceListId ?? null,
        sourceListName: task.sourceListName ?? null,
        assignee: task.assignee ?? null,
        microStatus: task.microStatus ?? null,
        statusReason: task.statusReason ?? null,
        metadata: stringifyJson(task.metadata),
        kanbanColumn: task.kanbanColumn ?? null,
        kanbanOrder: task.kanbanOrder ?? null,
        snoozedUntil: task.snoozedUntil ?? null,
        effort: task.effort ?? null,
      });

      this.database.prepare('DELETE FROM task_tags WHERE task_id = ?').run(task.id);
      const insertTaskTag = this.database.prepare(
        'INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)',
      );
      for (const tag of task.tags) {
        upsertTag(this.database, tag);
        insertTaskTag.run(task.id, tag.id);
      }

      this.database.prepare('DELETE FROM task_projects WHERE task_id = ?').run(task.id);
      const insertTaskProject = this.database.prepare(
        'INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)',
      );
      for (const projectId of task.hubProjectIds) {
        insertTaskProject.run(task.id, projectId);
      }
    });
    write.immediate();
    return this.getSync(task.id)!;
  }

  async delete(id: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database.prepare(`
        WITH RECURSIVE descendants(id, depth, path) AS (
          SELECT id, 0, ',' || id || ','
          FROM tasks
          WHERE parent_id = ? AND id <> ?
          UNION ALL
          SELECT child.id, descendants.depth + 1, descendants.path || child.id || ','
          FROM tasks AS child
          INNER JOIN descendants ON child.parent_id = descendants.id
          WHERE instr(descendants.path, ',' || child.id || ',') = 0
        )
        UPDATE tasks
        SET
          parent_id = CASE WHEN parent_id = ? THEN NULL ELSE parent_id END,
          depth = (
            SELECT descendants.depth
            FROM descendants
            WHERE descendants.id = tasks.id
          )
        WHERE id IN (SELECT id FROM descendants)
      `).run(id, id, id);
      cleanupTaskAssociations(this.database, id);
      return this.database.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes === 1;
    });
    return remove.immediate();
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string | null;
  iconColor: string | null;
  sourceBindings: unknown;
  autoIncludeRules: unknown;
  kanbanColumns: unknown;
  defaultView: string;
  defaultFilters: unknown;
  status: string;
  statusOverride: string | null;
  hidden: number;
  category: string | null;
  targetDate: string | null;
  startedAt: string | null;
  completedAt: string | null;
  sortOrder: number;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export class SqliteProjectRepository implements ProjectRepository {
  constructor(private readonly database: SqliteDatabase) {}

  private getSync(id: string): HubProject | null {
    const row = this.database.prepare(`
      SELECT
        id, name, description, color, icon, icon_color AS iconColor,
        source_bindings AS sourceBindings,
        auto_include_rules AS autoIncludeRules,
        kanban_columns AS kanbanColumns,
        default_view AS defaultView,
        default_filters AS defaultFilters,
        status,
        status_override AS statusOverride,
        hidden,
        category,
        target_date AS targetDate,
        started_at AS startedAt,
        completed_at AS completedAt,
        sort_order AS sortOrder,
        metadata,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM hub_projects
      WHERE id = ?
    `).get(id) as ProjectRow | undefined;
    if (!row) return null;

    const tagRows = this.database.prepare(`
      SELECT
        tag.id,
        tag.name,
        tag.slug,
        tag.type,
        tag.source,
        tag.color,
        tag.confirmed,
        tag.created_at AS createdAt
      FROM tags AS tag
      INNER JOIN project_tags AS link ON link.tag_id = tag.id
      WHERE link.project_id = ?
      ORDER BY tag.id
    `).all(id) as TagRow[];

    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      color: row.color,
      icon: row.icon ?? undefined,
      iconColor: row.iconColor ?? undefined,
      sourceBindings: parseJsonArray(
        row.sourceBindings,
        'hub_projects.source_bindings',
      ) as HubProject['sourceBindings'],
      autoIncludeRules: parseJsonArray(
        row.autoIncludeRules,
        'hub_projects.auto_include_rules',
      ) as HubProject['autoIncludeRules'],
      kanbanColumns: parseJsonArray(
        row.kanbanColumns,
        'hub_projects.kanban_columns',
      ) as HubProject['kanbanColumns'],
      defaultView: row.defaultView as HubProject['defaultView'],
      defaultFilters: row.defaultFilters === null
        ? undefined
        : parseJsonObject(
            row.defaultFilters,
            'hub_projects.default_filters',
          ) as unknown as HubProject['defaultFilters'],
      status: row.status as HubProject['status'],
      statusOverride: row.statusOverride === null
        ? undefined
        : row.statusOverride as HubProject['statusOverride'],
      hidden: row.hidden !== 0,
      category: row.category ?? undefined,
      targetDate: row.targetDate ?? undefined,
      startedAt: row.startedAt ?? undefined,
      completedAt: row.completedAt ?? undefined,
      sortOrder: row.sortOrder,
      metadata: parseJsonObject(row.metadata, 'hub_projects.metadata'),
      tags: tagRows.map(mapTag),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  async get(id: string): Promise<HubProject | null> {
    return this.getSync(id);
  }

  async upsert(project: HubProject): Promise<HubProject> {
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO hub_projects (
          id, name, description, color, icon, icon_color, source_bindings,
          auto_include_rules, kanban_columns, default_view, default_filters,
          status, status_override, hidden, category, target_date, started_at,
          completed_at, sort_order, metadata, created_at, updated_at
        ) VALUES (
          @id, @name, @description, @color, @icon, @iconColor, @sourceBindings,
          @autoIncludeRules, @kanbanColumns, @defaultView, @defaultFilters,
          @status, @statusOverride, @hidden, @category, @targetDate, @startedAt,
          @completedAt, @sortOrder, @metadata, @createdAt, @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          color = excluded.color,
          icon = excluded.icon,
          icon_color = excluded.icon_color,
          source_bindings = excluded.source_bindings,
          auto_include_rules = excluded.auto_include_rules,
          kanban_columns = excluded.kanban_columns,
          default_view = excluded.default_view,
          default_filters = excluded.default_filters,
          status = excluded.status,
          status_override = excluded.status_override,
          hidden = excluded.hidden,
          category = excluded.category,
          target_date = excluded.target_date,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          sort_order = excluded.sort_order,
          metadata = excluded.metadata,
          updated_at = excluded.updated_at
      `).run({
        ...project,
        description: project.description ?? null,
        icon: project.icon ?? null,
        iconColor: project.iconColor ?? null,
        sourceBindings: stringifyJson(project.sourceBindings),
        autoIncludeRules: stringifyJson(project.autoIncludeRules),
        kanbanColumns: stringifyJson(project.kanbanColumns),
        defaultFilters: project.defaultFilters === undefined
          ? null
          : stringifyJson(project.defaultFilters),
        statusOverride: project.statusOverride ?? null,
        hidden: project.hidden ? 1 : 0,
        category: project.category ?? null,
        targetDate: project.targetDate ?? null,
        startedAt: project.startedAt ?? null,
        completedAt: project.completedAt ?? null,
        metadata: stringifyJson(project.metadata),
      });

      this.database.prepare('DELETE FROM project_tags WHERE project_id = ?').run(project.id);
      const insertProjectTag = this.database.prepare(
        'INSERT INTO project_tags (project_id, tag_id) VALUES (?, ?)',
      );
      for (const tag of project.tags) {
        upsertTag(this.database, tag);
        insertProjectTag.run(project.id, tag.id);
      }
    });
    write.immediate();
    return this.getSync(project.id)!;
  }

  async delete(id: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM project_phase_items
        WHERE phase_id IN (
          SELECT id FROM project_phases WHERE project_id = ?
        )
      `).run(id);
      this.database.prepare('DELETE FROM project_phases WHERE project_id = ?').run(id);
      this.database.prepare(
        'DELETE FROM project_auto_include_exclusions WHERE project_id = ?',
      ).run(id);
      this.database.prepare('DELETE FROM project_tags WHERE project_id = ?').run(id);
      this.database.prepare('DELETE FROM task_projects WHERE project_id = ?').run(id);
      this.database.prepare('DELETE FROM project_milestones WHERE project_id = ?').run(id);
      return this.database.prepare('DELETE FROM hub_projects WHERE id = ?').run(id).changes === 1;
    });
    return remove.immediate();
  }
}

interface ConnectorRow {
  id: string;
  type: string;
  name: string;
  enabled: number;
  syncMode: string;
  pollIntervalMinutes: number | null;
  capabilities: unknown;
  credentials: unknown;
  settings: unknown;
  syncedLists: unknown;
}

export class SqliteConnectorRepository implements ConnectorRepository {
  constructor(private readonly database: SqliteDatabase) {}

  private getSync(id: string): ConnectorConfig | null {
    const row = this.database.prepare(`
      SELECT
        id, type, name, enabled, sync_mode AS syncMode,
        poll_interval_minutes AS pollIntervalMinutes,
        capabilities, credentials, settings, synced_lists AS syncedLists
      FROM connector_configs
      WHERE id = ? AND deleted_at IS NULL
    `).get(id) as ConnectorRow | undefined;
    if (!row) return null;
    return {
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: row.enabled !== 0,
      syncMode: row.syncMode as ConnectorConfig['syncMode'],
      pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
      capabilities: parseJsonObject(
        row.capabilities,
        'connector_configs.capabilities',
      ) as unknown as ConnectorConfig['capabilities'],
      credentials: parseJsonObject(
        row.credentials,
        'connector_configs.credentials',
      ) as ConnectorConfig['credentials'],
      settings: parseJsonObject(row.settings, 'connector_configs.settings'),
      syncedLists: parseJsonArray(
        row.syncedLists,
        'connector_configs.synced_lists',
      ).map(String),
    };
  }

  async get(id: string): Promise<ConnectorConfig | null> {
    return this.getSync(id);
  }

  async listEnabled(): Promise<ConnectorConfig[]> {
    const rows = this.database.prepare(`
      SELECT
        id, type, name, enabled, sync_mode AS syncMode,
        poll_interval_minutes AS pollIntervalMinutes,
        capabilities, credentials, settings, synced_lists AS syncedLists
      FROM connector_configs
      WHERE enabled = 1 AND deleted_at IS NULL
    `).all() as ConnectorRow[];
    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      enabled: true,
      syncMode: row.syncMode as ConnectorConfig['syncMode'],
      pollIntervalMinutes: row.pollIntervalMinutes ?? undefined,
      capabilities: parseJsonObject(
        row.capabilities,
        'connector_configs.capabilities',
      ) as unknown as ConnectorConfig['capabilities'],
      credentials: parseJsonObject(
        row.credentials,
        'connector_configs.credentials',
      ) as ConnectorConfig['credentials'],
      settings: parseJsonObject(row.settings, 'connector_configs.settings'),
      syncedLists: parseJsonArray(
        row.syncedLists,
        'connector_configs.synced_lists',
      ).map(String),
    }));
  }

  async upsert(connector: ConnectorConfig): Promise<ConnectorConfig> {
    const now = new Date().toISOString();
    this.database.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes,
        capabilities, credentials, settings, synced_lists, created_at,
        updated_at, deleted_at
      ) VALUES (
        @id, @type, @name, @enabled, @syncMode, @pollIntervalMinutes,
        @capabilities, @credentials, @settings, @syncedLists, @now, @now, NULL
      )
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        name = excluded.name,
        enabled = excluded.enabled,
        sync_mode = excluded.sync_mode,
        poll_interval_minutes = excluded.poll_interval_minutes,
        capabilities = excluded.capabilities,
        credentials = excluded.credentials,
        settings = excluded.settings,
        synced_lists = excluded.synced_lists,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `).run({
      ...connector,
      enabled: connector.enabled ? 1 : 0,
      pollIntervalMinutes: connector.pollIntervalMinutes ?? null,
      capabilities: stringifyJson(connector.capabilities),
      credentials: stringifyJson(connector.credentials),
      settings: stringifyJson(connector.settings),
      syncedLists: stringifyJson(connector.syncedLists),
      now,
    });
    return this.getSync(connector.id)!;
  }

  async updateCredentials(
    id: string,
    credentials: ConnectorConfig['credentials'],
    settingsPatch?: Record<string, unknown>,
  ): Promise<void> {
    if (settingsPatch === undefined) {
      const result = this.database.prepare(`
        UPDATE connector_configs
        SET credentials = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(stringifyJson(credentials), new Date().toISOString(), id);
      if (result.changes !== 1) {
        throw new RepositoryError('not-found', `Connector ${id} was not found`);
      }
      return;
    }
    this.database.transaction(() => {
      const row = this.database.prepare(`
        SELECT settings FROM connector_configs
        WHERE id = ? AND deleted_at IS NULL
      `).get(id) as { settings: string } | undefined;
      if (!row) {
        throw new RepositoryError('not-found', `Connector ${id} was not found`);
      }
      const settings = mergeConnectorSettings(
        parseJsonObject(row.settings, 'connector_configs.settings'),
        settingsPatch,
      );
      this.database.prepare(`
          UPDATE connector_configs
          SET credentials = ?, settings = ?, updated_at = ?
          WHERE id = ? AND deleted_at IS NULL
        `).run(
          stringifyJson(credentials),
          stringifyJson(settings),
          new Date().toISOString(),
          id,
        );
    }).immediate();
  }

  async delete(id: string): Promise<boolean> {
    const now = new Date().toISOString();
    return this.database.prepare(`
      UPDATE connector_configs
      SET enabled = 0, deleted_at = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(now, now, id).changes === 1;
  }

  async recordTestResult(
    command: ConnectorTestResultCommand,
  ): Promise<{ recorded: boolean }> {
    const columns = this.database.prepare(
      `PRAGMA table_info(connector_configs)`,
    ).all() as Array<{ name: string }>;
    const available = new Set(columns.map((column) => column.name));
    if (
      !available.has('last_test_status')
      || !available.has('last_test_error')
      || !available.has('last_test_at')
    ) {
      const connector = this.database.prepare(`
        SELECT 1
        FROM connector_configs
        WHERE id = ? AND deleted_at IS NULL
      `).get(command.connectorId);
      return { recorded: connector !== undefined };
    }
    const result = this.database.prepare(`
      UPDATE connector_configs
      SET last_test_status = ?, last_test_error = ?, last_test_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(
      command.status,
      command.status === 'success' ? null : command.error,
      command.testedAt,
      command.connectorId,
    );
    return { recorded: result.changes === 1 };
  }

  async mergeSettings(
    id: string,
    currentSettings: Record<string, unknown>,
    patch: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const settings = mergeConnectorSettings(currentSettings, patch);
    const result = this.database.prepare(`
      UPDATE connector_configs
      SET settings = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL
    `).run(stringifyJson(settings), new Date().toISOString(), id);
    if (result.changes !== 1) {
      throw new RepositoryError('not-found', `Connector ${id} was not found`);
    }
    return settings;
  }

  async patchSettingsState<T extends object>(
    id: string,
    key: string,
    patch: Partial<T>,
  ): Promise<{ settings: Record<string, unknown>; state: T }> {
    const update = this.database.transaction(() => {
      const connector = this.getSync(id);
      if (!connector) {
        throw new RepositoryError('not-found', `Connector ${id} was not found`);
      }
      const { settings, state } = patchConnectorSettingsState(
        connector.settings,
        key,
        patch,
      );
      this.database.prepare(`
        UPDATE connector_configs
        SET settings = ?, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL
      `).run(stringifyJson(settings), new Date().toISOString(), id);
      return { settings, state };
    });
    return update.immediate();
  }
}

interface NotificationRow {
  id: string;
  sourceId: string;
  connectorType: string;
  connectorInstanceId: string;
  title: string;
  body: string | null;
  level: string;
  levelRank: number;
  category: string;
  templateKey: string | null;
  state: string;
  readState: string;
  disposition: string;
  sourceState: string;
  syncState: string;
  readAt: string | null;
  handledAt: string | null;
  dismissedAt: string | null;
  resolvedAt: string | null;
  archivedAt: string | null;
  mutedAt: string | null;
  snoozedUntil: string | null;
  sourceResolvedAt: string | null;
  lastSourceActivityAt: string | null;
  lastSourceActivityKey: string | null;
  handledSourceActivityAt: string | null;
  handledSourceActivityKey: string | null;
  lastSourceSyncedAt: string | null;
  isActionable: number;
  primaryActionId: string | null;
  aiSuggestedActionId: string | null;
  receivedAt: string;
  sortAt: string;
  expiresAt: string | null;
  groupKey: string | null;
  dedupeKey: string | null;
  relatedTaskId: string | null;
  relatedProjectId: string | null;
  relatedEntityType: string | null;
  relatedEntityId: string | null;
  navigationTarget: string | null;
  metadata: unknown;
  presentation: unknown;
}

interface NotificationActionRow {
  id: string;
  notificationId: string;
  actionType: string;
  label: string;
  icon: string | null;
  variant: string;
  isPrimary: number;
  sortOrder: number;
  payload: unknown;
  opensExternal: number;
  requiresConfirmation: number;
  createdBy: string;
}

function mapNotificationAction(row: NotificationActionRow): NotificationAction {
  return {
    id: row.id,
    notificationId: row.notificationId,
    actionType: row.actionType,
    label: row.label,
    icon: row.icon ?? undefined,
    variant: row.variant as NotificationAction['variant'],
    isPrimary: row.isPrimary !== 0,
    sortOrder: row.sortOrder,
    payload: parseJsonObject(row.payload, 'notification_actions.payload'),
    opensExternal: row.opensExternal !== 0,
    requiresConfirmation: row.requiresConfirmation !== 0,
    createdBy: row.createdBy as NotificationAction['createdBy'],
  };
}

export class SqliteNotificationRepository implements NotificationRepository {
  constructor(private readonly database: SqliteDatabase) {}

  private getSync(id: string): NotificationItem | null {
    const row = this.database.prepare(`
      SELECT
        id, source_id AS sourceId, connector_type AS connectorType,
        connector_instance_id AS connectorInstanceId, title, body, level,
        level_rank AS levelRank, category, template_key AS templateKey, state,
        read_state AS readState, disposition, source_state AS sourceState,
        sync_state AS syncState, read_at AS readAt, handled_at AS handledAt,
        dismissed_at AS dismissedAt, resolved_at AS resolvedAt,
        archived_at AS archivedAt, muted_at AS mutedAt,
        snoozed_until AS snoozedUntil, source_resolved_at AS sourceResolvedAt,
        last_source_activity_at AS lastSourceActivityAt,
        last_source_activity_key AS lastSourceActivityKey,
        handled_source_activity_at AS handledSourceActivityAt,
        handled_source_activity_key AS handledSourceActivityKey,
        last_source_synced_at AS lastSourceSyncedAt,
        is_actionable AS isActionable, primary_action_id AS primaryActionId,
        ai_suggested_action_id AS aiSuggestedActionId, received_at AS receivedAt,
        sort_at AS sortAt, expires_at AS expiresAt, group_key AS groupKey,
        dedupe_key AS dedupeKey, related_task_id AS relatedTaskId,
        related_project_id AS relatedProjectId,
        related_entity_type AS relatedEntityType,
        related_entity_id AS relatedEntityId,
        navigation_target AS navigationTarget, metadata, presentation
      FROM notifications
      WHERE id = ?
    `).get(id) as NotificationRow | undefined;
    if (!row) return null;

    const actionRows = this.database.prepare(`
      SELECT
        id, notification_id AS notificationId, action_type AS actionType,
        label, icon, variant, is_primary AS isPrimary, sort_order AS sortOrder,
        payload, opens_external AS opensExternal,
        requires_confirmation AS requiresConfirmation, created_by AS createdBy
      FROM notification_actions
      WHERE notification_id = ? AND execution_state = 'pending'
      ORDER BY sort_order, id
    `).all(id) as NotificationActionRow[];

    return {
      id: row.id,
      sourceId: row.sourceId,
      connectorType: row.connectorType,
      connectorInstanceId: row.connectorInstanceId,
      title: row.title,
      body: row.body,
      level: row.level as NotificationItem['level'],
      levelRank: row.levelRank,
      category: row.category,
      templateKey: row.templateKey,
      state: row.state as NotificationItem['state'],
      readState: row.readState as NotificationItem['readState'],
      disposition: row.disposition as NotificationItem['disposition'],
      sourceState: row.sourceState as NotificationItem['sourceState'],
      syncState: row.syncState as NotificationItem['syncState'],
      readAt: row.readAt,
      handledAt: row.handledAt,
      dismissedAt: row.dismissedAt,
      resolvedAt: row.resolvedAt,
      archivedAt: row.archivedAt,
      mutedAt: row.mutedAt,
      snoozedUntil: row.snoozedUntil,
      sourceResolvedAt: row.sourceResolvedAt,
      lastSourceActivityAt: row.lastSourceActivityAt,
      lastSourceActivityKey: row.lastSourceActivityKey,
      handledSourceActivityAt: row.handledSourceActivityAt,
      handledSourceActivityKey: row.handledSourceActivityKey,
      lastSourceSyncedAt: row.lastSourceSyncedAt,
      isActionable: row.isActionable !== 0,
      primaryActionId: row.primaryActionId,
      aiSuggestedActionId: row.aiSuggestedActionId,
      receivedAt: row.receivedAt,
      sortAt: row.sortAt,
      expiresAt: row.expiresAt,
      groupKey: row.groupKey,
      dedupeKey: row.dedupeKey,
      relatedTaskId: row.relatedTaskId,
      relatedProjectId: row.relatedProjectId,
      relatedEntityType: row.relatedEntityType,
      relatedEntityId: row.relatedEntityId,
      navigationTarget: row.navigationTarget,
      metadata: parseJsonObject(row.metadata, 'notifications.metadata'),
      presentation: parseJsonObject(row.presentation, 'notifications.presentation'),
      actions: actionRows.map(mapNotificationAction),
    };
  }

  async get(id: string): Promise<NotificationItem | null> {
    return this.getSync(id);
  }

  async upsert(notification: NotificationItem): Promise<NotificationItem> {
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO notifications (
          id, source_id, connector_type, connector_instance_id, title, body,
          level, level_rank, category, template_key, state, read_state,
          disposition, source_state, sync_state, read_at, handled_at,
          dismissed_at, resolved_at, archived_at, muted_at, snoozed_until,
          source_resolved_at, last_source_activity_at, last_source_activity_key,
          handled_source_activity_at, handled_source_activity_key,
          last_source_synced_at, is_actionable, primary_action_id,
          ai_suggested_action_id, received_at, sort_at, expires_at, group_key,
          dedupe_key, related_task_id, related_project_id, related_entity_type,
          related_entity_id, navigation_target, metadata, presentation
        ) VALUES (
          @id, @sourceId, @connectorType, @connectorInstanceId, @title, @body,
          @level, @levelRank, @category, @templateKey, @state, @readState,
          @disposition, @sourceState, @syncState, @readAt, @handledAt,
          @dismissedAt, @resolvedAt, @archivedAt, @mutedAt, @snoozedUntil,
          @sourceResolvedAt, @lastSourceActivityAt, @lastSourceActivityKey,
          @handledSourceActivityAt, @handledSourceActivityKey,
          @lastSourceSyncedAt, @isActionable, @primaryActionId,
          @aiSuggestedActionId, @receivedAt, @sortAt, @expiresAt, @groupKey,
          @dedupeKey, @relatedTaskId, @relatedProjectId, @relatedEntityType,
          @relatedEntityId, @navigationTarget, @metadata, @presentation
        )
        ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id,
          connector_type = excluded.connector_type,
          connector_instance_id = excluded.connector_instance_id,
          title = excluded.title,
          body = excluded.body,
          level = excluded.level,
          level_rank = excluded.level_rank,
          category = excluded.category,
          template_key = excluded.template_key,
          state = excluded.state,
          read_state = excluded.read_state,
          disposition = excluded.disposition,
          source_state = excluded.source_state,
          sync_state = excluded.sync_state,
          read_at = excluded.read_at,
          handled_at = excluded.handled_at,
          dismissed_at = excluded.dismissed_at,
          resolved_at = excluded.resolved_at,
          archived_at = excluded.archived_at,
          muted_at = excluded.muted_at,
          snoozed_until = excluded.snoozed_until,
          source_resolved_at = excluded.source_resolved_at,
          last_source_activity_at = excluded.last_source_activity_at,
          last_source_activity_key = excluded.last_source_activity_key,
          handled_source_activity_at = excluded.handled_source_activity_at,
          handled_source_activity_key = excluded.handled_source_activity_key,
          last_source_synced_at = excluded.last_source_synced_at,
          is_actionable = excluded.is_actionable,
          primary_action_id = excluded.primary_action_id,
          ai_suggested_action_id = excluded.ai_suggested_action_id,
          received_at = excluded.received_at,
          sort_at = excluded.sort_at,
          expires_at = excluded.expires_at,
          group_key = excluded.group_key,
          dedupe_key = excluded.dedupe_key,
          related_task_id = excluded.related_task_id,
          related_project_id = excluded.related_project_id,
          related_entity_type = excluded.related_entity_type,
          related_entity_id = excluded.related_entity_id,
          navigation_target = excluded.navigation_target,
          metadata = excluded.metadata,
          presentation = excluded.presentation
      `).run({
        ...notification,
        body: notification.body ?? null,
        templateKey: notification.templateKey ?? null,
        readAt: notification.readAt ?? null,
        handledAt: notification.handledAt ?? null,
        dismissedAt: notification.dismissedAt ?? null,
        resolvedAt: notification.resolvedAt ?? null,
        archivedAt: notification.archivedAt ?? null,
        mutedAt: notification.mutedAt ?? null,
        snoozedUntil: notification.snoozedUntil ?? null,
        sourceResolvedAt: notification.sourceResolvedAt ?? null,
        lastSourceActivityAt: notification.lastSourceActivityAt ?? null,
        lastSourceActivityKey: notification.lastSourceActivityKey ?? null,
        handledSourceActivityAt: notification.handledSourceActivityAt ?? null,
        handledSourceActivityKey: notification.handledSourceActivityKey ?? null,
        lastSourceSyncedAt: notification.lastSourceSyncedAt ?? null,
        isActionable: notification.isActionable ? 1 : 0,
        primaryActionId: notification.primaryActionId ?? null,
        aiSuggestedActionId: notification.aiSuggestedActionId ?? null,
        expiresAt: notification.expiresAt ?? null,
        groupKey: notification.groupKey ?? null,
        dedupeKey: notification.dedupeKey ?? null,
        relatedTaskId: notification.relatedTaskId ?? null,
        relatedProjectId: notification.relatedProjectId ?? null,
        relatedEntityType: notification.relatedEntityType ?? null,
        relatedEntityId: notification.relatedEntityId ?? null,
        navigationTarget: notification.navigationTarget ?? null,
        metadata: stringifyJson(notification.metadata),
        presentation: stringifyJson(notification.presentation),
      });

      const upsertAction = this.database.prepare(`
        INSERT INTO notification_actions (
          id, notification_id, action_type, label, icon, variant, is_primary,
          sort_order, payload, opens_external, requires_confirmation, created_by
        ) VALUES (
          @id, @notificationId, @actionType, @label, @icon, @variant, @isPrimary,
          @sortOrder, @payload, @opensExternal, @requiresConfirmation, @createdBy
        )
        ON CONFLICT(id) DO UPDATE SET
          action_type = excluded.action_type,
          label = excluded.label,
          icon = excluded.icon,
          variant = excluded.variant,
          is_primary = excluded.is_primary,
          sort_order = excluded.sort_order,
          payload = excluded.payload,
          opens_external = excluded.opens_external,
          requires_confirmation = excluded.requires_confirmation,
          created_by = excluded.created_by
        WHERE notification_actions.notification_id = excluded.notification_id
          AND notification_actions.execution_state = 'pending'
      `);
      for (const action of notification.actions ?? []) {
        if (action.notificationId !== notification.id) {
          throw new RepositoryError(
            'constraint',
            `Notification action ${action.id} belongs to another notification`,
          );
        }
        upsertAction.run({
          ...action,
          icon: action.icon ?? null,
          isPrimary: action.isPrimary ? 1 : 0,
          payload: stringifyJson(action.payload),
          opensExternal: action.opensExternal ? 1 : 0,
          requiresConfirmation: action.requiresConfirmation ? 1 : 0,
        });
      }
    });
    write.immediate();
    return this.getSync(notification.id)!;
  }

  async delete(id: string): Promise<boolean> {
    const remove = this.database.transaction(() => {
      this.database.prepare(
        'DELETE FROM notification_actions WHERE notification_id = ?',
      ).run(id);
      return this.database.prepare('DELETE FROM notifications WHERE id = ?').run(id)
        .changes === 1;
    });
    return remove.immediate();
  }
}

export class SqliteSettingsRepository implements AtomicSettingsRepository {
  constructor(private readonly database: SqliteDatabase) {}

  async get(key: string): Promise<PersistenceJson | null> {
    const row = this.database.prepare(
      'SELECT value FROM app_settings WHERE key = ?',
    ).get(key) as { value: unknown } | undefined;
    return row ? parseJson(row.value) as PersistenceJson : null;
  }

  async getMany(keys: readonly string[]): Promise<Record<string, PersistenceJson | null>> {
    const values = Object.fromEntries(keys.map((key) => [key, null])) as Record<
      string,
      PersistenceJson | null
    >;
    if (keys.length === 0) return values;
    const rows = this.database.prepare(`
      SELECT key, value
      FROM app_settings
      WHERE key IN (${keys.map(() => '?').join(', ')})
    `).all(...keys) as Array<{ key: string; value: unknown }>;
    for (const row of rows) values[row.key] = parseJson(row.value) as PersistenceJson;
    return values;
  }

  async set(key: string, value: PersistenceJson): Promise<void> {
    this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `).run(key, stringifyJson(value), new Date().toISOString());
  }

  async setMany(entries: ReadonlyArray<readonly [string, PersistenceJson]>): Promise<void> {
    if (entries.length === 0) return;
    if (new Set(entries.map(([key]) => key)).size !== entries.length) {
      throw new Error('Settings batch keys must be unique');
    }
    const upsert = this.database.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const write = this.database.transaction(() => {
      const now = new Date().toISOString();
      for (const [key, value] of entries) {
        upsert.run(key, stringifyJson(value), now);
      }
    });
    write.immediate();
  }

  async delete(key: string): Promise<boolean> {
    return this.database.prepare('DELETE FROM app_settings WHERE key = ?').run(key)
      .changes === 1;
  }

  async getActiveEmbeddingIdentity() {
    const row = this.database.prepare(`
      SELECT provider, model, dimensions, vector_count AS vectorCount
      FROM semantic_index_identities
      WHERE status = 'active'
      LIMIT 1
    `).get() as {
      provider: string;
      model: string;
      dimensions: number;
      vectorCount: number;
    } | undefined;
    return row ?? null;
  }
}

interface HoustonMemoryRow {
    id: string;
    authorizationScope: string;
    title: string;
    summary: string;
    decisions: unknown;
    commitments: unknown;
    topics: unknown;
    linkedEntities: unknown;
    sensitivity: HoustonConversationMemory['sensitivity'];
    retainUntil: string;
    excludedAt: string | null;
    createdAt: string;
    updatedAt: string;
  }

  const HOUSTON_MEMORY_COLUMNS = `
    id, authorization_scope AS authorizationScope, title, summary, decisions,
    commitments, topics, linked_entities AS linkedEntities, sensitivity,
    retain_until AS retainUntil, excluded_at AS excludedAt,
    created_at AS createdAt, updated_at AS updatedAt
  `;

  function parseStringList(value: unknown): string[] {
    const parsed = parseJson(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  }

  function parseHoustonMemory(row: HoustonMemoryRow): HoustonConversationMemory {
    const linkedEntities = parseJson(row.linkedEntities);
    return {
      ...row,
      decisions: parseStringList(row.decisions),
      commitments: parseStringList(row.commitments),
      topics: parseStringList(row.topics),
      linkedEntities: Array.isArray(linkedEntities)
        ? linkedEntities as HoustonMemoryEntityLink[]
        : [],
    };
  }

  export class SqliteHoustonMemoryRepository implements HoustonMemoryRepository {
    constructor(private readonly database: SqliteDatabase) {}

    async get(id: string, authorizationScope: string): Promise<HoustonConversationMemory | null> {
      const row = this.database.prepare(`
        SELECT ${HOUSTON_MEMORY_COLUMNS}
        FROM houston_conversation_memories
        WHERE id = ? AND authorization_scope = ?
      `).get(id, authorizationScope) as HoustonMemoryRow | undefined;
      return row ? parseHoustonMemory(row) : null;
    }

    async list(input: HoustonMemoryListRequest): Promise<HoustonConversationMemory[]> {
      const limit = Math.max(1, Math.min(Math.trunc(input.limit), 100));
      const rows = this.database.prepare(`
        SELECT ${HOUSTON_MEMORY_COLUMNS}
        FROM houston_conversation_memories
        WHERE authorization_scope = ?
          AND excluded_at IS NULL
          AND retain_until > ?
          AND updated_at < ?
        ORDER BY updated_at DESC, id ASC
        LIMIT ?
      `).all(
        input.authorizationScope,
        input.now,
        input.beforeUpdatedAt ?? '9999-12-31T23:59:59.999Z',
        limit,
      ) as HoustonMemoryRow[];
      return rows.map(parseHoustonMemory);
    }

    async upsert(input: HoustonConversationMemoryWrite): Promise<HoustonConversationMemory> {
      this.database.prepare(`
        INSERT INTO houston_conversation_memories (
          id, authorization_scope, title, summary, decisions, commitments, topics,
          linked_entities, sensitivity, retain_until, excluded_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          summary = excluded.summary,
          decisions = excluded.decisions,
          commitments = excluded.commitments,
          topics = excluded.topics,
          linked_entities = excluded.linked_entities,
          sensitivity = excluded.sensitivity,
          retain_until = excluded.retain_until,
          updated_at = excluded.updated_at
        WHERE houston_conversation_memories.authorization_scope = excluded.authorization_scope
          AND houston_conversation_memories.excluded_at IS NULL
      `).run(
        input.id,
        input.authorizationScope,
        input.title,
        input.summary,
        stringifyJson(input.decisions),
        stringifyJson(input.commitments),
        stringifyJson(input.topics),
        stringifyJson(input.linkedEntities),
        input.sensitivity,
        input.retainUntil,
        input.now,
        input.now,
      );
      const stored = await this.get(input.id, input.authorizationScope);
      if (!stored) throw new Error('Houston memory could not be persisted');
      return stored;
    }

    async exclude(id: string, authorizationScope: string, now: string): Promise<boolean> {
      return this.database.prepare(`
        UPDATE houston_conversation_memories
        SET excluded_at = ?, updated_at = ?
        WHERE id = ? AND authorization_scope = ? AND excluded_at IS NULL
      `).run(now, now, id, authorizationScope).changes === 1;
    }

    async delete(id: string, authorizationScope: string): Promise<boolean> {
      const now = new Date().toISOString();
      return this.database.prepare(`
        UPDATE houston_conversation_memories
        SET title = '', summary = '', decisions = '[]', commitments = '[]',
            topics = '[]', linked_entities = '[]', excluded_at = ?,
            retain_until = '9999-12-31T23:59:59.999Z', updated_at = ?
        WHERE id = ? AND authorization_scope = ?
      `).run(now, now, id, authorizationScope).changes === 1;
  }

  async deleteExpired(now: string, limit: number): Promise<string[]> {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    return this.database.transaction(() => {
      const rows = this.database.prepare(`
        SELECT id FROM houston_conversation_memories
        WHERE retain_until <= ?
        ORDER BY retain_until ASC, id ASC
        LIMIT ?
      `).all(now, boundedLimit) as Array<{ id: string }>;
      if (rows.length === 0) return [];
      this.database.prepare(`
        DELETE FROM houston_conversation_memories
        WHERE id IN (${rows.map(() => '?').join(', ')})
      `).run(...rows.map(({ id }) => id));
      return rows.map(({ id }) => id);
    }).immediate();
  }
}

export function createSqliteCorePersistenceRepositories(
  database: SqliteDatabase,
): CorePersistenceRepositories {
  return {
    tasks: new SqliteTaskRepository(database),
    projects: new SqliteProjectRepository(database),
    connectors: new SqliteConnectorRepository(database),
    notifications: new SqliteNotificationRepository(database),
    settings: new SqliteSettingsRepository(database),
    houstonMemories: new SqliteHoustonMemoryRepository(database),
  };
}
