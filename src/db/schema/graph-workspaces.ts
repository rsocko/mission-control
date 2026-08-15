import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { IdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import type { IdeationWorkspaceVersionReason } from '@/lib/graph-workspace/types';

export const graphWorkspaces = sqliteTable('graph_workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<'ideation'>().notNull(),
  schemaVersion: integer('schema_version').notNull(),
  contentRevision: integer('content_revision').notNull(),
  currentDocument: text('current_document', { mode: 'json' })
    .$type<IdeationWorkspaceDocument>()
    .notNull(),
  archivedAt: text('archived_at'),
  migrationSource: text('migration_source'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  uniqueIndex('idx_graph_workspaces_migration_source').on(table.migrationSource),
  index('idx_graph_workspaces_library').on(table.archivedAt, table.updatedAt),
]);

export const graphWorkspaceVersions = sqliteTable('graph_workspace_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => graphWorkspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  name: text('name').notNull(),
  document: text('document', { mode: 'json' })
    .$type<IdeationWorkspaceDocument>()
    .notNull(),
  reason: text('reason').$type<IdeationWorkspaceVersionReason>().notNull(),
  createdAt: text('created_at').notNull(),
}, (table) => [
  uniqueIndex('idx_graph_workspace_versions_revision').on(
    table.workspaceId,
    table.revision,
  ),
  index('idx_graph_workspace_versions_history').on(table.workspaceId, table.createdAt),
]);
