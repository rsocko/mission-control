/**
 * Seed API — importable functions for seeding/clearing the database.
 * Used by the mode toggle API route. Provides rich, realistic demo data
 * spanning multiple projects, priorities, sources, and time ranges.
 */
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SAMPLE_TRIAGE_ITEMS } from '@/lib/triage/seed-data';

const DB_PATH = path.resolve(process.cwd(), process.env.MC_DB_PATH || './data/mission-control.db');

function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  return db;
}

interface TableListRow {
  schema: string;
  name: string;
  type: string;
}

function listUserDataTables(
  db: Database.Database,
  preserveTaskHistory: boolean,
): TableListRow[] {
  return (db.pragma('table_list') as TableListRow[])
    .filter(({ schema, name, type }) => (
      schema === 'main'
      && (type === 'table' || type === 'virtual')
      && !name.startsWith('sqlite_')
      && name !== '__drizzle_migrations'
      && (!preserveTaskHistory || name !== 'task_history_events')
    ));
}

function deleteTables(db: Database.Database, tables: TableListRow[]): void {
  for (const { name } of tables) {
    const quotedName = name.replaceAll('"', '""');
    db.exec(`DELETE FROM "${quotedName}"`);
  }
}

function createTaskHistoryDeleteTrigger(db: Database.Database): void {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS task_history_immutable_delete
    BEFORE DELETE ON task_history_events
    BEGIN
      SELECT RAISE(ABORT, 'task_history_events is append-only');
    END
  `);
}

export function clearUserDataTables(db: Database.Database): void {
  const tables = listUserDataTables(db, true);
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;

  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => deleteTables(db, tables))();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
  }
}

// Read configured timezone from settings (same as getTimezone() in mode.ts)
function getConfiguredTimezone(): string {
  try {
    const settingsPath = path.resolve(process.cwd(), 'data/settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      if (settings.timezone) return settings.timezone;
    }
  } catch { /* fall through */ }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

function localDate(offsetDays = 0): string {
  const tz = getConfiguredTimezone();
  const d = new Date();
  if (offsetDays !== 0) d.setDate(d.getDate() + offsetDays);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Clear all user data from the database (keeps schema intact)
 */
export async function clearDatabase(): Promise<void> {
  const db = getDb();
  try {
    clearUserDataTables(db);
  } finally {
    db.close();
  }
}

/**
 * Populate the database with realistic demo data
 */
function seedDatabaseContents(db: Database.Database): void {
    const now = new Date().toISOString();
    const daysAgo = (n: number) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); };
    const daysFromNow = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString(); };
    const hoursAgo = (n: number) => new Date(Date.now() - n * 3600000).toISOString();
    const today = localDate();

    // ─── TAGS ───
    const tags = [
      { id: 'tag-bug', name: 'bug', slug: 'bug', type: 'source', source: 'github-issues', color: '#d73a4a', confirmed: 1 },
      { id: 'tag-enhancement', name: 'enhancement', slug: 'enhancement', type: 'source', source: 'github-issues', color: '#a2eeef', confirmed: 1 },
      { id: 'tag-documentation', name: 'documentation', slug: 'documentation', type: 'source', source: 'github-issues', color: '#0075ca', confirmed: 1 },
      { id: 'tag-priority-high', name: 'priority: high', slug: 'priority-high', type: 'source', source: 'github-issues', color: '#e11d48', confirmed: 1 },
      { id: 'tag-good-first-issue', name: 'good first issue', slug: 'good-first-issue', type: 'source', source: 'github-issues', color: '#7057ff', confirmed: 1 },
      { id: 'tag-personal', name: 'Personal', slug: 'personal', type: 'source', source: 'microsoft-todo', color: '#f59e0b', confirmed: 1 },
      { id: 'tag-work', name: 'Work', slug: 'work', type: 'source', source: 'microsoft-todo', color: '#3b82f6', confirmed: 1 },
      { id: 'tag-errand', name: 'Errand', slug: 'errand', type: 'source', source: 'microsoft-todo', color: '#10b981', confirmed: 1 },
      { id: 'tag-health', name: 'Health', slug: 'health', type: 'source', source: 'microsoft-todo', color: '#ec4899', confirmed: 1 },
      { id: 'tag-finance', name: 'Finance', slug: 'finance', type: 'source', source: 'microsoft-todo', color: '#14b8a6', confirmed: 1 },
      { id: 'tag-focus', name: 'Focus', slug: 'focus', type: 'hub', source: null, color: '#8b5cf6', confirmed: 1 },
      { id: 'tag-blocked', name: 'Blocked', slug: 'blocked', type: 'hub', source: null, color: '#ef4444', confirmed: 1 },
      { id: 'tag-quick-win', name: 'Quick Win', slug: 'quick-win', type: 'hub', source: null, color: '#22c55e', confirmed: 1 },
      { id: 'tag-delegate', name: 'Delegate', slug: 'delegate', type: 'hub', source: null, color: '#f97316', confirmed: 1 },
      { id: 'tag-waiting', name: 'Waiting On', slug: 'waiting-on', type: 'hub', source: null, color: '#a855f7', confirmed: 1 },
      { id: 'tag-ai-overdue-risk', name: 'Overdue Risk', slug: 'overdue-risk', type: 'ai-inferred', source: 'ai', color: '#dc2626', confirmed: 0 },
      { id: 'tag-ai-related-group', name: 'Related: Auth', slug: 'related-auth', type: 'ai-inferred', source: 'ai', color: '#6366f1', confirmed: 0 },
      { id: 'tag-ai-batch', name: 'Batchable', slug: 'batchable', type: 'ai-inferred', source: 'ai', color: '#0ea5e9', confirmed: 0 },
    ];

    const insertTag = db.prepare(
      'INSERT INTO tags (id, name, slug, type, source, color, confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const t of tags) {
      insertTag.run(t.id, t.name, t.slug, t.type, t.source, t.color, t.confirmed, now);
    }

    // ─── CONNECTORS ───
    const connectors = [
      {
        id: 'mstodo-1', type: 'microsoft-todo', name: 'Microsoft To Do (Personal)', enabled: 1,
        syncMode: 'poll', pollInterval: 5,
        capabilities: JSON.stringify({ read: true, write: true, delete: true, sync: true, subtasks: true, lists: true, listSelectionMode: 'optional' }),
        credentials: '{}',
        settings: '{}',
        syncedLists: JSON.stringify(['personal-list', 'work-list', 'groceries', 'home-renovation', 'fitness']),
      },
      {
        id: 'github-1', type: 'github-issues', name: 'GitHub (Personal)', enabled: 1,
        syncMode: 'poll', pollInterval: 10,
        capabilities: JSON.stringify({ read: true, write: true, delete: false, sync: true, subtasks: true, lists: true, listSelectionMode: 'required' }),
        credentials: '{}',
        settings: JSON.stringify({ repos: ['acme/project-alpha', 'acme/dotfiles', 'acme/home-assistant-config'] }),
        syncedLists: JSON.stringify(['acme/project-alpha', 'acme/dotfiles', 'acme/home-assistant-config']),
      },
      {
        id: 'github-2', type: 'github-issues', name: 'GitHub (Work)', enabled: 1,
        syncMode: 'poll', pollInterval: 10,
        capabilities: JSON.stringify({ read: true, write: true, delete: false, sync: true, subtasks: true, lists: true, listSelectionMode: 'required' }),
        credentials: '{}',
        settings: JSON.stringify({ repos: ['acme-corp/api-gateway', 'acme-corp/web-dashboard'] }),
        syncedLists: JSON.stringify(['acme-corp/api-gateway', 'acme-corp/web-dashboard']),
      },
      {
        id: 'scout-demo', type: 'scout', name: 'Scout (Read-only)', enabled: 1,
        syncMode: 'poll', pollInterval: 30,
        capabilities: JSON.stringify({ read: true, write: false, delete: false, sync: true, subtasks: false, lists: true, listSelectionMode: 'optional' }),
        credentials: '{}',
        settings: JSON.stringify({
          reconciliation: {
            enabled: true,
            autoCompleteThreshold: 0.95,
            suggestionThreshold: 0.75,
          },
        }),
        syncedLists: JSON.stringify(['scout-follow-ups']),
      },
    ];

    const insertConnector = db.prepare(
      'INSERT INTO connector_configs (id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities, credentials, settings, synced_lists, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const c of connectors) {
      insertConnector.run(c.id, c.type, c.name, c.enabled, c.syncMode, c.pollInterval, c.capabilities, c.credentials, c.settings, c.syncedLists, now, now);
    }

    // ─── SOURCE LISTS ───
    const sourceLists = [
      { id: 'sl-1', connectorInstanceId: 'mstodo-1', sourceId: 'personal-list', name: 'Personal', type: 'list', taskCount: 12 },
      { id: 'sl-2', connectorInstanceId: 'mstodo-1', sourceId: 'work-list', name: 'Work', type: 'list', taskCount: 8 },
      { id: 'sl-3', connectorInstanceId: 'mstodo-1', sourceId: 'groceries', name: 'Groceries', type: 'list', taskCount: 6 },
      { id: 'sl-4', connectorInstanceId: 'mstodo-1', sourceId: 'home-renovation', name: 'Home Renovation', type: 'list', taskCount: 9 },
      { id: 'sl-5', connectorInstanceId: 'mstodo-1', sourceId: 'fitness', name: 'Fitness & Health', type: 'list', taskCount: 4 },
      { id: 'sl-6', connectorInstanceId: 'github-1', sourceId: 'acme/project-alpha', name: 'acme/project-alpha', type: 'repo', taskCount: 12 },
      { id: 'sl-7', connectorInstanceId: 'github-1', sourceId: 'acme/dotfiles', name: 'acme/dotfiles', type: 'repo', taskCount: 3 },
      { id: 'sl-8', connectorInstanceId: 'github-1', sourceId: 'acme/home-assistant-config', name: 'acme/home-assistant-config', type: 'repo', taskCount: 4 },
      { id: 'sl-9', connectorInstanceId: 'github-2', sourceId: 'acme-corp/api-gateway', name: 'acme-corp/api-gateway', type: 'repo', taskCount: 7 },
      { id: 'sl-10', connectorInstanceId: 'github-2', sourceId: 'acme-corp/web-dashboard', name: 'acme-corp/web-dashboard', type: 'repo', taskCount: 5 },
      { id: 'sl-11', connectorInstanceId: 'scout-demo', sourceId: 'scout-follow-ups', name: 'Scout Follow-ups', type: 'list', taskCount: 2 },
    ];

    const insertSourceList = db.prepare(
      'INSERT INTO source_lists (id, connector_instance_id, source_id, name, type, task_count, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const sl of sourceLists) {
      insertSourceList.run(sl.id, sl.connectorInstanceId, sl.sourceId, sl.name, sl.type, sl.taskCount, now);
    }

    // ─── HUB PROJECTS ───
    const hubProjects = [
      { id: 'proj-home', name: 'Home & Life', description: 'Personal errands, home improvement, health', color: '#10b981', icon: '🏠', sourceBindings: JSON.stringify([{ connectorInstanceId: 'mstodo-1', sourceListId: 'personal-list' }]), autoIncludeRules: JSON.stringify([{ type: 'tag', value: 'Personal' }]), kanbanColumns: '[]', defaultView: 'list' },
      { id: 'proj-mission-control', name: 'Mission Control', description: 'Building the personal task aggregation hub', color: '#6366f1', icon: '🎯', sourceBindings: JSON.stringify([{ connectorInstanceId: 'github-1', sourceListId: 'acme/project-alpha' }]), autoIncludeRules: JSON.stringify([{ type: 'source', value: 'acme/project-alpha' }]), kanbanColumns: JSON.stringify([{id:'backlog',name:'Backlog',color:'#6b7280',order:0},{id:'in-progress',name:'In Progress',color:'#3b82f6',order:1},{id:'review',name:'Review',color:'#f59e0b',order:2},{id:'done',name:'Done',color:'#22c55e',order:3}]), defaultView: 'kanban' },
      { id: 'proj-work', name: 'Work — Acme Corp', description: 'Professional tasks, PRs, and meetings', color: '#3b82f6', icon: '💼', sourceBindings: JSON.stringify([{ connectorInstanceId: 'mstodo-1', sourceListId: 'work-list' }, { connectorInstanceId: 'github-2' }]), autoIncludeRules: JSON.stringify([{ type: 'tag', value: 'Work' }]), kanbanColumns: '[]', defaultView: 'list' },
      { id: 'proj-kitchen-reno', name: 'Kitchen Renovation', description: 'Full kitchen remodel — cabinets, countertops, appliances, backsplash', color: '#f59e0b', icon: '🔨', sourceBindings: JSON.stringify([{ connectorInstanceId: 'mstodo-1', sourceListId: 'home-renovation' }]), autoIncludeRules: JSON.stringify([]), kanbanColumns: JSON.stringify([{id:'planning',name:'Planning',color:'#6b7280',order:0},{id:'ordered',name:'Ordered',color:'#f59e0b',order:1},{id:'in-progress',name:'In Progress',color:'#3b82f6',order:2},{id:'done',name:'Done',color:'#22c55e',order:3}]), defaultView: 'kanban' },
      { id: 'proj-3d-printing', name: '3D Printing Projects', description: 'Desk organizer, plant pots, and custom enclosures', color: '#ec4899', icon: '🖨️', sourceBindings: JSON.stringify([{ connectorInstanceId: 'mstodo-1', sourceListId: 'personal-list' }]), autoIncludeRules: JSON.stringify([]), kanbanColumns: '[]', defaultView: 'list' },
      { id: 'proj-smart-home', name: 'Smart Home Automation', description: 'Home Assistant config, new sensors, automations', color: '#0ea5e9', icon: '🏡', sourceBindings: JSON.stringify([{ connectorInstanceId: 'github-1', sourceListId: 'acme/home-assistant-config' }]), autoIncludeRules: JSON.stringify([]), kanbanColumns: '[]', defaultView: 'list' },
    ];

    const insertProject = db.prepare(
      'INSERT INTO hub_projects (id, name, description, color, icon, source_bindings, auto_include_rules, kanban_columns, default_view, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const p of hubProjects) {
      insertProject.run(p.id, p.name, p.description, p.color, p.icon, p.sourceBindings, p.autoIncludeRules, p.kanbanColumns, p.defaultView, now, now);
    }

    // ─── TASKS ───
    interface TaskSeed { id: string; sourceId: string; connectorType: string; connectorInstanceId: string; title: string; status: string; priority: string; dueDate?: string | null; sourceListId: string; sourceListName: string; tagIds: string[]; projectIds?: string[]; completedAt?: string | null; parentId?: string | null; depth?: number; isChecklistItem?: boolean; }
    const taskData: TaskSeed[] = [
      // ────── MS Todo — Personal (12 tasks) ──────
      { id: 't-1', sourceId: 'personal-list:task-001', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Schedule dentist appointment', status: 'todo', priority: 'medium', dueDate: daysFromNow(3), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-health'], projectIds: ['proj-home'] },
      { id: 't-2', sourceId: 'personal-list:task-002', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Renew car registration', status: 'todo', priority: 'high', dueDate: daysFromNow(1), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-errand'], projectIds: ['proj-home'] },
      { id: 't-3', sourceId: 'personal-list:task-003', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Order birthday gift for Mom', status: 'todo', priority: 'high', dueDate: daysFromNow(5), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-home'] },
      { id: 't-4', sourceId: 'personal-list:task-004', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Call insurance company about claim', status: 'in_progress', priority: 'high', dueDate: daysAgo(1), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-ai-overdue-risk', 'tag-finance'], projectIds: ['proj-home'] },
      { id: 't-5a', sourceId: 'personal-list:task-005', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Research new dishwasher models', status: 'done', priority: 'medium', dueDate: daysAgo(4), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-home'], completedAt: daysAgo(3) },
      { id: 't-5b', sourceId: 'personal-list:task-006', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Book flight for Thanksgiving', status: 'todo', priority: 'medium', dueDate: daysFromNow(21), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-home'] },
      { id: 't-5c', sourceId: 'personal-list:task-007', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Return Amazon package (wrong size)', status: 'todo', priority: 'low', dueDate: daysFromNow(4), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-errand', 'tag-quick-win'], projectIds: ['proj-home'] },
      { id: 't-5d', sourceId: 'personal-list:task-008', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Schedule annual physical exam', status: 'todo', priority: 'medium', dueDate: daysFromNow(14), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-health'], projectIds: ['proj-home'] },
      { id: 't-5e', sourceId: 'personal-list:task-009', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Cancel old streaming subscription', status: 'done', priority: 'low', dueDate: daysAgo(3), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-finance'], projectIds: ['proj-home'], completedAt: daysAgo(2) },
      { id: 't-5f', sourceId: 'personal-list:task-010', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Pay property tax bill', status: 'todo', priority: 'critical', dueDate: daysFromNow(2), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-finance'], projectIds: ['proj-home'] },

      // ────── MS Todo — Work (8 tasks) ──────
      { id: 't-5', sourceId: 'work-list:task-010', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Prepare quarterly review slides', status: 'in_progress', priority: 'critical', dueDate: daysFromNow(2), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-focus'], projectIds: ['proj-work'] },
      { id: 't-6', sourceId: 'work-list:task-011', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Review PR for auth service refactor', status: 'todo', priority: 'medium', dueDate: daysFromNow(1), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-quick-win'], projectIds: ['proj-work'] },
      { id: 't-7', sourceId: 'work-list:task-012', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Submit expense report — Q2 travel', status: 'todo', priority: 'medium', dueDate: daysFromNow(0), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-finance'], projectIds: ['proj-work'] },
      { id: 't-7b', sourceId: 'work-list:task-013', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Draft proposal for Q4 headcount', status: 'todo', priority: 'high', dueDate: daysFromNow(5), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work'], projectIds: ['proj-work'] },
      { id: 't-7c', sourceId: 'work-list:task-014', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Update team wiki with new deploy process', status: 'todo', priority: 'low', dueDate: daysFromNow(7), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-documentation'], projectIds: ['proj-work'] },
      { id: 't-7d', sourceId: 'work-list:task-015', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Prepare onboarding docs for new hire', status: 'in_progress', priority: 'medium', dueDate: daysFromNow(3), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-documentation'], projectIds: ['proj-work'] },
      { id: 't-7e', sourceId: 'work-list:task-016', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Schedule 1:1s with direct reports', status: 'done', priority: 'medium', dueDate: daysAgo(1), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work'], projectIds: ['proj-work'], completedAt: daysAgo(1) },
      { id: 't-7f', sourceId: 'work-list:task-017', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Review security audit findings', status: 'todo', priority: 'high', dueDate: daysFromNow(2), sourceListId: 'work-list', sourceListName: 'Work', tagIds: ['tag-work', 'tag-focus', 'tag-priority-high'], projectIds: ['proj-work'] },

      // ────── MS Todo — Groceries (6 tasks) ──────
      { id: 't-8', sourceId: 'groceries:task-020', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Milk, eggs, bread', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },
      { id: 't-8b', sourceId: 'groceries:task-021', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Chicken breast (2 lbs)', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },
      { id: 't-8c', sourceId: 'groceries:task-022', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Fresh vegetables — spinach, peppers, onions', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },
      { id: 't-8d', sourceId: 'groceries:task-023', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Olive oil (extra virgin)', status: 'todo', priority: 'none', dueDate: null, sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },
      { id: 't-8e', sourceId: 'groceries:task-024', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Paper towels & dish soap', status: 'todo', priority: 'none', dueDate: null, sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },
      { id: 't-8f', sourceId: 'groceries:task-025', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Coffee beans (whole, medium roast)', status: 'todo', priority: 'medium', dueDate: daysFromNow(1), sourceListId: 'groceries', sourceListName: 'Groceries', tagIds: ['tag-errand'], projectIds: ['proj-home'] },

      // ────── MS Todo — Home Renovation (9 tasks) ──────
      { id: 't-hr1', sourceId: 'home-renovation:task-030', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Finalize countertop material (quartz vs granite)', status: 'in_progress', priority: 'high', dueDate: daysFromNow(3), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr2', sourceId: 'home-renovation:task-031', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Order cabinet hardware (handles + hinges)', status: 'todo', priority: 'medium', dueDate: daysFromNow(7), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr3', sourceId: 'home-renovation:task-032', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Schedule plumber for sink relocation', status: 'todo', priority: 'high', dueDate: daysFromNow(5), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal', 'tag-waiting'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr4', sourceId: 'home-renovation:task-033', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Pick up tile samples from showroom', status: 'todo', priority: 'medium', dueDate: daysFromNow(2), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal', 'tag-errand'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr5', sourceId: 'home-renovation:task-034', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Get electrician quote for under-cabinet lighting', status: 'todo', priority: 'medium', dueDate: daysFromNow(10), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr6', sourceId: 'home-renovation:task-035', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Demolition — remove old cabinets', status: 'done', priority: 'high', dueDate: daysAgo(7), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'], completedAt: daysAgo(6) },
      { id: 't-hr7', sourceId: 'home-renovation:task-036', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Order new refrigerator (delivery in 2 weeks)', status: 'done', priority: 'high', dueDate: daysAgo(3), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'], completedAt: daysAgo(2) },
      { id: 't-hr8', sourceId: 'home-renovation:task-037', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Paint walls — primer coat', status: 'in_progress', priority: 'medium', dueDate: daysFromNow(1), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'] },
      { id: 't-hr9', sourceId: 'home-renovation:task-038', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Research backsplash patterns on Pinterest', status: 'done', priority: 'low', dueDate: daysAgo(5), sourceListId: 'home-renovation', sourceListName: 'Home Renovation', tagIds: ['tag-personal'], projectIds: ['proj-kitchen-reno'], completedAt: daysAgo(4) },

      // ────── MS Todo — Fitness (4 tasks) ──────
      { id: 't-fit1', sourceId: 'fitness:task-040', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Sign up for Saturday morning yoga class', status: 'todo', priority: 'low', dueDate: daysFromNow(2), sourceListId: 'fitness', sourceListName: 'Fitness & Health', tagIds: ['tag-personal', 'tag-health'], projectIds: ['proj-home'] },
      { id: 't-fit2', sourceId: 'fitness:task-041', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Order new running shoes (current pair at 400mi)', status: 'todo', priority: 'medium', dueDate: daysFromNow(5), sourceListId: 'fitness', sourceListName: 'Fitness & Health', tagIds: ['tag-personal', 'tag-health'], projectIds: ['proj-home'] },
      { id: 't-fit3', sourceId: 'fitness:task-042', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Meal prep Sunday — lunches for the week', status: 'todo', priority: 'medium', dueDate: daysFromNow(3), sourceListId: 'fitness', sourceListName: 'Fitness & Health', tagIds: ['tag-personal', 'tag-health'], projectIds: ['proj-home'] },
      { id: 't-fit4', sourceId: 'fitness:task-043', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Renew gym membership (expires this month)', status: 'todo', priority: 'high', dueDate: daysFromNow(8), sourceListId: 'fitness', sourceListName: 'Fitness & Health', tagIds: ['tag-personal', 'tag-health', 'tag-finance'], projectIds: ['proj-home'] },

      // ────── GitHub — acme/project-alpha (12 tasks) ──────
      { id: 't-10', sourceId: 'acme/project-alpha:42', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Design connector plugin architecture', status: 'done', priority: 'high', dueDate: daysAgo(5), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement'], projectIds: ['proj-mission-control'], completedAt: daysAgo(4) },
      { id: 't-11', sourceId: 'acme/project-alpha:43', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Implement My Day view with time-blocking', status: 'in_progress', priority: 'high', dueDate: daysFromNow(4), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement', 'tag-focus'], projectIds: ['proj-mission-control'] },
      { id: 't-12', sourceId: 'acme/project-alpha:44', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Add tag filtering to task list API', status: 'todo', priority: 'medium', dueDate: daysFromNow(6), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement', 'tag-ai-related-group'], projectIds: ['proj-mission-control'] },
      { id: 't-13', sourceId: 'acme/project-alpha:45', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Bug: sync scheduler crashes on network timeout', status: 'todo', priority: 'critical', dueDate: daysFromNow(1), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-bug', 'tag-priority-high'], projectIds: ['proj-mission-control'] },
      { id: 't-14', sourceId: 'acme/project-alpha:46', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Write onboarding documentation', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-documentation', 'tag-good-first-issue'], projectIds: ['proj-mission-control'] },
      { id: 't-15', sourceId: 'acme/project-alpha:47', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Add webhook/push connector type', status: 'todo', priority: 'medium', dueDate: daysFromNow(14), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement'], projectIds: ['proj-mission-control'] },
      { id: 't-15b', sourceId: 'acme/project-alpha:48', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Portfolio view — project health indicators', status: 'in_progress', priority: 'high', dueDate: daysFromNow(3), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement', 'tag-focus'], projectIds: ['proj-mission-control'] },
      { id: 't-15c', sourceId: 'acme/project-alpha:49', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Dark mode — consistent CSS variable theming', status: 'done', priority: 'medium', dueDate: daysAgo(1), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement'], projectIds: ['proj-mission-control'], completedAt: daysAgo(0) },
      { id: 't-15d', sourceId: 'acme/project-alpha:50', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Refactor connector interface for v2', status: 'done', priority: 'high', dueDate: daysAgo(8), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement'], projectIds: ['proj-mission-control'], completedAt: daysAgo(6) },
      { id: 't-15e', sourceId: 'acme/project-alpha:51', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Add keyboard shortcuts (N=new, /=search, G+T=today)', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement', 'tag-quick-win'], projectIds: ['proj-mission-control'] },
      { id: 't-15f', sourceId: 'acme/project-alpha:52', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Bug: My Day items not persisting after page reload', status: 'todo', priority: 'high', dueDate: daysFromNow(2), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-bug'], projectIds: ['proj-mission-control'] },
      { id: 't-15g', sourceId: 'acme/project-alpha:53', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'AI auto-triage: priority inference from title + context', status: 'todo', priority: 'medium', dueDate: daysFromNow(10), sourceListId: 'acme/project-alpha', sourceListName: 'acme/project-alpha', tagIds: ['tag-enhancement'], projectIds: ['proj-mission-control'] },

      // ────── GitHub — acme/dotfiles (3 tasks) ──────
      { id: 't-16', sourceId: 'acme/dotfiles:12', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Migrate zsh config to use zinit', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme/dotfiles', sourceListName: 'acme/dotfiles', tagIds: ['tag-enhancement'], projectIds: [] },
      { id: 't-16b', sourceId: 'acme/dotfiles:13', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Add Neovim LSP config for TypeScript', status: 'in_progress', priority: 'medium', dueDate: null, sourceListId: 'acme/dotfiles', sourceListName: 'acme/dotfiles', tagIds: ['tag-enhancement'], projectIds: [] },
      { id: 't-16c', sourceId: 'acme/dotfiles:14', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Sync tmux config across machines', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme/dotfiles', sourceListName: 'acme/dotfiles', tagIds: ['tag-enhancement'], projectIds: [] },

      // ────── GitHub — acme/home-assistant-config (4 tasks) ──────
      { id: 't-ha1', sourceId: 'acme/home-assistant-config:5', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Add motion sensor automations for hallway lights', status: 'todo', priority: 'medium', dueDate: daysFromNow(7), sourceListId: 'acme/home-assistant-config', sourceListName: 'acme/home-assistant-config', tagIds: ['tag-enhancement'], projectIds: ['proj-smart-home'] },
      { id: 't-ha2', sourceId: 'acme/home-assistant-config:6', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Fix Zigbee coordinator dropping devices', status: 'in_progress', priority: 'high', dueDate: daysFromNow(2), sourceListId: 'acme/home-assistant-config', sourceListName: 'acme/home-assistant-config', tagIds: ['tag-bug'], projectIds: ['proj-smart-home'] },
      { id: 't-ha3', sourceId: 'acme/home-assistant-config:7', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Create dashboard for energy monitoring', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme/home-assistant-config', sourceListName: 'acme/home-assistant-config', tagIds: ['tag-enhancement'], projectIds: ['proj-smart-home'] },
      { id: 't-ha4', sourceId: 'acme/home-assistant-config:8', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Set up presence detection with phone WiFi', status: 'done', priority: 'medium', dueDate: daysAgo(3), sourceListId: 'acme/home-assistant-config', sourceListName: 'acme/home-assistant-config', tagIds: ['tag-enhancement'], projectIds: ['proj-smart-home'], completedAt: daysAgo(2) },

      // ────── GitHub — acme-corp/api-gateway (7 tasks — Work) ──────
      { id: 't-w1', sourceId: 'acme-corp/api-gateway:101', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Implement rate limiting middleware', status: 'in_progress', priority: 'high', dueDate: daysFromNow(3), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-enhancement', 'tag-work', 'tag-focus'], projectIds: ['proj-work'] },
      { id: 't-w2', sourceId: 'acme-corp/api-gateway:102', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Bug: 502 errors on high traffic endpoints', status: 'todo', priority: 'critical', dueDate: daysFromNow(1), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-bug', 'tag-priority-high', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-w3', sourceId: 'acme-corp/api-gateway:103', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Add OpenTelemetry tracing to all routes', status: 'todo', priority: 'medium', dueDate: daysFromNow(8), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-w4', sourceId: 'acme-corp/api-gateway:104', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Upgrade Node.js from 18 to 22', status: 'todo', priority: 'medium', dueDate: daysFromNow(12), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-w5', sourceId: 'acme-corp/api-gateway:105', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Write load testing suite with k6', status: 'done', priority: 'high', dueDate: daysAgo(4), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'], completedAt: daysAgo(3) },
      { id: 't-w6', sourceId: 'acme-corp/api-gateway:106', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Document API versioning strategy', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-documentation', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-w7', sourceId: 'acme-corp/api-gateway:107', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Migrate auth from JWT to session tokens', status: 'todo', priority: 'high', dueDate: daysFromNow(6), sourceListId: 'acme-corp/api-gateway', sourceListName: 'acme-corp/api-gateway', tagIds: ['tag-enhancement', 'tag-work', 'tag-blocked'], projectIds: ['proj-work'] },

      // ────── GitHub — acme-corp/web-dashboard (5 tasks — Work) ──────
      { id: 't-wd1', sourceId: 'acme-corp/web-dashboard:50', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Redesign settings page with new brand colors', status: 'in_progress', priority: 'medium', dueDate: daysFromNow(5), sourceListId: 'acme-corp/web-dashboard', sourceListName: 'acme-corp/web-dashboard', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-wd2', sourceId: 'acme-corp/web-dashboard:51', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Fix accessibility issues flagged in audit', status: 'todo', priority: 'high', dueDate: daysFromNow(4), sourceListId: 'acme-corp/web-dashboard', sourceListName: 'acme-corp/web-dashboard', tagIds: ['tag-bug', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-wd3', sourceId: 'acme-corp/web-dashboard:52', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Add real-time notifications via WebSocket', status: 'todo', priority: 'medium', dueDate: daysFromNow(10), sourceListId: 'acme-corp/web-dashboard', sourceListName: 'acme-corp/web-dashboard', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'] },
      { id: 't-wd4', sourceId: 'acme-corp/web-dashboard:53', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Performance: lazy-load analytics charts', status: 'done', priority: 'medium', dueDate: daysAgo(2), sourceListId: 'acme-corp/web-dashboard', sourceListName: 'acme-corp/web-dashboard', tagIds: ['tag-enhancement', 'tag-work'], projectIds: ['proj-work'], completedAt: daysAgo(1) },
      { id: 't-wd5', sourceId: 'acme-corp/web-dashboard:54', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Add export-to-CSV for report tables', status: 'todo', priority: 'low', dueDate: null, sourceListId: 'acme-corp/web-dashboard', sourceListName: 'acme-corp/web-dashboard', tagIds: ['tag-enhancement', 'tag-work', 'tag-quick-win'], projectIds: ['proj-work'] },

      // ────── 3D Printing tasks (personal-list, but proj-3d-printing) ──────
      { id: 't-3d1', sourceId: 'personal-list:task-060', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: '3D Print: Desk cable organizer — design in Fusion 360', status: 'done', priority: 'medium', dueDate: daysAgo(6), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-3d-printing'], completedAt: daysAgo(5) },
      { id: 't-3d2', sourceId: 'personal-list:task-061', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: '3D Print: Desk cable organizer — slice & print', status: 'in_progress', priority: 'medium', dueDate: daysFromNow(1), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-3d-printing'] },
      { id: 't-3d3', sourceId: 'personal-list:task-062', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: '3D Print: Custom plant pot — measure & design', status: 'todo', priority: 'low', dueDate: daysFromNow(7), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-3d-printing'] },
      { id: 't-3d4', sourceId: 'personal-list:task-063', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: '3D Print: Replace filament spool (running low on PLA)', status: 'todo', priority: 'medium', dueDate: daysFromNow(3), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal', 'tag-errand'], projectIds: ['proj-3d-printing'] },
      { id: 't-3d5', sourceId: 'personal-list:task-064', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: '3D Print: Raspberry Pi enclosure for HA server', status: 'todo', priority: 'medium', dueDate: daysFromNow(10), sourceListId: 'personal-list', sourceListName: 'Personal', tagIds: ['tag-personal'], projectIds: ['proj-3d-printing', 'proj-smart-home'] },

      // ────── Local and Scout tasks for modern task lifecycle demos ──────
      { id: 't-local-plan', sourceId: 'local:demo-launch-plan', connectorType: 'local', connectorInstanceId: 'local', title: 'Prepare Mission Control demo walkthrough', status: 'in_progress', priority: 'high', dueDate: daysFromNow(2), sourceListId: 'local', sourceListName: 'Local', tagIds: ['tag-focus', 'tag-documentation'], projectIds: ['proj-mission-control'] },
      { id: 't-local-checklist-1', sourceId: 'local:demo-launch-plan:1', connectorType: 'local', connectorInstanceId: 'local', title: 'Capture project planning screenshots', status: 'done', priority: 'medium', dueDate: daysAgo(1), sourceListId: 'local', sourceListName: 'Local', tagIds: [], projectIds: ['proj-mission-control'], completedAt: daysAgo(1), parentId: 't-local-plan', depth: 1, isChecklistItem: true },
      { id: 't-local-checklist-2', sourceId: 'local:demo-launch-plan:2', connectorType: 'local', connectorInstanceId: 'local', title: 'Record My Day workflow', status: 'todo', priority: 'medium', dueDate: daysFromNow(1), sourceListId: 'local', sourceListName: 'Local', tagIds: [], projectIds: ['proj-mission-control'], parentId: 't-local-plan', depth: 1, isChecklistItem: true },
      { id: 't-scout-active', sourceId: 'scout:follow-up:deployment', connectorType: 'scout', connectorInstanceId: 'scout-demo', title: 'Confirm staging deployment with the platform team', status: 'todo', priority: 'high', dueDate: daysAgo(1), sourceListId: 'scout-follow-ups', sourceListName: 'Scout Follow-ups', tagIds: ['tag-waiting'], projectIds: ['proj-work'] },
      { id: 't-scout-handled', sourceId: 'scout:follow-up:budget', connectorType: 'scout', connectorInstanceId: 'scout-demo', title: 'Follow up on approved infrastructure budget', status: 'todo', priority: 'medium', dueDate: daysFromNow(4), sourceListId: 'scout-follow-ups', sourceListName: 'Scout Follow-ups', tagIds: ['tag-work'], projectIds: ['proj-work'] },
    ];

    const insertTask = db.prepare(
      `INSERT INTO tasks (id, source_id, connector_type, connector_instance_id, title, status, priority, due_date, created_at, updated_at, completed_at, parent_id, depth, is_checklist_item, source_list_id, source_list_name, metadata, sync_status, last_synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insertTaskTag = db.prepare('INSERT INTO task_tags (task_id, tag_id) VALUES (?, ?)');
    const insertTaskProject = db.prepare('INSERT INTO task_projects (task_id, project_id) VALUES (?, ?)');

    for (const t of taskData) {
      insertTask.run(
        t.id, t.sourceId, t.connectorType, t.connectorInstanceId,
        t.title, t.status, t.priority, t.dueDate || null,
        daysAgo(Math.floor(Math.random() * 14) + 1), now, t.completedAt || null,
        t.parentId || null, t.depth ?? 0, t.isChecklistItem ? 1 : 0,
        t.sourceListId, t.sourceListName, '{}', 'synced', now
      );
      for (const tagId of t.tagIds) {
        insertTaskTag.run(t.id, tagId);
      }
      if (t.projectIds) {
        for (const projId of t.projectIds) {
          insertTaskProject.run(t.id, projId);
        }
      }

      const updateTaskDemoDetails = db.prepare(`
        UPDATE tasks
        SET description = ?, assignee = ?, micro_status = ?, local_disposition = ?,
            effort = ?, reminder_at = ?, snoozed_until = ?, kanban_column = ?,
            kanban_order = ?, metadata = ?
        WHERE id = ?
      `);
      const taskDemoDetails = [
        {
          id: 't-local-plan',
          description: [
            '## Demo goals',
            '',
            '- Show a focused day built from multiple sources',
            '- Walk through project phases and dependencies',
            '- Explain local edits versus source-owned fields',
            '',
            '> Keep the walkthrough under 12 minutes.',
          ].join('\n'),
          assignee: 'Ryan',
          microStatus: 'focused',
          localDisposition: 'active',
          effort: 4,
          reminderAt: daysFromNow(1),
          snoozedUntil: null,
          kanbanColumn: 'in-progress',
          kanbanOrder: 1,
          metadata: JSON.stringify({ demoScenario: 'rich-task-detail', source: 'quick-add' }),
        },
        {
          id: 't-hr3',
          description: 'Waiting for the plumber to confirm availability and provide a revised quote.',
          assignee: 'Alex',
          microStatus: 'waiting',
          localDisposition: 'active',
          effort: 3,
          reminderAt: daysFromNow(2),
          snoozedUntil: daysFromNow(1),
          kanbanColumn: 'ordered',
          kanbanOrder: 2,
          metadata: JSON.stringify({ demoScenario: 'waiting-and-snoozed' }),
        },
        {
          id: 't-scout-active',
          description: 'Scout detected deployment discussion activity but could not verify completion.',
          assignee: null,
          microStatus: 'blocked',
          localDisposition: 'active',
          effort: 2,
          reminderAt: null,
          snoozedUntil: null,
          kanbanColumn: null,
          kanbanOrder: null,
          metadata: JSON.stringify({ demoScenario: 'authority-and-reconciliation' }),
        },
        {
          id: 't-scout-handled',
          description: 'The source still reports this follow-up as open; it has been handled locally.',
          assignee: null,
          microStatus: null,
          localDisposition: 'handled',
          effort: 1,
          reminderAt: null,
          snoozedUntil: null,
          kanbanColumn: null,
          kanbanOrder: null,
          metadata: JSON.stringify({ demoScenario: 'local-disposition' }),
        },
      ];
      for (const detail of taskDemoDetails) {
        updateTaskDemoDetails.run(
          detail.description,
          detail.assignee,
          detail.microStatus,
          detail.localDisposition,
          detail.effort,
          detail.reminderAt,
          detail.snoozedUntil,
          detail.kanbanColumn,
          detail.kanbanOrder,
          detail.metadata,
          detail.id,
        );
      }
    }

    // ─── ALERTS (12 alerts — varied sources, times, severities) ───
    const alertData = [
      { id: 'a-1', sourceId: 'gh-notif-1', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'PR #38 approved by @teammate', body: 'Your pull request "Add webhook support" has been approved and is ready to merge.', severity: 'digest', category: 'development', isRead: 0, isActionable: 1, actionUrl: 'https://github.com/acme/project-alpha/pull/38', receivedAt: hoursAgo(1) },
      { id: 'a-2', sourceId: 'gh-notif-2', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'CI failed on main branch', body: 'Build #142 failed: test suite timeout in auth module. 3 tests timed out after 30s.', severity: 'heads_up', category: 'development', isRead: 0, isActionable: 1, actionUrl: 'https://github.com/acme/project-alpha/actions/runs/142', receivedAt: hoursAgo(2) },
      { id: 'a-3', sourceId: 'gh-notif-3', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Mentioned in ideation#45', body: '@contributor can you take a look at the network timeout issue? Seems related to the retry logic.', severity: 'digest', category: 'development', isRead: 0, isActionable: 1, actionUrl: 'https://github.com/acme/project-alpha/issues/45#comment-1', receivedAt: hoursAgo(3) },
      { id: 'a-4', sourceId: 'mstodo-reminder-1', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Reminder: Submit expense report — Q2 travel', body: 'Task is due today. Don\'t forget receipts from the Denver conference.', severity: 'heads_up', category: 'reminder', isRead: 0, isActionable: 1, actionUrl: null, receivedAt: hoursAgo(4) },
      { id: 'a-5', sourceId: 'gh-notif-4', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Critical: 502 errors spiking on api-gateway', body: 'Error rate jumped to 12% in the last hour. On-call team has been notified.', severity: 'urgent', category: 'development', isRead: 0, isActionable: 1, actionUrl: 'https://github.com/acme-corp/api-gateway/issues/102', receivedAt: hoursAgo(1) },
      { id: 'a-6', sourceId: 'gh-notif-5', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Review requested: web-dashboard#55', body: '@contributor please review the new settings page redesign — 12 files changed.', severity: 'digest', category: 'development', isRead: 0, isActionable: 1, actionUrl: 'https://github.com/acme-corp/web-dashboard/pull/55', receivedAt: hoursAgo(5) },
      { id: 'a-7', sourceId: 'mstodo-reminder-2', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Reminder: Pay property tax bill', body: 'Due in 2 days. Amount: $2,847.00', severity: 'action_needed', category: 'reminder', isRead: 0, isActionable: 1, actionUrl: null, receivedAt: hoursAgo(6) },
      { id: 'a-8', sourceId: 'gh-notif-6', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Dependabot: 2 security vulnerabilities', body: 'acme/project-alpha has 2 moderate severity vulnerabilities in dependencies.', severity: 'heads_up', category: 'development', isRead: 1, isActionable: 1, actionUrl: 'https://github.com/acme/project-alpha/security/dependabot', receivedAt: hoursAgo(8) },
      { id: 'a-9', sourceId: 'gh-notif-7', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Deploy succeeded: api-gateway v2.4.1', body: 'Production deployment completed in 3m 42s. All health checks passing.', severity: 'digest', category: 'development', isRead: 1, isActionable: 0, actionUrl: null, receivedAt: hoursAgo(12) },
      { id: 'a-10', sourceId: 'mstodo-reminder-3', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Overdue: Call insurance company about claim', body: 'This task was due yesterday and is still open.', severity: 'heads_up', category: 'overdue', isRead: 0, isActionable: 1, actionUrl: null, receivedAt: hoursAgo(2) },
      { id: 'a-11', sourceId: 'gh-notif-8', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Issue closed: home-assistant-config#8', body: 'Presence detection is working. Closed by @contributor.', severity: 'digest', category: 'development', isRead: 1, isActionable: 0, actionUrl: null, receivedAt: daysAgo(2) },
      { id: 'a-12', sourceId: 'mstodo-reminder-4', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Upcoming: Kitchen tile samples pickup', body: 'Scheduled for tomorrow. Showroom closes at 6pm.', severity: 'digest', category: 'reminder', isRead: 0, isActionable: 0, actionUrl: null, receivedAt: hoursAgo(1) },
    ];

    const insertAlert = db.prepare(
      `INSERT INTO alerts (id, source_id, connector_type, connector_instance_id, title, body, severity, category, is_read, is_actionable, action_url, received_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const a of alertData) {
      insertAlert.run(a.id, a.sourceId, a.connectorType, a.connectorInstanceId, a.title, a.body, a.severity, a.category, a.isRead, a.isActionable ? 1 : 0, a.actionUrl, a.receivedAt, '{}');
    }

    // ─── MY DAY ITEMS (8 items — a full day's plan) ───
    const myDayItems = [
      { id: 'md-1', taskId: 't-5', date: today, addedAt: now, isAutoIncluded: 0, order: 1 },     // Quarterly review slides (in progress)
      { id: 'md-2', taskId: 't-13', date: today, addedAt: now, isAutoIncluded: 1, order: 2 },    // Critical bug (auto: critical)
      { id: 'md-3', taskId: 't-w2', date: today, addedAt: now, isAutoIncluded: 1, order: 3 },    // 502 errors (auto: critical)
      { id: 'md-4', taskId: 't-2', date: today, addedAt: now, isAutoIncluded: 1, order: 4 },     // Renew car reg (auto: due tomorrow)
      { id: 'md-5', taskId: 't-6', date: today, addedAt: now, isAutoIncluded: 0, order: 5 },     // Review PR (quick win)
      { id: 'md-6', taskId: 't-7', date: today, addedAt: now, isAutoIncluded: 1, order: 6 },     // Expense report (auto: due today)
      { id: 'md-7', taskId: 't-hr4', date: today, addedAt: now, isAutoIncluded: 0, order: 7 },   // Tile samples (errand)
      { id: 'md-8', taskId: 't-3d2', date: today, addedAt: now, isAutoIncluded: 0, order: 8 },   // 3D print in progress
    ];

    const insertMyDay = db.prepare(
      'INSERT INTO my_day_items (id, task_id, date, added_at, is_auto_included, "order") VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const md of myDayItems) {
      insertMyDay.run(md.id, md.taskId, md.date, md.addedAt, md.isAutoIncluded ? 1 : 0, md.order);
    }

    // ─── SYNC LOG (realistic recent syncs) ───
    const syncEntries = [
      { connectorId: 'github-1', success: 1, added: 3, updated: 2, removed: 0, alerts: 4, at: hoursAgo(1), ms: 1847 },
      { connectorId: 'github-2', success: 1, added: 1, updated: 3, removed: 0, alerts: 3, at: hoursAgo(1), ms: 2103 },
      { connectorId: 'mstodo-1', success: 1, added: 2, updated: 1, removed: 0, alerts: 3, at: hoursAgo(0.5), ms: 892 },
      { connectorId: 'github-1', success: 1, added: 0, updated: 1, removed: 0, alerts: 1, at: hoursAgo(6), ms: 1234 },
      { connectorId: 'mstodo-1', success: 1, added: 4, updated: 0, removed: 1, alerts: 0, at: hoursAgo(6), ms: 756 },
      { connectorId: 'github-2', success: 0, added: 0, updated: 0, removed: 0, alerts: 0, at: daysAgo(1), ms: 30012, errors: JSON.stringify(['Connection timeout after 30s']) },
    ];
    const insertSync = db.prepare(
      'INSERT INTO sync_log (id, connector_id, success, tasks_added, tasks_updated, tasks_removed, alerts_added, errors, synced_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    );
    for (const [index, s] of syncEntries.entries()) {
      insertSync.run(`sync-log-${index + 1}`, s.connectorId, s.success, s.added, s.updated, s.removed, s.alerts, s.errors || '[]', s.at, s.ms);
    }

    // ─── NOTIFICATIONS (rich notification system with actions) ───
    const notificationData = [
      { id: 'notif-1', sourceId: 'gh-pr-approved-38', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'PR #38 approved by @teammate', body: 'Your pull request "Add webhook support" has been approved and is ready to merge.', level: 'success', levelRank: 2, category: 'development', state: 'unread', isActionable: 1, receivedAt: hoursAgo(1), sortAt: hoursAgo(1), groupKey: 'pr-38', relatedTaskId: 't-13', navigationTarget: '/projects/proj-mission-control' },
      { id: 'notif-2', sourceId: 'gh-ci-fail-142', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'CI failed on main branch', body: 'Build #142 failed: test suite timeout in auth module. 3 tests timed out after 30s.', level: 'urgent', levelRank: 1, category: 'development', state: 'unread', isActionable: 1, receivedAt: hoursAgo(2), sortAt: hoursAgo(2), groupKey: null, relatedProjectId: 'proj-mission-control', navigationTarget: null },
      { id: 'notif-3', sourceId: 'gh-mention-45', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Mentioned in issue #45', body: '@contributor can you look at the network timeout issue? Seems related to the retry logic.', level: 'fyi', levelRank: 3, category: 'development', state: 'unread', isActionable: 1, receivedAt: hoursAgo(3), sortAt: hoursAgo(3), groupKey: null, relatedTaskId: null, navigationTarget: null },
      { id: 'notif-4', sourceId: 'mstodo-due-expense', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Due today: Submit expense report', body: 'Task is due today. Don\'t forget receipts from the Denver conference.', level: 'action-needed', levelRank: 2, category: 'due-today', state: 'unread', isActionable: 1, receivedAt: hoursAgo(4), sortAt: hoursAgo(4), groupKey: 'due-today', relatedTaskId: 't-7', navigationTarget: '/today' },
      { id: 'notif-5', sourceId: 'gh-502-spike', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Critical: 502 errors spiking', body: 'Error rate jumped to 12% in the last hour on api-gateway. On-call team notified.', level: 'urgent', levelRank: 1, category: 'development', state: 'unread', isActionable: 1, receivedAt: hoursAgo(1), sortAt: hoursAgo(1), groupKey: null, relatedTaskId: 't-w2', navigationTarget: null },
      { id: 'notif-6', sourceId: 'gh-review-req-55', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Review requested: web-dashboard #55', body: '@contributor please review the new settings page — 12 files changed.', level: 'action-needed', levelRank: 2, category: 'development', state: 'unread', isActionable: 1, receivedAt: hoursAgo(5), sortAt: hoursAgo(5), groupKey: null, relatedProjectId: 'proj-work', navigationTarget: null },
      { id: 'notif-7', sourceId: 'mstodo-property-tax', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Upcoming: Pay property tax bill', body: 'Due in 2 days. Amount: $2,847.00', level: 'action-needed', levelRank: 2, category: 'due-soon', state: 'unread', isActionable: 1, receivedAt: hoursAgo(6), sortAt: hoursAgo(6), groupKey: 'due-soon', relatedTaskId: 't-5f', navigationTarget: '/today' },
      { id: 'notif-8', sourceId: 'gh-dependabot-2', connectorType: 'github-issues', connectorInstanceId: 'github-1', title: 'Dependabot: 2 security vulnerabilities', body: 'acme/project-alpha has 2 moderate severity vulnerabilities in dependencies.', level: 'action-needed', levelRank: 2, category: 'development', state: 'read', isActionable: 1, receivedAt: hoursAgo(8), sortAt: hoursAgo(8), readAt: hoursAgo(6), groupKey: 'dependabot', relatedProjectId: 'proj-mission-control', navigationTarget: null },
      { id: 'notif-9', sourceId: 'gh-deploy-success', connectorType: 'github-issues', connectorInstanceId: 'github-2', title: 'Deploy succeeded: api-gateway v2.4.1', body: 'Production deployment completed in 3m 42s. All health checks passing.', level: 'fyi', levelRank: 3, category: 'development', state: 'read', isActionable: 0, receivedAt: hoursAgo(12), sortAt: hoursAgo(12), readAt: hoursAgo(10), groupKey: null, relatedProjectId: 'proj-work', navigationTarget: null },
      { id: 'notif-10', sourceId: 'mstodo-overdue-insurance', connectorType: 'microsoft-todo', connectorInstanceId: 'mstodo-1', title: 'Overdue: Call insurance company', body: 'This task was due yesterday and is still open.', level: 'urgent', levelRank: 1, category: 'overdue', state: 'unread', isActionable: 1, receivedAt: hoursAgo(2), sortAt: hoursAgo(2), groupKey: 'overdue', relatedTaskId: 't-4', navigationTarget: '/today' },
      { id: 'notif-11', sourceId: 'weekly-reset-reminder', connectorType: 'system', connectorInstanceId: 'system', title: 'Time for your weekly reset', body: 'Review your week, celebrate wins, and plan next week.', level: 'fyi', levelRank: 3, category: 'system', state: 'unread', isActionable: 1, receivedAt: hoursAgo(24), sortAt: hoursAgo(24), groupKey: null, relatedTaskId: null, navigationTarget: '/settings' },
      { id: 'notif-12', sourceId: 'routine-streak-5', connectorType: 'system', connectorInstanceId: 'system', title: '🔥 5-day streak: Morning Routine', body: 'You\'ve completed your morning routine 5 days in a row!', level: 'success', levelRank: 2, category: 'streak', state: 'unread', isActionable: 0, receivedAt: hoursAgo(3), sortAt: hoursAgo(3), groupKey: null, relatedTaskId: null, navigationTarget: '/routines' },
    ];

    const insertNotification = db.prepare(
      `INSERT INTO notifications (id, source_id, connector_type, connector_instance_id, title, body, level, level_rank, category, state, read_state, disposition, source_state, sync_state, is_actionable, received_at, sort_at, read_at, last_source_activity_at, last_source_synced_at, group_key, related_task_id, related_project_id, navigation_target, metadata, presentation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', '{}')`
    );
    for (const n of notificationData) {
      insertNotification.run(
        n.id,
        n.sourceId,
        n.connectorType,
        n.connectorInstanceId,
        n.title,
        n.body,
        n.level,
        n.levelRank,
        n.category,
        n.state,
        n.state === 'read' ? 'read' : 'unread',
        'inbox',
        'active',
        'synced',
        n.isActionable,
        n.receivedAt,
        n.sortAt,
        (n as Record<string, unknown>).readAt || null,
        n.sortAt,
        n.receivedAt,
        n.groupKey,
        n.relatedTaskId || null,
        (n as Record<string, unknown>).relatedProjectId || null,
        n.navigationTarget,
      );
    }

    // Notification actions (for actionable notifications)
    const notifActions = [
      { id: 'na-1', notificationId: 'notif-1', actionType: 'navigate', label: 'View PR', icon: 'external-link', variant: 'default', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ url: 'https://github.com/acme/project-alpha/pull/38' }), opensExternal: 1 },
      { id: 'na-2', notificationId: 'notif-1', actionType: 'navigate', label: 'Merge', icon: 'git-merge', variant: 'default', isPrimary: 0, sortOrder: 1, payload: JSON.stringify({ url: 'https://github.com/acme/project-alpha/pull/38' }), opensExternal: 1 },
      { id: 'na-3', notificationId: 'notif-2', actionType: 'navigate', label: 'View Build', icon: 'external-link', variant: 'destructive', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ url: 'https://github.com/acme/project-alpha/actions/runs/142' }), opensExternal: 1 },
      { id: 'na-4', notificationId: 'notif-5', actionType: 'navigate', label: 'View Issue', icon: 'alert-triangle', variant: 'destructive', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ url: 'https://github.com/acme-corp/api-gateway/issues/102' }), opensExternal: 1 },
      { id: 'na-5', notificationId: 'notif-6', actionType: 'navigate', label: 'Review PR', icon: 'code', variant: 'default', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ url: 'https://github.com/acme-corp/web-dashboard/pull/55' }), opensExternal: 1 },
      { id: 'na-6', notificationId: 'notif-8', actionType: 'navigate', label: 'View Alerts', icon: 'shield', variant: 'default', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ url: 'https://github.com/acme/project-alpha/security/dependabot' }), opensExternal: 1 },
      { id: 'na-7', notificationId: 'notif-11', actionType: 'navigate_internal', label: 'Start Reset', icon: 'refresh-cw', variant: 'default', isPrimary: 1, sortOrder: 0, payload: JSON.stringify({ path: '/settings' }), opensExternal: 0 },
    ];

    const insertNotifAction = db.prepare(
      `INSERT INTO notification_actions (id, notification_id, action_type, label, icon, variant, is_primary, sort_order, payload, opens_external, requires_confirmation, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'system')`
    );
    for (const a of notifActions) {
      insertNotifAction.run(a.id, a.notificationId, a.actionType, a.label, a.icon, a.variant, a.isPrimary, a.sortOrder, a.payload, a.opensExternal);
    }

    // ─── ROUTINES & HABITS ───
    const routineData = [
      { id: 'routine-morning', name: 'Morning Routine', description: 'Coffee, journal, plan the day', cadenceType: 'daily', cadenceConfig: '{}', icon: '☀️', sortOrder: 1, isActive: 1 },
      { id: 'routine-exercise', name: 'Exercise', description: '30+ minutes of movement — run, gym, or yoga', cadenceType: 'x_per_week', cadenceConfig: JSON.stringify({ target: 4 }), icon: '🏃', sortOrder: 2, isActive: 1 },
      { id: 'routine-read', name: 'Read 30 min', description: 'Read non-fiction or technical book', cadenceType: 'specific_days', cadenceConfig: JSON.stringify({ days: [1, 2, 3, 4, 5] }), icon: '📚', sortOrder: 3, isActive: 1 },
      { id: 'routine-inbox-zero', name: 'Inbox Zero', description: 'Process email to zero items', cadenceType: 'daily', cadenceConfig: '{}', icon: '📧', sortOrder: 4, isActive: 1 },
      { id: 'routine-water', name: 'Drink 8 glasses of water', description: 'Stay hydrated throughout the day', cadenceType: 'daily', cadenceConfig: '{}', icon: '💧', sortOrder: 5, isActive: 1 },
      { id: 'routine-weekly-review', name: 'Weekly Review', description: 'Plan next week, review goals, process loose ends', cadenceType: 'weekly', cadenceConfig: JSON.stringify({ preferredDay: 0 }), icon: '📋', sortOrder: 6, isActive: 1 },
      { id: 'routine-meal-prep', name: 'Meal Prep', description: 'Prep lunches for the work week', cadenceType: 'weekly', cadenceConfig: JSON.stringify({ preferredDay: 0 }), icon: '🥗', sortOrder: 7, isActive: 1 },
      { id: 'routine-budget-review', name: 'Monthly Budget Review', description: 'Review spending, check kid card limits, adjust categories', cadenceType: 'monthly', cadenceConfig: JSON.stringify({ preferredDay: '1st' }), icon: '💰', sortOrder: 8, isActive: 1 },
    ];

    const insertRoutine = db.prepare(
      `INSERT INTO routines (id, name, description, cadence_type, cadence_config, icon, sort_order, is_active, is_archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
    );
    for (const r of routineData) {
      insertRoutine.run(r.id, r.name, r.description, r.cadenceType, r.cadenceConfig, r.icon, r.sortOrder, r.isActive, daysAgo(30), now);
    }

    // ─── ROUTINE COMPLETIONS (last 7 days of streaks) ───
    const completions: Array<{ id: string; routineId: string; date: string; completedAt: string; notes?: string }> = [];
    for (let d = 6; d >= 0; d--) {
      const date = localDate(-d);
      const completedAt = daysAgo(d);
      // Morning routine — done every day (7-day streak)
      completions.push({ id: `rc-morning-${d}`, routineId: 'routine-morning', date, completedAt });
      // Inbox zero — done every day
      completions.push({ id: `rc-inbox-${d}`, routineId: 'routine-inbox-zero', date, completedAt });
      // Water — done 5 of 7 days
      if (d !== 2 && d !== 5) completions.push({ id: `rc-water-${d}`, routineId: 'routine-water', date, completedAt });
      // Exercise — done 4 of 7 days
      if (d === 0 || d === 2 || d === 4 || d === 6) completions.push({ id: `rc-exercise-${d}`, routineId: 'routine-exercise', date, completedAt, notes: d === 0 ? '5K run, felt great' : undefined });
      // Read — weekdays only, missed one
      if (d >= 1 && d <= 5 && d !== 3) completions.push({ id: `rc-read-${d}`, routineId: 'routine-read', date, completedAt });
    }
    // Weekly review — done last Sunday
    completions.push({ id: 'rc-weekly-review-0', routineId: 'routine-weekly-review', date: localDate(-7), completedAt: daysAgo(7) });

    const insertCompletion = db.prepare(
      'INSERT INTO routine_completions (id, routine_id, date, notes, completed_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const c of completions) {
      insertCompletion.run(c.id, c.routineId, c.date, c.notes || null, c.completedAt);
    }

    // ─── ENERGY CHECK-INS (last 7 days) ───
    const energyLevels: Array<{ level: string; note?: string }> = [
      { level: 'high', note: 'Great sleep, feeling energized' },
      { level: 'medium' },
      { level: 'low', note: 'Rough night, kid was up at 3am' },
      { level: 'medium', note: 'Coffee helped' },
      { level: 'high' },
      { level: 'medium' },
      { level: 'high', note: 'Weekend rest paid off' },
    ];
    const insertEnergy = db.prepare(
      'INSERT INTO energy_checkins (id, date, level, note, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (let d = 6; d >= 0; d--) {
      const e = energyLevels[6 - d];
      insertEnergy.run(`energy-${d}`, localDate(-d), e.level, e.note || null, daysAgo(d));
    }

    // ─── FOCUS ITEMS (Today's Focus 3) ───
    const focusItemsData = [
      { id: 'focus-1', taskId: 't-5', scope: 'today', date: today, slot: 1, isAiSuggested: 0 },   // Quarterly review slides
      { id: 'focus-2', taskId: 't-w2', scope: 'today', date: today, slot: 2, isAiSuggested: 1 },   // 502 errors (AI suggested — critical)
      { id: 'focus-3', taskId: 't-5f', scope: 'today', date: today, slot: 3, isAiSuggested: 0 },   // Pay property tax
    ];
    const insertFocus = db.prepare(
      'INSERT INTO focus_items (id, task_id, scope, date, slot, added_at, is_ai_suggested) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const f of focusItemsData) {
      insertFocus.run(f.id, f.taskId, f.scope, f.date, f.slot, now, f.isAiSuggested);
    }

    // ─── WEEKLY ONE THING ───
    // This week's "one thing" — the quarterly review slides
    const monday = (() => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return localDate(-((new Date().getDay() + 6) % 7)); })();
    db.prepare(
      'INSERT INTO weekly_one_thing (id, task_id, week_monday, is_manual_override, completed_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run('wot-1', 't-5', monday, 0, null, daysAgo(1));

    // ─── TASK SCHEDULES (time-blocked tasks) ───
    const schedules = [
      { taskId: 't-5', scheduledDate: today, scheduledTime: '09:00', estimatedDuration: 120, isTimeBlocked: 1 },  // Quarterly slides — 2hr block
      { taskId: 't-6', scheduledDate: today, scheduledTime: '14:00', estimatedDuration: 30, isTimeBlocked: 1 },   // Review PR — 30min
      { taskId: 't-7', scheduledDate: today, scheduledTime: '11:00', estimatedDuration: 20, isTimeBlocked: 0 },   // Expense report
      { taskId: 't-hr4', scheduledDate: today, scheduledTime: '17:00', estimatedDuration: 45, isTimeBlocked: 0 }, // Tile samples pickup
    ];
    const insertSchedule = db.prepare(
      'INSERT INTO task_schedules (task_id, scheduled_date, scheduled_time, estimated_duration, is_time_blocked, recurrence) VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const s of schedules) {
      insertSchedule.run(s.taskId, s.scheduledDate, s.scheduledTime, s.estimatedDuration, s.isTimeBlocked, null);
    }

    // ─── PROJECT PHASES (Kitchen Renovation) ───
    const phases = [
      { id: 'phase-kr-planning', projectId: 'proj-kitchen-reno', name: 'Planning & Design', description: 'Finalize layout, materials, and contractor quotes', status: 'completed', color: '#22c55e', estimatedDays: 14, targetStart: localDate(-30), targetEnd: localDate(-16), sortOrder: 1, completedAt: daysAgo(10) },
      { id: 'phase-kr-demo', projectId: 'proj-kitchen-reno', name: 'Demolition', description: 'Remove old cabinets, countertops, and flooring', status: 'completed', color: '#22c55e', estimatedDays: 3, targetStart: localDate(-15), targetEnd: localDate(-12), sortOrder: 2, completedAt: daysAgo(6), startAfter: 'phase-kr-planning' },
      { id: 'phase-kr-rough', projectId: 'proj-kitchen-reno', name: 'Rough Work', description: 'Plumbing, electrical, framing changes', status: 'in_progress', color: '#3b82f6', estimatedDays: 7, targetStart: localDate(-11), targetEnd: localDate(2), sortOrder: 3, completedAt: null, startAfter: 'phase-kr-demo' },
      { id: 'phase-kr-install', projectId: 'proj-kitchen-reno', name: 'Installation', description: 'Cabinets, countertops, appliances, backsplash', status: 'pending', color: '#6b7280', estimatedDays: 10, targetStart: localDate(3), targetEnd: localDate(13), sortOrder: 4, completedAt: null, startAfter: 'phase-kr-rough' },
      { id: 'phase-kr-finish', projectId: 'proj-kitchen-reno', name: 'Finishing Touches', description: 'Paint, hardware, final trim, punch list', status: 'pending', color: '#6b7280', estimatedDays: 5, targetStart: localDate(14), targetEnd: localDate(19), sortOrder: 5, completedAt: null, startAfter: 'phase-kr-install' },
    ];

    const insertPhase = db.prepare(
      `INSERT INTO project_phases (id, project_id, name, description, status, color, estimated_days, target_start, target_end, start_after_phase_id, sort_order, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const p of phases) {
      insertPhase.run(p.id, p.projectId, p.name, p.description, p.status, p.color, p.estimatedDays, p.targetStart, p.targetEnd, (p as Record<string, unknown>).startAfter || null, p.sortOrder, p.completedAt, daysAgo(30), now);
    }

    // ─── PROJECT MILESTONES ───
    const milestones = [
      { id: 'ms-kr-1', projectId: 'proj-kitchen-reno', name: 'Countertops ordered', targetDate: daysFromNow(5), completedAt: null, sortOrder: 1 },
      { id: 'ms-kr-2', projectId: 'proj-kitchen-reno', name: 'Plumbing complete', targetDate: daysFromNow(8), completedAt: null, sortOrder: 2 },
      { id: 'ms-kr-3', projectId: 'proj-kitchen-reno', name: 'Kitchen usable again', targetDate: daysFromNow(25), completedAt: null, sortOrder: 3 },
      { id: 'ms-mc-1', projectId: 'proj-mission-control', name: 'v1.0 feature-complete', targetDate: daysFromNow(14), completedAt: null, sortOrder: 1 },
      { id: 'ms-mc-2', projectId: 'proj-mission-control', name: 'Public beta release', targetDate: daysFromNow(30), completedAt: null, sortOrder: 2 },
    ];

    const insertMilestone = db.prepare(
      'INSERT INTO project_milestones (id, project_id, name, target_date, completed_at, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const m of milestones) {
      insertMilestone.run(m.id, m.projectId, m.name, m.targetDate, m.completedAt, m.sortOrder, daysAgo(7));
    }

    // ─── SUBTASK TEMPLATES ───
    const templates = [
      { id: 'tmpl-pr-review', name: 'PR Review Checklist', description: 'Standard steps for reviewing a pull request', category: 'development', type: 'single', icon: '🔍', subtasks: JSON.stringify([{ title: 'Read the description and linked issue' }, { title: 'Check test coverage' }, { title: 'Review for security implications' }, { title: 'Run locally and verify' }, { title: 'Leave review comments' }]) },
      { id: 'tmpl-deploy', name: 'Production Deploy', description: 'Checklist for shipping to prod', category: 'development', type: 'single', icon: '🚀', subtasks: JSON.stringify([{ title: 'Ensure CI is green' }, { title: 'Review staging metrics' }, { title: 'Merge to main' }, { title: 'Monitor error rates for 30 min' }, { title: 'Notify team in Slack' }]) },
      { id: 'tmpl-home-project', name: 'Home Project Planning', description: 'Steps for any home improvement job', category: 'home', type: 'single', icon: '🏠', subtasks: JSON.stringify([{ title: 'Research materials and costs' }, { title: 'Get quotes from contractors' }, { title: 'Order materials' }, { title: 'Schedule work dates' }, { title: 'Final inspection' }]) },
      { id: 'tmpl-3d-print', name: '3D Print Job', description: 'From design to finished print', category: '3d-printing', type: 'single', icon: '🖨️', subtasks: JSON.stringify([{ title: 'Design/download STL' }, { title: 'Slice in Cura/PrusaSlicer' }, { title: 'Prep bed and load filament' }, { title: 'Print and monitor first layer' }, { title: 'Post-processing (supports, sanding)' }]) },
      { id: 'tmpl-travel', name: 'Trip Planning', description: 'Everything needed to plan a trip', category: 'travel', type: 'single', icon: '✈️', subtasks: JSON.stringify([{ title: 'Book flights' }, { title: 'Book accommodation' }, { title: 'Arrange transportation' }, { title: 'Pack bags (use packing list)' }, { title: 'Set out-of-office' }, { title: 'Arrange pet/plant care' }]) },
    ];

    const insertTemplate = db.prepare(
      `INSERT INTO subtask_templates (id, name, description, category, type, subtasks, workflow_tasks, icon, is_built_in, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, ?)`
    );
    for (const t of templates) {
      insertTemplate.run(t.id, t.name, t.description, t.category, t.type, t.subtasks, t.icon, daysAgo(14), now);
    }

    // ─── PRIORITY ENTITIES (Smart Score configuration) ───
    const entities = [
      { id: 'pe-boss', name: 'Manager (Sarah)', type: 'person', description: 'Direct manager — tasks from her get priority', tier: 'critical', color: '#dc2626', rank: 1 },
      { id: 'pe-api-gateway', name: 'api-gateway', type: 'project', description: 'Production service — incidents are top priority', tier: 'critical', color: '#ef4444', rank: 2 },
      { id: 'pe-family', name: 'Family', type: 'domain', description: 'Family commitments and obligations', tier: 'high', color: '#f59e0b', rank: 3 },
      { id: 'pe-web-dashboard', name: 'web-dashboard', type: 'project', description: 'Internal tool — important but not critical path', tier: 'medium', color: '#3b82f6', rank: 4 },
      { id: 'pe-homelab', name: 'Homelab', type: 'domain', description: 'Fun projects, can wait', tier: 'standard', color: '#64748b', rank: 5 },
    ];

    const insertEntity = db.prepare(
      `INSERT INTO priority_entities (id, name, type, description, tier, color, rank, active_task_count, last_touched_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    );
    for (const e of entities) {
      insertEntity.run(e.id, e.name, e.type, e.description, e.tier, e.color, e.rank, now, daysAgo(7), now);
    }

    // ─── SOURCE RANKINGS (trust order for Smart Score) ───
    const rankings = [
      { id: 'github-2', connectorType: 'github-issues', name: 'GitHub (Work)', rank: 1 },
      { id: 'mstodo-1', connectorType: 'microsoft-todo', name: 'Microsoft To Do (Personal)', rank: 2 },
      { id: 'github-1', connectorType: 'github-issues', name: 'GitHub (Personal)', rank: 3 },
    ];

    const insertRanking = db.prepare(
      'INSERT INTO source_rankings (id, connector_type, name, rank, updated_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const r of rankings) {
      insertRanking.run(r.id, r.connectorType, r.name, r.rank, now);
    }

    // ─── FINANCE (Kid card monitoring transactions) ───
    const kidProfiles = [
      { id: 'kid-emma', name: 'Emma', color: '#ec4899', avatar: null, dailyLimit: 25, weeklyLimit: 75, monthlyLimit: 200 },
      { id: 'kid-noah', name: 'Noah', color: '#3b82f6', avatar: null, dailyLimit: 15, weeklyLimit: 50, monthlyLimit: 150 },
    ];

    const insertKid = db.prepare(
      'INSERT INTO kid_profiles (id, name, color, avatar, daily_limit, weekly_limit, monthly_limit) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    for (const k of kidProfiles) {
      insertKid.run(k.id, k.name, k.color, k.avatar, k.dailyLimit, k.weeklyLimit, k.monthlyLimit);
    }

    // Card rules — which cards belong to which kid
    const cardRules = [
      { id: 'cr-1', kidId: 'kid-emma', cardLast4: '4521', accountId: null, confidence: 1.0 },
      { id: 'cr-2', kidId: 'kid-noah', cardLast4: '7834', accountId: null, confidence: 1.0 },
    ];
    const insertCardRule = db.prepare(
      'INSERT INTO kid_card_rules (id, kid_id, card_last4, account_id, confidence) VALUES (?, ?, ?, ?, ?)'
    );
    for (const cr of cardRules) {
      insertCardRule.run(cr.id, cr.kidId, cr.cardLast4, cr.accountId, cr.confidence);
    }

    db.prepare(`
      INSERT OR IGNORE INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at
      ) VALUES (
        'finance-manager-default', 'finance-manager', 'Tyrion', 1, 'poll', 240,
        '{"read":true,"write":true,"delete":false,"sync":true,"subtasks":false,"lists":false,"tags":true,"tagWriteBack":false}',
        '{}', '{}', '[]', ?, ?
      )
    `).run(now, now);

    const insertFinanceDatasetState = db.prepare(`
      INSERT INTO finance_dataset_sync_state (
        connector_id, dataset, last_attempt_at, last_attempt_outcome,
        last_successful_at, source_as_of, fresh_until, current_generation_id,
        schema_version, config_version, published_item_count, source_limit,
        created_at, updated_at
      ) VALUES (
        'finance-manager-default', ?, ?, 'succeeded', ?, ?, ?, ?,
        '1.0', 1, 0, ?, ?, ?
      )
    `);
    const demoDatasetLimits: Record<string, number> = {
      accounts: 1_000,
      'category-groups': 250,
      categories: 2_000,
      tags: 1_000,
      recurring: 5_000,
      budgets: 5_000,
    };
    for (const [dataset, sourceLimit] of Object.entries(demoDatasetLimits)) {
      const freshnessHours = dataset === 'recurring' || dataset === 'budgets' ? 6 : 24;
      insertFinanceDatasetState.run(
        dataset,
        now,
        now,
        now,
        new Date(Date.parse(now) + freshnessHours * 3_600_000).toISOString(),
        `demo:${dataset}`,
        sourceLimit,
        now,
        now,
      );
    }

    // Recent transactions
    const transactions = [
      { id: 'txn-1', date: localDate(-1), amount: 8.49, merchantName: 'Roblox', originalCategory: 'Entertainment', cardLast4: '4521', assignedKidId: 'kid-emma', kidAssignmentMethod: 'card_rule', triageStatus: 'confirmed' },
      { id: 'txn-2', date: localDate(-1), amount: 12.99, merchantName: 'Amazon', originalCategory: 'Shopping', cardLast4: '4521', assignedKidId: 'kid-emma', kidAssignmentMethod: 'card_rule', triageStatus: 'confirmed' },
      { id: 'txn-3', date: localDate(-2), amount: 4.50, merchantName: 'School Cafeteria', originalCategory: 'Food & Drink', cardLast4: '7834', assignedKidId: 'kid-noah', kidAssignmentMethod: 'card_rule', triageStatus: 'confirmed' },
      { id: 'txn-4', date: localDate(0), amount: 34.99, merchantName: 'Steam', originalCategory: 'Entertainment', cardLast4: '4521', assignedKidId: 'kid-emma', kidAssignmentMethod: 'card_rule', triageStatus: 'flagged', flagReason: 'Large purchase — exceeds daily limit' },
      { id: 'txn-5', date: localDate(-3), amount: 6.00, merchantName: 'Minecraft Marketplace', originalCategory: 'Entertainment', cardLast4: '7834', assignedKidId: 'kid-noah', kidAssignmentMethod: 'card_rule', triageStatus: 'confirmed' },
      { id: 'txn-6', date: localDate(0), amount: 3.99, merchantName: 'Apple App Store', originalCategory: 'Shopping', cardLast4: '7834', assignedKidId: 'kid-noah', kidAssignmentMethod: 'card_rule', triageStatus: 'pending' },
      { id: 'txn-7', date: localDate(-4), amount: 15.00, merchantName: 'Target', originalCategory: 'Shopping', cardLast4: '4521', assignedKidId: 'kid-emma', kidAssignmentMethod: 'card_rule', triageStatus: 'confirmed' },
      { id: 'txn-8', date: localDate(-2), amount: 22.50, merchantName: 'Unknown Merchant', originalCategory: null, cardLast4: '4521', assignedKidId: 'kid-emma', kidAssignmentMethod: 'card_rule', triageStatus: 'flagged', flagReason: 'Unknown merchant — needs review' },
    ];

    const insertTransaction = db.prepare(
      `INSERT INTO finance_transactions (id, connector_instance_id, upstream_transaction_id, date, amount, merchant_name, original_category, confirmed_category, account_id, account_name, card_last4, assigned_kid_id, kid_assignment_method, triage_status, flag_reason, is_recurring, notes, tags, synced_at)
       VALUES (?, 'finance-manager-default', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, 0, NULL, '[]', ?)`
    );
    for (const t of transactions) {
      insertTransaction.run(t.id, t.id, t.date, t.amount, t.merchantName, t.originalCategory || null, t.cardLast4, t.assignedKidId, t.kidAssignmentMethod, t.triageStatus, (t as Record<string, unknown>).flagReason || null, now);
    }

    // ─── TRIAGE SAMPLE INBOX ───
    const insertTriageItem = db.prepare(`
      INSERT INTO triage_items (
        id, source_platform, source_id, source_url, canonical_url, title, description,
        thumbnail_url, content_type, captured_at, ingested_at, status, snoozed_until,
        ai_summary, ai_categories, ai_suggested_actions, ai_relevance_score, ai_urgency,
        raw_metadata, actions_taken, source_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    SAMPLE_TRIAGE_ITEMS.forEach((item, index) => {
      insertTriageItem.run(
        item.id,
        item.sourcePlatform,
        item.sourceId,
        item.sourceUrl,
        item.canonicalUrl,
        item.title,
        item.description,
        item.thumbnailUrl,
        item.contentType,
        item.capturedAt,
        item.ingestedAt,
        item.status,
        item.snoozedUntil ?? null,
        item.aiSummary,
        JSON.stringify(item.aiCategories),
        JSON.stringify(item.aiSuggestedActions),
        item.aiRelevanceScore,
        item.aiUrgency,
        JSON.stringify(item.rawMetadata),
        JSON.stringify(item.actionsTaken),
        index,
      );
    });

    // ─── PROJECT PHASE MEMBERSHIP & DEPENDENCIES ───
    const phaseItems = [
      { id: 'pi-kr-planning-1', phaseId: 'phase-kr-planning', taskId: 't-hr9', order: 1, effort: 3 },
      { id: 'pi-kr-demo-1', phaseId: 'phase-kr-demo', taskId: 't-hr6', order: 1, effort: 8 },
      { id: 'pi-kr-rough-1', phaseId: 'phase-kr-rough', taskId: 't-hr3', order: 1, effort: 5 },
      { id: 'pi-kr-rough-2', phaseId: 'phase-kr-rough', taskId: 't-hr5', order: 2, effort: 3 },
      { id: 'pi-kr-install-1', phaseId: 'phase-kr-install', taskId: 't-hr1', order: 1, effort: 4 },
      { id: 'pi-kr-install-2', phaseId: 'phase-kr-install', taskId: 't-hr2', order: 2, effort: 2 },
      { id: 'pi-kr-install-3', phaseId: 'phase-kr-install', taskId: 't-hr4', order: 3, effort: 2 },
      { id: 'pi-kr-install-4', phaseId: 'phase-kr-install', taskId: 't-hr7', order: 4, effort: 1 },
      { id: 'pi-kr-finish-1', phaseId: 'phase-kr-finish', taskId: 't-hr8', order: 1, effort: 6 },
    ];
    const insertPhaseItem = db.prepare(`
      INSERT INTO project_phase_items
        (id, phase_id, task_id, sort_order, estimated_effort_hours, is_proposed, proposal_type, created_at)
      VALUES (?, ?, ?, ?, ?, 0, NULL, ?)
    `);
    for (const item of phaseItems) {
      insertPhaseItem.run(item.id, item.phaseId, item.taskId, item.order, item.effort, daysAgo(30));
    }

    const dependencies = [
      { id: 'dep-kr-1', taskId: 't-hr2', dependsOnTaskId: 't-hr1', type: 'blocks' },
      { id: 'dep-kr-2', taskId: 't-hr8', dependsOnTaskId: 't-hr5', type: 'blocks' },
      { id: 'dep-demo-1', taskId: 't-local-checklist-2', dependsOnTaskId: 't-local-checklist-1', type: 'blocks' },
      { id: 'dep-kr-related', taskId: 't-hr3', dependsOnTaskId: 't-hr5', type: 'related' },
    ];
    const insertDependency = db.prepare(`
      INSERT INTO task_dependencies
        (id, task_id, depends_on_task_id, type, connector_instance_id, sync_status, sync_action, sync_error, last_synced_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `);
    for (const dependency of dependencies) {
      const connectorId = dependency.id.startsWith('dep-kr') ? 'mstodo-1' : null;
      insertDependency.run(
        dependency.id,
        dependency.taskId,
        dependency.dependsOnTaskId,
        dependency.type,
        connectorId,
        connectorId ? 'synced' : 'local',
        connectorId ? now : null,
        daysAgo(7),
      );
    }

    // ─── TASK AUTHORITY, LINKED SOURCES & ATTACHMENTS ───
    const fieldStates = [
      { taskId: 't-scout-active', fieldName: 'title', sourceValue: 'Confirm staging deployment with the platform team', overridden: 0, localEditedAt: null },
      { taskId: 't-scout-active', fieldName: 'dueDate', sourceValue: daysAgo(1), overridden: 1, localEditedAt: hoursAgo(6) },
      { taskId: 't-scout-handled', fieldName: 'status', sourceValue: 'todo', overridden: 0, localEditedAt: null },
    ];
    const insertFieldState = db.prepare(`
      INSERT INTO task_field_states
        (task_id, field_name, source_value, locally_overridden, source_observed_at, local_edited_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const state of fieldStates) {
      insertFieldState.run(
        state.taskId,
        state.fieldName,
        state.sourceValue,
        state.overridden,
        hoursAgo(8),
        state.localEditedAt,
        now,
      );
    }

    db.prepare(`
      INSERT INTO task_linked_sources
        (id, task_id, connector_type, connector_instance_id, source_id, title, linked_at, match_confidence, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'linked-demo-plan-github',
      't-local-plan',
      'github-issues',
      'github-1',
      'acme/project-alpha:61',
      'Prepare Mission Control demo walkthrough',
      daysAgo(3),
      0.96,
      JSON.stringify({ linkedBy: 'smart-reconciliation', demoScenario: true }),
    );

    const attachmentContent = [
      '# Demo walkthrough',
      '',
      '1. Start with My Day.',
      '2. Open the Kitchen Renovation project graph.',
      '3. Show the Scout reconciliation suggestion.',
    ].join('\n');
    db.prepare(`
      INSERT INTO task_attachments
        (id, task_id, name, content_type, size, content_base64, source_attachment_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
    `).run(
      'attachment-demo-walkthrough',
      't-local-plan',
      'demo-walkthrough.md',
      'text/markdown',
      Buffer.byteLength(attachmentContent),
      Buffer.from(attachmentContent).toString('base64'),
      daysAgo(1),
    );

    // ─── TASK HISTORY FOR PROGRESS REPORTS ───
    const historyScenarios = [
      { taskId: 't-hr9', phaseId: 'phase-kr-planning', status: 'done', effort: 3, transitionDaysAgo: 18 },
      { taskId: 't-hr6', phaseId: 'phase-kr-demo', status: 'done', effort: 5, transitionDaysAgo: 12 },
      { taskId: 't-hr7', phaseId: 'phase-kr-install', status: 'done', effort: 2, transitionDaysAgo: 8 },
      { taskId: 't-hr3', phaseId: 'phase-kr-rough', status: 'todo', effort: 3, transitionDaysAgo: null },
      { taskId: 't-hr5', phaseId: 'phase-kr-rough', status: 'todo', effort: 2, transitionDaysAgo: null },
      { taskId: 't-hr1', phaseId: 'phase-kr-install', status: 'in_progress', effort: 4, transitionDaysAgo: 5 },
      { taskId: 't-hr2', phaseId: 'phase-kr-install', status: 'todo', effort: 2, transitionDaysAgo: null },
      { taskId: 't-hr4', phaseId: 'phase-kr-install', status: 'todo', effort: 2, transitionDaysAgo: null },
      { taskId: 't-hr8', phaseId: 'phase-kr-finish', status: 'in_progress', effort: 4, transitionDaysAgo: 3 },
    ];
    const insertHistoryEvent = db.prepare(`
      INSERT INTO task_history_events
        (task_id, event_type, field_name, previous_value, new_value, project_id, phase_id,
         occurred_at, recorded_at, provenance, provenance_ref, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const scenario of historyScenarios) {
      insertHistoryEvent.run(
        scenario.taskId,
        'baseline',
        null,
        null,
        JSON.stringify({
          status: 'todo',
          microStatus: null,
          kanbanColumn: null,
          effort: scenario.effort,
          projectIds: ['proj-kitchen-reno'],
          phaseIds: [scenario.phaseId],
        }),
        null,
        null,
        daysAgo(30),
        daysAgo(30),
        'demo_seed',
        null,
        JSON.stringify({ scenario: 'kitchen-renovation-progress' }),
      );
      if (scenario.transitionDaysAgo !== null) {
        insertHistoryEvent.run(
          scenario.taskId,
          'status_changed',
          'status',
          'todo',
          scenario.status,
          'proj-kitchen-reno',
          scenario.phaseId,
          daysAgo(scenario.transitionDaysAgo),
          daysAgo(scenario.transitionDaysAgo),
          'demo_seed',
          null,
          null,
        );
      }
    }

    // ─── QUICK SORT ACTIVITY ───
    const quickSortEvents = [
      { id: 'qs-1', taskId: 't-8d', mode: 'no_priority', action: 'suggestion_accepted', at: daysAgo(1) },
      { id: 'qs-2', taskId: 't-14', mode: 'no_due_date', action: 'skipped', at: hoursAgo(6) },
      { id: 'qs-3', taskId: 't-16', mode: 'no_effort', action: 'applied', at: hoursAgo(3) },
    ];
    const insertQuickSort = db.prepare(`
      INSERT INTO task_triage_log (id, task_id, mode, action, triaged_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    for (const event of quickSortEvents) {
      insertQuickSort.run(event.id, event.taskId, event.mode, event.action, event.at);
    }

    // ─── DURABLE SYNC DIAGNOSTICS ───
    const syncJobsData = [
      { id: 'sync-job-success', connectorId: 'github-1', source: 'schedule', status: 'succeeded', attempt: 1, scheduledFor: hoursAgo(1), startedAt: hoursAgo(1), completedAt: hoursAgo(0.9), result: JSON.stringify({ added: 3, updated: 2 }) },
      { id: 'sync-job-recovered', connectorId: 'mstodo-1', source: 'watchdog', status: 'succeeded', attempt: 2, scheduledFor: hoursAgo(6), startedAt: hoursAgo(5.8), completedAt: hoursAgo(5.7), result: JSON.stringify({ recovered: true, updated: 4 }) },
      { id: 'sync-job-failed', connectorId: 'github-2', source: 'schedule', status: 'failed', attempt: 3, scheduledFor: daysAgo(1), startedAt: daysAgo(1), completedAt: daysAgo(1), result: null, error: 'Connection timeout after 30 seconds' },
    ];
    const insertSyncJob = db.prepare(`
      INSERT INTO sync_jobs
        (id, connector_id, full, source, status, attempt, max_attempts, available_at,
         scheduled_for, lease_owner, lease_expires_at, cancel_requested_at, started_at,
         completed_at, result, error, duration_budget_ms, created_at, updated_at)
      VALUES (?, ?, 0, ?, ?, ?, 3, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, 300000, ?, ?)
    `);
    for (const job of syncJobsData) {
      insertSyncJob.run(
        job.id,
        job.connectorId,
        job.source,
        job.status,
        job.attempt,
        job.scheduledFor,
        job.scheduledFor,
        job.startedAt,
        job.completedAt,
        job.result,
        (job as Record<string, unknown>).error ?? null,
        job.scheduledFor,
        job.completedAt,
      );
    }
    const insertSyncEvent = db.prepare(`
      INSERT INTO sync_job_events (job_id, connector_id, event_type, payload, created_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertSyncEvent.run('sync-job-recovered', 'mstodo-1', 'lease-expired', JSON.stringify({ previousOwner: 'worker-old' }), hoursAgo(5.9));
    insertSyncEvent.run('sync-job-recovered', 'mstodo-1', 'recovered', JSON.stringify({ attempt: 2 }), hoursAgo(5.8));
    insertSyncEvent.run('sync-job-failed', 'github-2', 'failed', JSON.stringify({ retryable: true, attempt: 3 }), daysAgo(1));

    const insertSyncSchedule = db.prepare(`
      INSERT INTO sync_schedules (connector_id, interval_minutes, next_due_at, last_enqueued_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    insertSyncSchedule.run('github-1', 10, new Date(Date.now() + 5 * 60_000).toISOString(), hoursAgo(1), now);
    insertSyncSchedule.run('github-2', 10, new Date(Date.now() + 2 * 60_000).toISOString(), daysAgo(1), now);
    insertSyncSchedule.run('mstodo-1', 5, new Date(Date.now() + 3 * 60_000).toISOString(), hoursAgo(0.5), now);

    // ─── SCOUT RECONCILIATION SUGGESTION ───
    const scoutEvidence = JSON.stringify([{
      signalId: 'signal-demo-deployment',
      sourceType: 'teams',
      kind: 'teams-confirmed-handled',
      occurredAt: hoursAgo(2),
      summary: 'The platform team confirmed the staging deployment completed successfully.',
      sourceRefHash: 'demo-source-ref-deployment',
    }]);
    db.prepare(`
      INSERT INTO scout_reconciliation_runs
        (id, scope_key, scope_type, scope_id, lookback_hours, dry_run, source, source_identity,
         idempotency_key, request_hash, lease_token, status, summary, error, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      'scout-run-demo',
      'task:t-scout-active',
      'task',
      't-scout-active',
      72,
      'automation',
      'demo-seed',
      'demo-reconciliation-run',
      'demo-request-hash',
      'demo-lease-token',
      'completed',
      JSON.stringify({ autoCompleted: 0, suggestedComplete: 1, escalated: 0, unchanged: 0, ignoredSignals: 0 }),
      hoursAgo(2),
      hoursAgo(2),
    );
    db.prepare(`
      INSERT INTO scout_reconciliation_evaluations
        (id, run_id, task_id, candidate_action, action, confidence, evidence_hash, evidence,
         policy_decision, policy_reason, payload_hash, applied, applied_result, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `).run(
      'scout-eval-demo',
      'scout-run-demo',
      't-scout-active',
      'suggest-complete',
      'suggest-complete',
      0.88,
      'demo-evidence-hash',
      scoutEvidence,
      'require-confirmation',
      'A Teams confirmation is strong evidence, but completion requires your approval.',
      'demo-payload-hash',
      hoursAgo(2),
    );
    db.prepare(`
      INSERT INTO scout_reconciliation_suggestions
        (id, task_id, run_id, evaluation_id, action, status, confidence, evidence_hash,
         evidence, policy_decision, policy_reason, payload_hash, proposed_effect,
         created_at, updated_at, expires_at, acted_at, acted_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      'scout-suggestion-demo',
      't-scout-active',
      'scout-run-demo',
      'scout-eval-demo',
      'suggest-complete',
      'pending',
      0.88,
      'demo-evidence-hash',
      scoutEvidence,
      'require-confirmation',
      'A Teams confirmation is strong evidence, but completion requires your approval.',
      'demo-payload-hash',
      JSON.stringify({ status: 'done', statusReason: 'completed' }),
      hoursAgo(2),
      hoursAgo(2),
      daysFromNow(14),
    );

    // ─── RESETS (one completed weekly reset from last week) ───
    const lastMonday = localDate(-((new Date().getDay() + 6) % 7) - 7);
    const lastSunday = localDate(-((new Date().getDay() + 6) % 7) - 1);
    db.prepare(
      `INSERT INTO resets (id, type, period_start, period_end, went_well, needs_adjustment, notes, stats, ai_summary, stale_actions, carry_forward_items, completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'reset-weekly-1', 'weekly', lastMonday, lastSunday,
      'Finished the PR review backlog, got 4 workouts in, and made good progress on kitchen demo.',
      'Need to be better about processing triage items daily instead of letting them pile up.',
      null,
      JSON.stringify({ tasksCompleted: 12, tasksCreated: 8, focusHitRate: 0.71, streakDays: { morning: 7, exercise: 4 } }),
      'Productive week overall. You knocked out 12 tasks (above your 10-task average), maintained your morning streak, and hit your exercise goal. The kitchen renovation is on track. One area to watch: your triage inbox grew by 6 items — consider a daily 5-minute sweep.',
      JSON.stringify([{ taskId: 't-w6', action: 'keep' }]),
      JSON.stringify([{ description: 'Finish quarterly review slides', detail: 'Due Wednesday', kept: true }, { description: 'Call insurance company', detail: 'Overdue — escalate', kept: true }]),
      daysAgo(1), daysAgo(1), daysAgo(1)
    );

}

/**
 * Destructively replaces all demo-owned data, including append-only history.
 * This is the single reset path used by local demo mode, CLI seeding, and Azure.
 */
export async function resetDemoDatabase(): Promise<void> {
  const db = getDb();
  const tables = listUserDataTables(db, false);
  const foreignKeysEnabled = db.pragma('foreign_keys', { simple: true }) === 1;

  if (foreignKeysEnabled) db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec('DROP TRIGGER IF EXISTS task_history_immutable_delete');
      deleteTables(db, tables.filter(({ name }) => name !== 'task_history_events'));
      deleteTables(db, tables.filter(({ name }) => name === 'task_history_events'));
      seedDatabaseContents(db);
      createTaskHistoryDeleteTrigger(db);
    })();
  } finally {
    if (foreignKeysEnabled) db.pragma('foreign_keys = ON');
    db.close();
  }
}
