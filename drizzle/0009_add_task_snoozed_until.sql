-- Add snoozed_until column to tasks table for snooze quick action
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;
