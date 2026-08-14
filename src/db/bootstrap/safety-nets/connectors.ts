import type Database from 'better-sqlite3';

export function applyListGroupTableSafetyNet(_sqlite: Database.Database): void {
  _sqlite.exec(`
    CREATE TABLE IF NOT EXISTS list_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
}

export function applyConnectorConfigDeletedAtSafetyNet(_sqlite: Database.Database): void {
  // Migrate connector_configs table: add deleted_at for soft delete
  const connectorConfigColumns = _sqlite.prepare("PRAGMA table_info('connector_configs')").all() as Array<{ name: string }>;
  if (connectorConfigColumns.length > 0 && !connectorConfigColumns.some((column) => column.name === 'deleted_at')) {
    _sqlite.exec('ALTER TABLE connector_configs ADD COLUMN deleted_at TEXT');
  }
}

export function applyConnectorSourceListColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate list_groups table: add source_id for remote group correlation
  const listGroupColumns = _sqlite.prepare("PRAGMA table_info('list_groups')").all() as Array<{ name: string }>;
  if (listGroupColumns.length > 0 && !listGroupColumns.some((column) => column.name === 'source_id')) {
    _sqlite.exec('ALTER TABLE list_groups ADD COLUMN source_id TEXT');
  }
  if (listGroupColumns.length > 0 && !listGroupColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE list_groups ADD COLUMN icon_color TEXT');
  }

  const sourceListColumns = _sqlite.prepare("PRAGMA table_info('source_lists')").all() as Array<{ name: string }>;
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'group_id')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN group_id TEXT REFERENCES list_groups(id) ON DELETE SET NULL');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'well_known_list_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN well_known_list_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'sort_order')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'hidden')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'last_known_remote_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN last_known_remote_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'user_display_name')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN user_display_name TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'icon')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN icon TEXT');
  }
  if (sourceListColumns.length > 0 && !sourceListColumns.some((column) => column.name === 'icon_color')) {
    _sqlite.exec('ALTER TABLE source_lists ADD COLUMN icon_color TEXT');
  }
}

export function applyConnectorSyncLogColumnSafetyNets(_sqlite: Database.Database): void {
  // Migrate sync_log table: add new audit columns
  const syncLogColumns = _sqlite.prepare("PRAGMA table_info('sync_log')").all() as Array<{ name: string }>;
  if (syncLogColumns.length > 0) {
    if (!syncLogColumns.some((column) => column.name === 'tasks_pushed')) {
      _sqlite.exec('ALTER TABLE sync_log ADD COLUMN tasks_pushed INTEGER NOT NULL DEFAULT 0');
    }
    if (!syncLogColumns.some((column) => column.name === 'local_only_protected')) {
      _sqlite.exec('ALTER TABLE sync_log ADD COLUMN local_only_protected INTEGER NOT NULL DEFAULT 0');
    }
    if (!syncLogColumns.some((column) => column.name === 'details')) {
      _sqlite.exec("ALTER TABLE sync_log ADD COLUMN details TEXT NOT NULL DEFAULT '[]'");
    }
  }
}
