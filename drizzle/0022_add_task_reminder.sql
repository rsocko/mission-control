-- Add reminder_at column to tasks table for task reminders (#842)
ALTER TABLE tasks ADD COLUMN reminder_at TEXT;
