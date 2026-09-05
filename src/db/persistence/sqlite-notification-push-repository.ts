import type Database from 'better-sqlite3';
import {
  DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
  extractAccessToken,
  parseStoredBooleanSetting,
  type NotificationPushPersistence,
  type NotificationPushPreferences,
  type SaveNotificationPushPreferencesInput,
} from './notification-push';

const PUSH_DELIVERY_SETTING_KEY = 'push_delivery_enabled';
const SCHEDULED_SUMMARIES_SETTING_KEY = 'scheduled_summaries_enabled';

interface PushPreferencesRow {
  morning_enabled: number;
  morning_hour: number;
  triage_nudge_enabled: number;
  triage_nudge_threshold: number;
  carry_forward_enabled: number;
  carry_forward_hour: number;
  quiet_start: number | null;
  quiet_end: number | null;
  do_not_disturb: number;
}

function parseSqliteJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) as unknown : value;
}

function normalizePreferences(row: PushPreferencesRow | undefined): NotificationPushPreferences {
  if (!row) return { ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES };
  return {
    morningEnabled: Boolean(row.morning_enabled),
    morningHour: row.morning_hour,
    triageNudgeEnabled: Boolean(row.triage_nudge_enabled),
    triageNudgeThreshold: row.triage_nudge_threshold,
    carryForwardEnabled: Boolean(row.carry_forward_enabled),
    carryForwardHour: row.carry_forward_hour,
    quietStart: row.quiet_start,
    quietEnd: row.quiet_end,
    doNotDisturb: Boolean(row.do_not_disturb),
  };
}

export function createSqliteNotificationPushRepository(
  sqlite: Database.Database,
): NotificationPushPersistence {
  const readPreferences = sqlite.prepare(`
    SELECT
      morning_enabled,
      morning_hour,
      triage_nudge_enabled,
      triage_nudge_threshold,
      carry_forward_enabled,
      carry_forward_hour,
      quiet_start,
      quiet_end,
      do_not_disturb
    FROM push_preferences
    WHERE id = 'default'
  `);
  const readSetting = sqlite.prepare('SELECT value FROM app_settings WHERE key = ?');
  const upsertPreferences = sqlite.prepare(`
    INSERT INTO push_preferences (
      id,
      morning_enabled,
      morning_hour,
      triage_nudge_enabled,
      triage_nudge_threshold,
      carry_forward_enabled,
      carry_forward_hour,
      quiet_start,
      quiet_end,
      do_not_disturb,
      updated_at
    ) VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      morning_enabled = excluded.morning_enabled,
      morning_hour = excluded.morning_hour,
      triage_nudge_enabled = excluded.triage_nudge_enabled,
      triage_nudge_threshold = excluded.triage_nudge_threshold,
      carry_forward_enabled = excluded.carry_forward_enabled,
      carry_forward_hour = excluded.carry_forward_hour,
      quiet_start = excluded.quiet_start,
      quiet_end = excluded.quiet_end,
      do_not_disturb = excluded.do_not_disturb,
      updated_at = excluded.updated_at
  `);
  const upsertSetting = sqlite.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `);
  const savePreferences = sqlite.transaction((input: SaveNotificationPushPreferencesInput) => {
    const existingDelivery = readSetting.get(PUSH_DELIVERY_SETTING_KEY) as
      | { value: unknown }
      | undefined;
    const pushDeliveryEnabled = input.pushDeliveryEnabled
      ?? (existingDelivery
        ? parseStoredBooleanSetting(parseSqliteJson(existingDelivery.value))
        : true);
    const preferences = input.preferences;
    upsertPreferences.run(
      preferences.morningEnabled ? 1 : 0,
      preferences.morningHour,
      preferences.triageNudgeEnabled ? 1 : 0,
      preferences.triageNudgeThreshold,
      preferences.carryForwardEnabled ? 1 : 0,
      preferences.carryForwardHour,
      preferences.quietStart,
      preferences.quietEnd,
      preferences.doNotDisturb ? 1 : 0,
      input.updatedAt,
    );
    upsertSetting.run(
      PUSH_DELIVERY_SETTING_KEY,
      JSON.stringify(pushDeliveryEnabled),
      input.updatedAt,
    );
  });

  return {
    async getPreferences() {
      return normalizePreferences(readPreferences.get() as PushPreferencesRow | undefined);
    },

    async getPushDeliveryEnabled() {
      const row = readSetting.get(PUSH_DELIVERY_SETTING_KEY) as { value: unknown } | undefined;
      return row ? parseStoredBooleanSetting(parseSqliteJson(row.value)) : true;
    },

    async savePreferences(input) {
      savePreferences.immediate(input);
    },

    async getScheduledSummariesEnabled() {
      const row = readSetting.get(SCHEDULED_SUMMARIES_SETTING_KEY) as
        | { value: unknown }
        | undefined;
      return row ? parseStoredBooleanSetting(parseSqliteJson(row.value)) : true;
    },

    async setScheduledSummariesEnabled(enabled, updatedAt) {
      upsertSetting.run(
        SCHEDULED_SUMMARIES_SETTING_KEY,
        JSON.stringify(enabled),
        updatedAt,
      );
    },

    async listActiveCalendarAccessTokens() {
      const rows = sqlite.prepare(`
        SELECT credentials
        FROM connector_configs
        WHERE type = 'outlook-calendar' AND enabled = 1 AND deleted_at IS NULL
        ORDER BY id
      `).all() as Array<{ credentials: unknown }>;
      return rows.flatMap(({ credentials }) => {
        const token = extractAccessToken(parseSqliteJson(credentials));
        return token ? [token] : [];
      });
    },
  };
}
