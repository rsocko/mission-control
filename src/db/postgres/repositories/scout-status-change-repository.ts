import type { Pool } from 'pg';
import type {
  AcknowledgeScoutStatusChangesInput,
  ListScoutStatusChangesInput,
  ScoutStatusChangeAcknowledgement,
  ScoutStatusChangeRecord,
  ScoutStatusChangeRepository,
} from '@/lib/connectors/scout/status-change-repository';
import { SCOUT_WRITE_BACK_CURSOR_KEY } from '@/lib/connectors/scout/status-change-repository';

function normalizeCursor(cursor: string): string {
  const normalized = new Date(cursor);
  if (Number.isNaN(normalized.getTime())) {
    throw new Error('Scout status acknowledgement cursor is not a valid timestamp');
  }
  return normalized.toISOString();
}

export class PostgresScoutStatusChangeRepository implements ScoutStatusChangeRepository {
  constructor(private readonly pool: Pool) {}

  async getAcknowledgedCursor(): Promise<string | null> {
    const result = await this.pool.query<{ cursor: string }>(`
      SELECT value #>> '{}' AS cursor
      FROM app_settings
      WHERE key = $1
    `, [SCOUT_WRITE_BACK_CURSOR_KEY]);
    const cursor = result.rows[0]?.cursor;
    return cursor ? normalizeCursor(cursor) : null;
  }

  async listChanges(input: ListScoutStatusChangesInput) {
    if (input.sourceTypes?.length === 0) return { changes: [], hasMore: false };

    const result = await this.pool.query<ScoutStatusChangeRecord>(`
      WITH metadata_decoded AS (
        SELECT
          id,
          source_id,
          title,
          status,
          status_reason,
          updated_at,
          completed_at,
          snoozed_until,
          CASE
            WHEN jsonb_typeof(metadata) = 'string' THEN
              CASE
                WHEN pg_input_is_valid(metadata #>> '{}', 'jsonb')
                  THEN (metadata #>> '{}')::jsonb
                ELSE NULL
              END
            ELSE metadata
          END AS decoded_metadata
        FROM tasks
        WHERE connector_type = 'scout'
          AND updated_at <= $1
          AND ($2::text IS NULL OR updated_at > $2)
      ),
      decoded AS (
        SELECT
          id AS "mcTaskId",
          source_id AS "sourceId",
          CASE
            WHEN jsonb_typeof(decoded_metadata) = 'object'
              AND jsonb_typeof(decoded_metadata -> 'sourceType') = 'string'
              THEN decoded_metadata ->> 'sourceType'
            ELSE 'unknown'
          END AS "sourceType",
          title,
          status,
          status_reason AS "statusReason",
          updated_at AS "updatedAt",
          completed_at AS "completedAt",
          snoozed_until AS "snoozedUntil"
        FROM metadata_decoded
      )
      SELECT *
      FROM decoded
      WHERE $3::text[] IS NULL OR "sourceType" = ANY($3::text[])
      ORDER BY "updatedAt" ASC, "mcTaskId" ASC
      LIMIT $4
    `, [
      input.through,
      input.since,
      input.sourceTypes,
      input.limit + 1,
    ]);
    return {
      changes: result.rows.slice(0, input.limit),
      hasMore: result.rows.length > input.limit,
    };
  }

  async acknowledge(
    input: AcknowledgeScoutStatusChangesInput,
  ): Promise<ScoutStatusChangeAcknowledgement> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [SCOUT_WRITE_BACK_CURSOR_KEY],
      );
      const current = await client.query<{ cursor: string; updatedAt: string }>(`
        SELECT value #>> '{}' AS cursor, updated_at AS "updatedAt"
        FROM app_settings
        WHERE key = $1
      `, [SCOUT_WRITE_BACK_CURSOR_KEY]);
      const existing = current.rows[0];
      if (existing) {
        const currentCursor = normalizeCursor(existing.cursor);
        if (currentCursor >= input.acknowledgedAt) {
          await client.query('COMMIT');
          return { ...existing, cursor: currentCursor, advanced: false };
        }
      }

      const result = await client.query<{ cursor: string; updatedAt: string }>(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES ($1, to_jsonb($2::text), $3)
        ON CONFLICT(key) DO UPDATE SET
          value = EXCLUDED.value,
          updated_at = EXCLUDED.updated_at
        RETURNING value #>> '{}' AS cursor, updated_at AS "updatedAt"
      `, [
        SCOUT_WRITE_BACK_CURSOR_KEY,
        input.acknowledgedAt,
        input.updatedAt,
      ]);
      await client.query('COMMIT');
      return { ...result.rows[0], advanced: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createPostgresScoutStatusChangeRepository(
  pool: Pool,
): ScoutStatusChangeRepository {
  return new PostgresScoutStatusChangeRepository(pool);
}
