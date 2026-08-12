-- Add source_order column to triage_items for preserving import ordering
ALTER TABLE `triage_items` ADD COLUMN `source_order` integer;
