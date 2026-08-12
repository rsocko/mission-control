-- Add hidden flag to hub_projects for show/hide toggle
ALTER TABLE hub_projects ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
