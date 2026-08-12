-- Add do_not_disturb column to push_preferences
ALTER TABLE push_preferences ADD COLUMN do_not_disturb INTEGER NOT NULL DEFAULT 0;
