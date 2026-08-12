-- Add is_bulk_import flag to tasks table.
-- Tasks imported during a connector's first sync are flagged so the insights
-- "created" metric can exclude them (they pre-existed in the source system).
ALTER TABLE tasks ADD COLUMN is_bulk_import INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
-- Backfill strategy: A task is a bulk import if its source created_at is
-- BEFORE the earliest time that specific source list (repo/list) was synced.
-- This handles repos/lists added to a connector at different times.
--
-- Step 1: Flag tasks whose created_at is before the earliest last_synced_at
-- for any task in the same connector + source_list_id group.
-- This correctly handles repos added weeks after the connector was first set up.
UPDATE tasks SET is_bulk_import = 1
WHERE id IN (
  SELECT t.id FROM tasks t
  INNER JOIN (
    SELECT connector_instance_id, source_list_id, MIN(last_synced_at) AS first_synced_at
    FROM tasks
    WHERE source_list_id IS NOT NULL
    GROUP BY connector_instance_id, source_list_id
  ) first_sync
    ON first_sync.connector_instance_id = t.connector_instance_id
    AND first_sync.source_list_id = t.source_list_id
  WHERE t.created_at < first_sync.first_synced_at
);
--> statement-breakpoint
-- Step 2: For tasks without a source_list_id, fall back to connector-level check.
UPDATE tasks SET is_bulk_import = 1
WHERE id IN (
  SELECT t.id FROM tasks t
  INNER JOIN (
    SELECT connector_instance_id, MIN(last_synced_at) AS first_synced_at
    FROM tasks
    GROUP BY connector_instance_id
  ) first_sync
    ON first_sync.connector_instance_id = t.connector_instance_id
  WHERE t.source_list_id IS NULL
    AND t.is_bulk_import = 0
    AND t.created_at < first_sync.first_synced_at
);
--> statement-breakpoint
-- Step 3: Also flag tasks synced on their list's very first sync day whose
-- created_at matches the sync timestamp (connector didn't provide a date).
UPDATE tasks SET is_bulk_import = 1
WHERE id IN (
  SELECT t.id FROM tasks t
  INNER JOIN (
    SELECT connector_instance_id, source_list_id, MIN(last_synced_at) AS first_synced_at
    FROM tasks
    GROUP BY connector_instance_id, source_list_id
  ) first_sync
    ON first_sync.connector_instance_id = t.connector_instance_id
    AND first_sync.source_list_id IS t.source_list_id
  WHERE t.is_bulk_import = 0
    AND abs(julianday(t.created_at) - julianday(t.last_synced_at)) < 0.007
    AND t.last_synced_at = first_sync.first_synced_at
);
--> statement-breakpoint
-- Recover created_at for child/checklist tasks: if a subtask's created_at was
-- set to `now` during sync (close to last_synced_at) but its parent has a real
-- source creation date, inherit the parent's date.
UPDATE tasks SET created_at = (
  SELECT p.created_at FROM tasks p WHERE p.id = tasks.parent_id
)
WHERE parent_id IS NOT NULL
AND abs(julianday(created_at) - julianday(last_synced_at)) < 0.007
AND parent_id IN (
  SELECT p.id FROM tasks p
  WHERE abs(julianday(p.created_at) - julianday(p.last_synced_at)) >= 0.007
);
