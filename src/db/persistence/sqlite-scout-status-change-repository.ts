import type Database from 'better-sqlite3';
import type {
  AcknowledgeScoutStatusChangesInput,
  ListScoutStatusChangesInput,
  ScoutStatusChangeAcknowledgement,
  ScoutStatusChangeRecord,
  ScoutStatusChangeRepository,
} from '@/lib/connectors/scout/status-change-repository';
import { SCOUT_WRITE_BACK_CURSOR_KEY } from '@/lib/connectors/scout/status-change-repository';

interface SqliteStatusChangeRow {
  mcTaskId: string;
  sourceId: string;
  sourceType: string;
  title: string;
  status: string;
  statusReason: string | null;
  updatedAt: string;
  completedAt: string | null;
  snoozedUntil: string | null;
}

interface SqliteCursorRow {
  cursor: string;
  updatedAt: string;
}

function normalizeCursor(cursor: string): string {
  const normalized = new Date(cursor);
  if (Number.isNaN(normalized.getTime())) {
    throw new Error('Scout status acknowledgement cursor is not a valid timestamp');
  }
  return normalized.toISOString();
}

const SQLITE_SOURCE_TYPE = `
  CASE
    WHEN NOT json_valid(metadata) THEN 'unknown'
    WHEN json_type(metadata) = 'object' THEN
      CASE
        WHEN json_type(metadata, '$.sourceType') = 'text'
          THEN json_extract(metadata, '$.sourceType')
        ELSE 'unknown'
      END
    WHEN json_type(metadata) = 'text' THEN
      CASE
        WHEN NOT json_valid(json_extract(metadata, '$')) THEN 'unknown'
        WHEN json_type(json_extract(metadata, '$')) = 'object' THEN
          CASE
            WHEN json_type(json_extract(metadata, '$'), '$.sourceType') = 'text'
              THEN json_extract(json_extract(metadata, '$'), '$.sourceType')
            ELSE 'unknown'
          END
        ELSE 'unknown'
      END
    ELSE 'unknown'
  END
`;

export class SqliteScoutStatusChangeRepository implements ScoutStatusChangeRepository {
  constructor(private readonly database: Database.Database) {}

  async getAcknowledgedCursor(): Promise<string | null> {
    const row = this.database.prepare(`
      SELECT
        CASE WHEN json_valid(value) THEN json_extract(value, '$') ELSE value END AS cursor
      FROM app_settings
      WHERE key = ?
    `).get(SCOUT_WRITE_BACK_CURSOR_KEY) as { cursor: string } | undefined;
    return row ? normalizeCursor(row.cursor) : null;
  }

  async listChanges(input: ListScoutStatusChangesInput) {
    if (input.sourceTypes?.length === 0) return { changes: [], hasMore: false };

    const conditions = [
      'connector_type = ?',
      'updated_at <= ?',
      ...(input.since ? ['updated_at > ?'] : []),
      ...(input.sourceTypes
        ? [`(${SQLITE_SOURCE_TYPE}) IN (${input.sourceTypes.map(() => '?').join(', ')})`]
        : []),
    ];
    const parameters: Array<string | number> = [
      'scout',
      input.through,
      ...(input.since ? [input.since] : []),
      ...(input.sourceTypes ?? []),
      input.limit + 1,
    ];
    const rows = this.database.prepare(`
      SELECT
        id AS mcTaskId,
        source_id AS sourceId,
        ${SQLITE_SOURCE_TYPE} AS sourceType,
        title,
        status,
        status_reason AS statusReason,
        updated_at AS updatedAt,
        completed_at AS completedAt,
        snoozed_until AS snoozedUntil
      FROM tasks
      WHERE ${conditions.join(' AND ')}
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(...parameters) as SqliteStatusChangeRow[];
    return {
      changes: rows.slice(0, input.limit) satisfies ScoutStatusChangeRecord[],
      hasMore: rows.length > input.limit,
    };
  }

  async acknowledge(
    input: AcknowledgeScoutStatusChangesInput,
  ): Promise<ScoutStatusChangeAcknowledgement> {
    return this.database.transaction(() => {
      const current = this.database.prepare(`
        SELECT
          CASE WHEN json_valid(value) THEN json_extract(value, '$') ELSE value END AS cursor,
          updated_at AS updatedAt
        FROM app_settings
        WHERE key = ?
      `).get(SCOUT_WRITE_BACK_CURSOR_KEY) as SqliteCursorRow | undefined;
      if (current) {
        const currentCursor = normalizeCursor(current.cursor);
        if (currentCursor >= input.acknowledgedAt) {
          return { ...current, cursor: currentCursor, advanced: false };
        }
      }

      this.database.prepare(`
        INSERT INTO app_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `).run(
        SCOUT_WRITE_BACK_CURSOR_KEY,
        JSON.stringify(input.acknowledgedAt),
        input.updatedAt,
      );
      const stored = this.database.prepare(`
        SELECT
          CASE WHEN json_valid(value) THEN json_extract(value, '$') ELSE value END AS cursor,
          updated_at AS updatedAt
        FROM app_settings
        WHERE key = ?
      `).get(SCOUT_WRITE_BACK_CURSOR_KEY) as SqliteCursorRow;
      return {
        ...stored,
        advanced: stored.cursor === input.acknowledgedAt,
      };
    }).immediate();
  }
}

export function createSqliteScoutStatusChangeRepository(
  database: Database.Database,
): ScoutStatusChangeRepository {
  return new SqliteScoutStatusChangeRepository(database);
}
