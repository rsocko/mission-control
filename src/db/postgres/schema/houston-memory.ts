import { index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';

export const houstonConversationMemories = pgTable('houston_conversation_memories', {
  id: text('id').primaryKey(),
  authorizationScope: text('authorization_scope').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  decisions: jsonb('decisions').$type<string[]>().notNull().default([]),
  commitments: jsonb('commitments').$type<string[]>().notNull().default([]),
  topics: jsonb('topics').$type<string[]>().notNull().default([]),
  linkedEntities: jsonb('linked_entities')
    .$type<Array<{ type: 'task' | 'project' | 'tag'; id: string; label: string }>>()
    .notNull()
    .default([]),
  sensitivity: text('sensitivity').$type<'local-only' | 'restricted' | 'standard'>().notNull(),
  retainUntil: text('retain_until').notNull(),
  excludedAt: text('excluded_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => [
  index('idx_houston_memories_scope_updated')
    .on(table.authorizationScope, table.updatedAt),
  index('idx_houston_memories_retention').on(table.retainUntil),
  index('idx_houston_memories_excluded').on(table.excludedAt),
]);
