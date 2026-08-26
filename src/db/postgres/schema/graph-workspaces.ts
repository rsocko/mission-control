import { jsonb } from 'drizzle-orm/pg-core';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import type { IdeationWorkspaceDocument } from '@/lib/graph-workspace/ideation-contract';
import type { IdeationWorkspaceVersionReason } from '@/lib/graph-workspace/types';

export const graphWorkspaces = pgTable('graph_workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').$type<'ideation'>().notNull(),
  schemaVersion: integer('schema_version').notNull(),
  contentRevision: integer('content_revision').notNull(),
  currentDocument: jsonb('current_document')
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

export const graphWorkspaceVersions = pgTable('graph_workspace_versions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id')
    .notNull()
    .references(() => graphWorkspaces.id, { onDelete: 'cascade' }),
  revision: integer('revision').notNull(),
  name: text('name').notNull(),
  document: jsonb('document')
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
