import { foreignKey, index, pgTable, text } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { tsvector } from './search';
import { tasks } from './tasks';
import { notifications } from './notifications';

// ─── SEARCH-INDEX PROJECTIONS (PostgreSQL-only, no SQLite counterpart) ─────
//
// These two tables exist purely so `PostgresKeywordSearchRepository` can
// give `indexTask`/`removeTask`/`indexNotification`/`removeNotification` a
// real, working implementation *without* ever mutating or deleting the
// authoritative `tasks`/`notifications` rows. They are the PostgreSQL
// analogue of SQLite's `tasks_fts`/`alerts_fts` FTS5 virtual tables (see
// `src/lib/search/sqlite-fts-repository.ts`): a separate, explicitly
// maintained keyword-search mirror that stores only the free-text fields
// used for matching/ranking/highlighting, joined against the live
// `tasks`/`notifications` tables at query time for authoritative,
// always-fresh metadata (status, priority, severity, read state, etc.).
//
// Because SQLite's mirror is a raw, un-tracked FTS5 virtual table (created
// via `sqlite.exec(...)`, never represented in `src/db/schema/**`), these
// tables have no SQLite equivalent and are intentionally excluded from the
// SQLite<->PostgreSQL schema-parity checks in `tests/db/postgres-schema.test.ts`
// (see `POSTGRES_ONLY_TABLE_EXPORTS` there), while still being covered by
// their own dedicated structural assertions.
//
// The `id` foreign key cascades on delete so that deleting a task or
// notification through its owning repository (`PostgresTaskRepository`/
// `PostgresNotificationRepository`) automatically removes the matching
// search-document row too — the search index can never outlive the domain
// row it was built from, without any repository needing to know about the
// other.

export const taskSearchDocuments = pgTable('task_search_documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  sourceListName: text('source_list_name'),
  connectorType: text('connector_type'),
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(description, '')), 'B') || setweight(to_tsvector('english', coalesce(source_list_name, '') || ' ' || coalesce(connector_type, '')), 'C')`,
  ),
}, (table) => [
  index('idx_task_search_documents_vector').using('gin', table.searchVector),
  foreignKey({
    columns: [table.id],
    foreignColumns: [tasks.id],
    name: 'task_search_documents_task_id_fk',
  }).onDelete('cascade'),
]);

export const notificationSearchDocuments = pgTable('notification_search_documents', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body'),
  category: text('category'),
  connectorType: text('connector_type'),
  searchVector: tsvector('search_vector').generatedAlwaysAs(
    sql`setweight(to_tsvector('english', coalesce(title, '')), 'A') || setweight(to_tsvector('english', coalesce(body, '')), 'B') || setweight(to_tsvector('english', coalesce(category, '') || ' ' || coalesce(connector_type, '')), 'C')`,
  ),
}, (table) => [
  index('idx_notification_search_documents_vector').using('gin', table.searchVector),
  foreignKey({
    columns: [table.id],
    foreignColumns: [notifications.id],
    name: 'notification_search_documents_notification_id_fk',
  }).onDelete('cascade'),
]);
