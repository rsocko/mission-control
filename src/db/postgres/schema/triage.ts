import { boolean, jsonb } from 'drizzle-orm/pg-core';
import { index, pgTable, text, integer, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── TRIAGE QUEUE ─────────────────────────────────────────────────────────────

export const triageItems = pgTable('triage_items', {
  id: text('id').primaryKey(),
  sourcePlatform: text('source_platform').notNull(),
  sourceId: text('source_id').notNull(),
  sourceUrl: text('source_url').notNull(),
  canonicalUrl: text('canonical_url'),
  title: text('title').notNull(),
  description: text('description'),
  thumbnailUrl: text('thumbnail_url'),
  contentType: text('content_type').notNull().default('link'),
  capturedAt: text('captured_at').notNull(),
  ingestedAt: text('ingested_at').notNull(),
  status: text('status').notNull().default('pending'),
  snoozedUntil: text('snoozed_until'),
  aiSummary: text('ai_summary'),
  aiCategories: jsonb('ai_categories').notNull().default([]),
  aiSuggestedActions: jsonb('ai_suggested_actions').notNull().default([]),
  aiRelevanceScore: integer('ai_relevance_score').notNull().default(0),
  aiUrgency: text('ai_urgency').notNull().default('evergreen'),
  rawMetadata: jsonb('raw_metadata').notNull().default({}),
  actionsTaken: jsonb('actions_taken').notNull().default([]),
  sourceOrder: integer('source_order'),
}, (table) => [
  uniqueIndex('idx_triage_items_source').on(table.sourcePlatform, table.sourceId),
  index('idx_triage_items_canonical_url').on(table.canonicalUrl),
]);

export const triageActionClaims = pgTable('triage_action_claims', {
  id: text('id').primaryKey(),
  triageItemId: text('triage_item_id').notNull().references(() => triageItems.id, { onDelete: 'cascade' }),
  actionType: text('action_type').notNull(),
  state: text('state').notNull().default('pending'),
  claimedAt: text('claimed_at').notNull(),
  completedAt: text('completed_at'),
  result: jsonb('result'),
}, (table) => [
  uniqueIndex('idx_triage_action_claims_item_action').on(table.triageItemId, table.actionType),
]);

// ─── TRIAGE CONTENT TYPE REGISTRY ────────────────────────────────────────────

export const triageContentTypes = pgTable('triage_content_types', {
  id: text('id').primaryKey(), // e.g. 'repo', 'video', 'tutorial'
  name: text('name').notNull(), // Display name e.g. 'GitHub Repos'
  icon: text('icon'), // Lucide icon name
  color: text('color').notNull().default('#6b7280'),
  builtin: boolean('builtin').notNull().default(false),
  suppressed: boolean('suppressed').notNull().default(false),
  priority: integer('priority').notNull().default(50), // Lower = checked first in detection
  urlPatterns: jsonb('url_patterns').notNull().default([]), // regex strings
  keywordHints: jsonb('keyword_hints').notNull().default([]), // terms to match in title/desc/url
  description: text('description'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// ─── TRIAGE SYNC STATE ──────────────────────────────────────────────────────

export const triageSyncState = pgTable('triage_sync_state', {
  id: text('id').primaryKey(), // e.g. 'github-stars', 'reddit-saved'
  revision: integer('revision').notNull().default(0),
  lastCursor: text('last_cursor'),
  lastSyncedAt: text('last_synced_at'),
  totalImported: integer('total_imported').notNull().default(0),
  totalSkipped: integer('total_skipped').notNull().default(0),
  lastRunImported: integer('last_run_imported').notNull().default(0),
  lastRunSkipped: integer('last_run_skipped').notNull().default(0),
  lastRunErrors: jsonb('last_run_errors').notNull().default([]),
  lastRunDurationMs: integer('last_run_duration_ms'),
});
