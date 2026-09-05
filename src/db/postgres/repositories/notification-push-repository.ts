import type { Pool, PoolClient } from 'pg';
import {
  DEFAULT_NOTIFICATION_PUSH_PREFERENCES,
  extractAccessToken,
  parseStoredBooleanSetting,
  type NotificationPushPersistence,
  type NotificationPushPreferences,
} from '@/db/persistence/notification-push';

const PUSH_DELIVERY_SETTING_KEY = 'push_delivery_enabled';
const SCHEDULED_SUMMARIES_SETTING_KEY = 'scheduled_summaries_enabled';
const PREFERENCES_LOCK_KEY = 'mission-control:notification-push-preferences';

interface PushPreferencesRow {
  morningEnabled: boolean;
  morningHour: number;
  triageNudgeEnabled: boolean;
  triageNudgeThreshold: number;
  carryForwardEnabled: boolean;
  carryForwardHour: number;
  quietStart: number | null;
  quietEnd: number | null;
  doNotDisturb: boolean;
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
}

function normalizePreferences(row: PushPreferencesRow | undefined): NotificationPushPreferences {
  return row ?? { ...DEFAULT_NOTIFICATION_PUSH_PREFERENCES };
}

export function createPostgresNotificationPushRepository(
  pool: Pool,
): NotificationPushPersistence {
  return {
    async getPreferences() {
      const result = await pool.query<PushPreferencesRow>(`
        SELECT
          morning_enabled AS "morningEnabled",
          morning_hour AS "morningHour",
          triage_nudge_enabled AS "triageNudgeEnabled",
          triage_nudge_threshold AS "triageNudgeThreshold",
          carry_forward_enabled AS "carryForwardEnabled",
          carry_forward_hour AS "carryForwardHour",
          quiet_start AS "quietStart",
          quiet_end AS "quietEnd",
          do_not_disturb AS "doNotDisturb"
        FROM push_preferences
        WHERE id = 'default'
      `);
      return normalizePreferences(result.rows[0]);
    },

    async getPushDeliveryEnabled() {
      const result = await pool.query<{ value: unknown }>(
        'SELECT value FROM app_settings WHERE key = $1',
        [PUSH_DELIVERY_SETTING_KEY],
      );
      return result.rows[0] ? parseStoredBooleanSetting(result.rows[0].value) : true;
    },

    async savePreferences(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [PREFERENCES_LOCK_KEY]);
        const existing = await client.query<{ value: unknown }>(
          'SELECT value FROM app_settings WHERE key = $1 FOR UPDATE',
          [PUSH_DELIVERY_SETTING_KEY],
        );
        const pushDeliveryEnabled = input.pushDeliveryEnabled
          ?? (existing.rows[0] ? parseStoredBooleanSetting(existing.rows[0].value) : true);
        const preferences = input.preferences;
        await client.query(
          `
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
            ) VALUES ('default', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT(id) DO UPDATE SET
              morning_enabled = EXCLUDED.morning_enabled,
              morning_hour = EXCLUDED.morning_hour,
              triage_nudge_enabled = EXCLUDED.triage_nudge_enabled,
              triage_nudge_threshold = EXCLUDED.triage_nudge_threshold,
              carry_forward_enabled = EXCLUDED.carry_forward_enabled,
              carry_forward_hour = EXCLUDED.carry_forward_hour,
              quiet_start = EXCLUDED.quiet_start,
              quiet_end = EXCLUDED.quiet_end,
              do_not_disturb = EXCLUDED.do_not_disturb,
              updated_at = EXCLUDED.updated_at
          `,
          [
            preferences.morningEnabled,
            preferences.morningHour,
            preferences.triageNudgeEnabled,
            preferences.triageNudgeThreshold,
            preferences.carryForwardEnabled,
            preferences.carryForwardHour,
            preferences.quietStart,
            preferences.quietEnd,
            preferences.doNotDisturb,
            input.updatedAt,
          ],
        );
        await client.query(
          `
            INSERT INTO app_settings (key, value, updated_at)
            VALUES ($1, $2::jsonb, $3)
            ON CONFLICT(key) DO UPDATE SET
              value = EXCLUDED.value,
              updated_at = EXCLUDED.updated_at
          `,
          [PUSH_DELIVERY_SETTING_KEY, JSON.stringify(pushDeliveryEnabled), input.updatedAt],
        );
        await client.query('COMMIT');
      } catch (error) {
        await rollback(client);
        throw error;
      } finally {
        client.release();
      }
    },

    async getScheduledSummariesEnabled() {
      const result = await pool.query<{ value: unknown }>(
        'SELECT value FROM app_settings WHERE key = $1',
        [SCHEDULED_SUMMARIES_SETTING_KEY],
      );
      return result.rows[0] ? parseStoredBooleanSetting(result.rows[0].value) : true;
    },

    async setScheduledSummariesEnabled(enabled, updatedAt) {
      await pool.query(
        `
          INSERT INTO app_settings (key, value, updated_at)
          VALUES ($1, $2::jsonb, $3)
          ON CONFLICT(key) DO UPDATE SET
            value = EXCLUDED.value,
            updated_at = EXCLUDED.updated_at
        `,
        [SCHEDULED_SUMMARIES_SETTING_KEY, JSON.stringify(enabled), updatedAt],
      );
    },

    async listActiveCalendarAccessTokens() {
      const result = await pool.query<{ credentials: unknown }>(`
        SELECT credentials
        FROM connector_configs
        WHERE type = 'outlook-calendar' AND enabled = true AND deleted_at IS NULL
        ORDER BY id
      `);
      return result.rows.flatMap(({ credentials }) => {
        const token = extractAccessToken(credentials);
        return token ? [token] : [];
      });
    },
  };
}
