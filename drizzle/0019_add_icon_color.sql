-- Add icon_color column to list_groups and hub_projects for icon tinting
ALTER TABLE list_groups ADD COLUMN icon_color TEXT;--> statement-breakpoint
ALTER TABLE hub_projects ADD COLUMN icon_color TEXT;
