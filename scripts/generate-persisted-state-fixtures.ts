import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { _runMigrationsIndividually } from '../src/db/bootstrap/sqlite-migrations';
import {
  PERSISTED_STATE_FIXTURES,
  PERSISTED_STATE_FIXTURE_VERSION,
  type PersistedStateFixture,
} from './persisted-state-fixture-manifest';
import { syntheticRetainedMigrationHash } from './sqlite-migration-history';

interface MigrationJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when?: number;
}

interface MigrationJournal {
  readonly version: string;
  readonly dialect: string;
  readonly entries: readonly MigrationJournalEntry[];
}

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_ROOT = join(REPOSITORY_ROOT, 'drizzle');
const DEFAULT_OUTPUT_DIRECTORY = join(
  REPOSITORY_ROOT,
  'tests',
  'fixtures',
  'persisted-state',
  'sqlite',
);
const FIXTURE_TIMESTAMP = '2026-01-15T12:00:00.000Z';

function readJournal(): MigrationJournal {
  return JSON.parse(
    readFileSync(join(MIGRATIONS_ROOT, 'meta', '_journal.json'), 'utf8'),
  ) as MigrationJournal;
}

function normalizedMigrationSql(tag: string): string {
  return readFileSync(join(MIGRATIONS_ROOT, `${tag}.sql`), 'utf8')
    .replace(/\r\n?/g, '\n');
}

function migrationHash(tag: string): string {
  return createHash('sha256')
    .update(normalizedMigrationSql(tag))
    .digest('hex');
}

function createCheckpointMigrationDirectory(
  root: string,
  fixture: PersistedStateFixture,
): { directory: string; entries: readonly MigrationJournalEntry[] } {
  const journal = readJournal();
  const checkpointIndex = journal.entries.findIndex(
    (entry) => entry.tag === fixture.checkpointTag,
  );
  if (checkpointIndex < 0) {
    throw new Error(`Unknown fixture checkpoint: ${fixture.checkpointTag}`);
  }

  const directory = join(root, fixture.id, 'migrations');
  mkdirSync(join(directory, 'meta'), { recursive: true });
  const entries = journal.entries.slice(0, checkpointIndex + 1);
  writeFileSync(
    join(directory, 'meta', '_journal.json'),
    `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
  );
  for (const entry of entries) {
    writeFileSync(
      join(directory, `${entry.tag}.sql`),
      normalizedMigrationSql(entry.tag),
    );
  }
  return { directory, entries };
}

function tableExists(sqlite: Database.Database, table: string): boolean {
  return sqlite.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) !== undefined;
}

function tableColumns(sqlite: Database.Database, table: string): Set<string> {
  return new Set(
    (sqlite.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as Array<{
      name: string;
    }>).map((row) => row.name),
  );
}

function persistedValue(value: unknown): string | number | null {
  if (value === null || typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return JSON.stringify(value);
}

function createHistoricalPriorityEntityLayout(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.includesHistoricalPriorityEntityLayout) return;
  sqlite.exec(`
    CREATE TABLE priority_entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      description TEXT,
      tier TEXT NOT NULL DEFAULT 'standard',
      color TEXT NOT NULL DEFAULT '#64748b',
      rank INTEGER NOT NULL DEFAULT 0,
      active_task_count INTEGER NOT NULL DEFAULT 0,
      last_touched_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    ALTER TABLE priority_entities ADD COLUMN reference_id TEXT;
    CREATE INDEX idx_priority_entities_tier ON priority_entities(tier);
    CREATE INDEX idx_priority_entities_rank ON priority_entities(rank);
  `);
}

function createHistoricalInboundWebhookLayout(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.includesHistoricalInboundWebhookLayout) return;
  sqlite.exec(`
    CREATE TABLE inbound_webhooks (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      source_label TEXT NOT NULL DEFAULT 'webhook',
      secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      default_action TEXT NOT NULL DEFAULT 'auto',
      field_mappings TEXT NOT NULL DEFAULT '{}',
      total_received INTEGER NOT NULL DEFAULT 0,
      last_received_at TEXT,
      last_status INTEGER,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
}

function insertRow(
  sqlite: Database.Database,
  table: string,
  values: Readonly<Record<string, unknown>>,
): void {
  if (!tableExists(sqlite, table)) return;
  const columns = tableColumns(sqlite, table);
  const entries = Object.entries(values).filter(([column]) => columns.has(column));
  const quotedColumns = entries.map(([column]) => `"${column}"`).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  sqlite.prepare(
    `INSERT INTO "${table}" (${quotedColumns}) VALUES (${placeholders})`,
  ).run(...entries.map(([, value]) => persistedValue(value)));
}

function seedCoreState(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  const origin = fixture.checkpointTag;
  insertRow(sqlite, 'connector_configs', {
    id: fixture.connectorId,
    type: fixture.includesPreNodeIdCutoverState ? 'github-issues' : 'synthetic',
    name: `Synthetic connector ${origin}`,
    enabled: true,
    sync_mode: 'poll',
    poll_interval_minutes: 15,
    capabilities: { pull: true, synthetic: true },
    credentials: {},
    settings: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION, origin },
    synced_lists: [],
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'hub_projects', {
    id: fixture.projectId,
    name: `Synthetic project ${origin}`,
    description: 'Deterministic persisted-state compatibility fixture',
    color: '#3b82f6',
    source_bindings: [],
    auto_include_rules: [],
    kanban_columns: [],
    default_view: 'list',
    status: 'active',
    hidden: false,
    hierarchy_revision: 2,
    metadata: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION, origin },
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'tasks', {
    id: fixture.taskId,
    source_id: `synthetic:${fixture.id}`,
    connector_type: fixture.includesPreNodeIdCutoverState ? 'github-issues' : 'synthetic',
    connector_instance_id: fixture.connectorId,
    title: `Synthetic ${fixture.searchToken} task`,
    description: 'Synthetic task content for persisted-state compatibility testing',
    status: 'in_progress',
    local_disposition: 'active',
    priority: 'high',
    push_count: 2,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    depth: 0,
    is_checklist_item: false,
    source_list_id: `fixture-list-${fixture.id}`,
    source_list_name: 'Synthetic fixture list',
    metadata: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION, origin },
    sync_status: 'synced',
    last_synced_at: FIXTURE_TIMESTAMP,
    push_retry_count: 0,
    is_bulk_import: false,
  });
  insertRow(sqlite, 'task_projects', {
    task_id: fixture.taskId,
    project_id: fixture.projectId,
  });
  insertRow(sqlite, 'app_settings', {
    key: fixture.settingKey,
    value: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION, origin },
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'sync_log', {
    id: fixture.syncLogId,
    connector_id: fixture.connectorId,
    success: true,
    tasks_added: 1,
    tasks_updated: 2,
    tasks_removed: 0,
    tasks_pushed: 1,
    local_only_protected: 0,
    alerts_added: fixture.notificationId ? 1 : 0,
    errors: [],
    details: [{ action: 'synthetic-fixture' }],
    synced_at: FIXTURE_TIMESTAMP,
    duration_ms: 125,
    trigger: 'api',
    attempt: 1,
    max_attempts: 3,
  });
  if (fixture.includesHistoricalPriorityEntityLayout) {
    insertRow(sqlite, 'priority_entities', {
      id: `fixture-priority-entity-${fixture.id}`,
      name: 'Synthetic historical priority entity',
      type: 'project',
      description: 'Persisted before reference_id was added by the runtime safety net',
      tier: 'high',
      color: '#3b82f6',
      rank: 1,
      active_task_count: 1,
      created_at: FIXTURE_TIMESTAMP,
      updated_at: FIXTURE_TIMESTAMP,
      reference_id: fixture.projectId,
    });
  }
}

function seedNotificationAndQueueState(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.notificationId || !fixture.syncJobId) return;
  insertRow(sqlite, 'notifications', {
    id: fixture.notificationId,
    source_id: `synthetic-notification:${fixture.id}`,
    connector_type: 'synthetic',
    connector_instance_id: fixture.connectorId,
    title: `Synthetic ${fixture.searchToken} notification`,
    body: 'Synthetic notification body for persisted-state compatibility testing',
    level: 'attention',
    level_rank: 2,
    category: 'sync',
    state: 'unread',
    read_state: 'unread',
    disposition: 'inbox',
    source_state: 'active',
    sync_state: 'synced',
    is_actionable: true,
    received_at: FIXTURE_TIMESTAMP,
    sort_at: FIXTURE_TIMESTAMP,
    related_task_id: fixture.taskId,
    related_project_id: fixture.projectId,
    reconcile_attempts: 0,
    metadata: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION },
    presentation: {},
  });
  insertRow(sqlite, 'sync_jobs', {
    id: fixture.syncJobId,
    connector_id: fixture.connectorId,
    full: false,
    source: 'api',
    status: 'queued',
    attempt: 1,
    max_attempts: 3,
    available_at: FIXTURE_TIMESTAMP,
    scheduled_for: FIXTURE_TIMESTAMP,
    duration_budget_ms: 300000,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'sync_job_events', {
    job_id: fixture.syncJobId,
    connector_id: fixture.connectorId,
    event_type: 'queued',
    payload: { fixtureVersion: PERSISTED_STATE_FIXTURE_VERSION },
    created_at: FIXTURE_TIMESTAMP,
  });
}

function seedPreNodeIdCutoverState(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  if (!fixture.includesPreNodeIdCutoverState) return;
  insertRow(sqlite, 'github_identity_migrations', {
    connector_instance_id: fixture.connectorId,
    phase: 'complete',
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'github_identity_controls', {
    connector_instance_id: fixture.connectorId,
    stable_primary_enabled: true,
    mode_revision: 7,
    updated_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'github_identity_comparison_runs', {
    id: 'fixture-comparison-run-0104',
    connector_instance_id: fixture.connectorId,
    identity_mode: 'stable',
    identity_mode_revision: 7,
    sync_kind: 'full',
    state: 'succeeded',
    evidence_eligible: true,
    started_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'github_identity_comparison_records', {
    id: 'fixture-comparison-record-0104',
    run_id: 'fixture-comparison-run-0104',
    surface: 'task',
    candidate_key: 'synthetic-candidate',
    local_task_id: fixture.taskId,
    legacy_action: 'present',
    stable_action: 'present',
    outcome: 'agreement',
    reason: 'exact_match',
    created_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'github_identity_sub_issue_population_members', {
    id: 'fixture-population-member-0104',
    run_id: 'fixture-comparison-run-0104',
    local_task_id: fixture.taskId,
    source_id_digest: 'a'.repeat(64),
    issue_number: 1622,
    member_digest: 'b'.repeat(64),
    observed: true,
    created_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'github_identity_write_cycles', {
    id: 'fixture-write-cycle-0104',
    connector_instance_id: fixture.connectorId,
    comparison_run_id: 'fixture-comparison-run-0104',
    effective_mode: 'stable',
    mode_revision: 7,
    pending_candidate_count: 1,
    observed_route_count: 1,
    legacy_applied_count: 0,
    blocked_count: 0,
    failed_count: 0,
    unknown_count: 0,
    state: 'completed',
    reconciliation_state: 'resolved',
    started_at: FIXTURE_TIMESTAMP,
    completed_at: FIXTURE_TIMESTAMP,
  });
  insertRow(sqlite, 'task_source_write_leases', {
    id: 'fixture-write-lease-0104',
    token: 'synthetic-token-0104',
    connector_instance_id: fixture.connectorId,
    task_id: fixture.taskId,
    operation: 'update',
    task_version: 'synthetic-v1',
    idempotency_key: 'synthetic-idempotency-0104',
    effective_mode: 'stable',
    mode_revision: 7,
    comparison_run_id: 'fixture-comparison-run-0104',
    write_cycle_id: 'fixture-write-cycle-0104',
    route: 'legacy',
    identity_route: 'stable',
    state: 'succeeded',
    cycle_observed_at: FIXTURE_TIMESTAMP,
    cycle_outcome: 'succeeded',
    dispatched_at: FIXTURE_TIMESTAMP,
    finalized_at: FIXTURE_TIMESTAMP,
    expires_at: '2026-01-15T13:00:00.000Z',
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
  });
}

function seedPersistedSearchProjection(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
): void {
  sqlite.exec(`
    CREATE VIRTUAL TABLE tasks_fts USING fts5(
      title,
      description,
      sourceListName,
      connectorType,
      entityId UNINDEXED
    );
    CREATE VIRTUAL TABLE alerts_fts USING fts5(
      title,
      body,
      category,
      entityId UNINDEXED
    );
  `);
  sqlite.prepare(`
    INSERT INTO tasks_fts (title, description, sourceListName, connectorType, entityId)
    VALUES (?, ?, ?, ?, ?)
  `).run('Stale projection', '', '', 'synthetic', fixture.taskId);
  if (fixture.notificationId) {
    sqlite.prepare(`
      INSERT INTO alerts_fts (title, body, category, entityId)
      VALUES (?, ?, ?, ?)
    `).run('Stale projection', '', 'sync', fixture.notificationId);
  }
}

function normalizeGeneratedFixtureValues(sqlite: Database.Database): void {
  if (tableExists(sqlite, 'task_history_events')) {
    const immutableTrigger = sqlite.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'trigger' AND name = 'task_history_immutable_update'
    `).pluck().get() as string | undefined;
    if (immutableTrigger) sqlite.exec('DROP TRIGGER task_history_immutable_update');
    sqlite.prepare(`
      UPDATE task_history_events
      SET occurred_at = ?, recorded_at = ?
    `).run(FIXTURE_TIMESTAMP, FIXTURE_TIMESTAMP);
    if (immutableTrigger) sqlite.exec(immutableTrigger);
  }
}

function assertCheckpointApplied(
  sqlite: Database.Database,
  entries: readonly MigrationJournalEntry[],
): void {
  const applied = new Set(
    (sqlite.prepare('SELECT hash FROM __drizzle_migrations').all() as Array<{
      hash: string;
    }>).map((row) => row.hash),
  );
  const missing = entries
    .map((entry) => ({ tag: entry.tag, hash: migrationHash(entry.tag) }))
    .filter((entry) => !applied.has(entry.hash));
  if (missing.length > 0) {
    throw new Error(
      `Fixture checkpoint failed before ${missing.map((entry) => entry.tag).join(', ')}`,
    );
  }
}

function seedRetainedHistoricalMigrationRows(
  sqlite: Database.Database,
  fixture: PersistedStateFixture,
  entries: readonly MigrationJournalEntry[],
): void {
  const count = fixture.retainedHistoricalMigrationRows ?? 0;
  if (count === 0) return;
  const historicalTimestamp = Math.min(
    ...entries.map((entry) => entry.when ?? 0),
  );
  const insert = sqlite.prepare(
    'INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)',
  );
  for (let index = 0; index < count; index += 1) {
    insert.run(
      syntheticRetainedMigrationHash(fixture.id, index),
      historicalTimestamp,
    );
  }
}

function buildFixture(
  fixture: PersistedStateFixture,
  outputDirectory: string,
  temporaryRoot: string,
): void {
  const destination = join(outputDirectory, fixture.fileName);
  const pendingDestination = `${destination}.pending`;
  mkdirSync(outputDirectory, { recursive: true });
  if (existsSync(pendingDestination)) rmSync(pendingDestination);

  const checkpoint = createCheckpointMigrationDirectory(temporaryRoot, fixture);
  const sqlite = new Database(pendingDestination);
  let buildError: unknown;
  try {
    sqlite.pragma('foreign_keys = ON');
    createHistoricalInboundWebhookLayout(sqlite, fixture);
    _runMigrationsIndividually(sqlite, checkpoint.directory);
    assertCheckpointApplied(sqlite, checkpoint.entries);
    seedRetainedHistoricalMigrationRows(sqlite, fixture, checkpoint.entries);
    createHistoricalPriorityEntityLayout(sqlite, fixture);
    sqlite.transaction(() => {
      seedCoreState(sqlite, fixture);
      seedNotificationAndQueueState(sqlite, fixture);
      seedPreNodeIdCutoverState(sqlite, fixture);
      seedPersistedSearchProjection(sqlite, fixture);
      normalizeGeneratedFixtureValues(sqlite);
    })();
    sqlite.pragma('journal_mode = DELETE');
    sqlite.exec('VACUUM');
  } catch (error) {
    buildError = error;
  } finally {
    sqlite.close();
  }
  if (buildError) {
    rmSync(pendingDestination, { force: true });
    throw buildError;
  }
  renameSync(pendingDestination, destination);
}

function assertReplaceableFixtureDirectory(outputDirectory: string): void {
  if (!existsSync(outputDirectory)) return;

  const entries = readdirSync(outputDirectory, { withFileTypes: true });
  if (entries.length === 0) return;

  const expectedFileNames = new Set(
    PERSISTED_STATE_FIXTURES.map((fixture) => fixture.fileName),
  );
  const isCompleteCorpus = (
    entries.length === expectedFileNames.size
    && entries.every((entry) => (
      entry.isFile() && expectedFileNames.has(entry.name)
    ))
  );
  if (!isCompleteCorpus) {
    throw new Error(
      `Refusing to replace non-corpus output directory: ${outputDirectory}`,
    );
  }
}

function publishFixtureCorpus(
  stagedDirectory: string,
  outputDirectory: string,
): void {
  const outputParent = dirname(outputDirectory);
  const outputName = basename(outputDirectory);
  let backup: { root: string; directory: string } | undefined;

  if (existsSync(outputDirectory)) {
    const root = mkdtempSync(join(outputParent, `.${outputName}-backup-`));
    const directory = join(root, outputName);
    backup = { root, directory };
    renameSync(outputDirectory, directory);
  }

  try {
    renameSync(stagedDirectory, outputDirectory);
  } catch (publicationError) {
    if (backup) {
      try {
        renameSync(backup.directory, outputDirectory);
        rmSync(backup.root, { recursive: true, force: true });
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          `Fixture publication failed and the previous corpus remains at ${backup.directory}`,
        );
      }
    }
    throw publicationError;
  }

  if (backup) rmSync(backup.root, { recursive: true, force: true });
}

export function generatePersistedStateFixtures(
  outputDirectory = DEFAULT_OUTPUT_DIRECTORY,
): void {
  const resolvedOutputDirectory = resolve(outputDirectory);
  const outputParent = dirname(resolvedOutputDirectory);
  const outputName = basename(resolvedOutputDirectory);
  mkdirSync(outputParent, { recursive: true });
  assertReplaceableFixtureDirectory(resolvedOutputDirectory);
  const stagedDirectory = mkdtempSync(
    join(outputParent, `.${outputName}-staging-`),
  );
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'mc-persisted-state-fixtures-'));
  try {
    for (const fixture of PERSISTED_STATE_FIXTURES) {
      buildFixture(fixture, stagedDirectory, temporaryRoot);
    }
    publishFixtureCorpus(stagedDirectory, resolvedOutputDirectory);
  } finally {
    rmSync(stagedDirectory, { recursive: true, force: true });
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (
  process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const outputArgument = process.argv.find((argument) => argument.startsWith('--output='));
  const outputDirectory = outputArgument
    ? resolve(outputArgument.slice('--output='.length))
    : DEFAULT_OUTPUT_DIRECTORY;
  generatePersistedStateFixtures(outputDirectory);
}
