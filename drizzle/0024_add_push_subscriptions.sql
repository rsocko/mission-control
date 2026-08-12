-- Push notification subscriptions
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL DEFAULT 'web',
  endpoint TEXT NOT NULL,
  keys TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL
);

-- Push notification user preferences
CREATE TABLE IF NOT EXISTS push_preferences (
  id TEXT PRIMARY KEY DEFAULT 'default',
  morning_enabled INTEGER NOT NULL DEFAULT 1,
  morning_hour INTEGER NOT NULL DEFAULT 8,
  triage_nudge_enabled INTEGER NOT NULL DEFAULT 1,
  triage_nudge_threshold INTEGER NOT NULL DEFAULT 5,
  carry_forward_enabled INTEGER NOT NULL DEFAULT 1,
  carry_forward_hour INTEGER NOT NULL DEFAULT 18,
  quiet_start INTEGER,
  quiet_end INTEGER,
  updated_at TEXT NOT NULL
);
