-- Remove the triage_collections table and collection columns from triage_items.
-- Collections are replaced by direct routing to Karakeep.

DROP TABLE IF EXISTS triage_collections;

-- SQLite doesn't support DROP COLUMN, so we recreate the table without collection columns.
-- Step 1: Create the new table without collection_id and collected_at
CREATE TABLE triage_items_new (
  id TEXT PRIMARY KEY,
  source_platform TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  canonical_url TEXT,
  title TEXT NOT NULL,
  description TEXT,
  thumbnail_url TEXT,
  content_type TEXT NOT NULL DEFAULT 'link',
  captured_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  snoozed_until TEXT,
  ai_summary TEXT,
  ai_categories TEXT NOT NULL DEFAULT '[]',
  ai_suggested_actions TEXT NOT NULL DEFAULT '[]',
  ai_relevance_score INTEGER NOT NULL DEFAULT 0,
  ai_urgency TEXT NOT NULL DEFAULT 'evergreen',
  raw_metadata TEXT NOT NULL DEFAULT '{}',
  actions_taken TEXT NOT NULL DEFAULT '[]',
  source_order INTEGER
);

-- Step 2: Copy data (revert any 'collected' status items to 'pending')
INSERT INTO triage_items_new (
  id, source_platform, source_id, source_url, canonical_url, title, description,
  thumbnail_url, content_type, captured_at, ingested_at, status, snoozed_until,
  ai_summary, ai_categories, ai_suggested_actions, ai_relevance_score, ai_urgency,
  raw_metadata, actions_taken, source_order
)
SELECT
  id, source_platform, source_id, source_url, canonical_url, title, description,
  thumbnail_url, content_type, captured_at, ingested_at,
  CASE WHEN status = 'collected' THEN 'pending' ELSE status END,
  snoozed_until, ai_summary, ai_categories, ai_suggested_actions,
  ai_relevance_score, ai_urgency, raw_metadata, actions_taken, source_order
FROM triage_items;

-- Step 3: Swap tables
DROP TABLE triage_items;
ALTER TABLE triage_items_new RENAME TO triage_items;
