import type { Pool } from 'pg';
import type {
  NotificationEntityLinkingRepository,
} from '@/db/persistence/notification-entity-linking';
import {
  ASCII_LOWER,
  ASCII_UPPER,
  asciiFoldLower,
} from '@/db/persistence/notification-entity-linking';

export function createPostgresNotificationEntityLinkingRepository(
  pool: Pool,
): NotificationEntityLinkingRepository {
  return {
    async findTaskBySourceReference(input) {
      const sourceId = `${input.repository}:${input.number}`;
      const exact = await pool.query<{ id: string }>(
        `SELECT id
         FROM tasks
         WHERE connector_instance_id = $1
           AND source_id = $2
         LIMIT 1`,
        [input.connectorInstanceId, sourceId],
      );
      if (exact.rows[0]) return exact.rows[0];
      // Postgres's plain LIKE is always case-sensitive, and ILIKE is
      // locale-aware (not equivalent to SQLite's ASCII-only default LIKE
      // fold - see `asciiFoldLower`'s docs). `translate()` folds only the
      // 26 ASCII letters in the column, matched against a parameter folded
      // the same way in JS, so both sides fold identically and no
      // non-ASCII character is ever folded, exactly mirroring
      // `sqlite-notification-entity-linking-repository.ts`.
      const fallback = await pool.query<{ id: string }>(
        `SELECT id
         FROM tasks
         WHERE connector_instance_id = $1
           AND translate(source_id, $3, $4) LIKE $2
         ORDER BY id
         LIMIT 2`,
        [input.connectorInstanceId, asciiFoldLower(`%${sourceId}`), ASCII_UPPER, ASCII_LOWER],
      );
      return fallback.rows.length === 1 ? fallback.rows[0] : null;
    },
    async findProjectByRepository(repository) {
      // `jsonb_typeof(...) = 'string'` excludes missing/JSON-null keys and
      // non-string JSON scalars (number/boolean): unlike SQLite's
      // `json_extract`, Postgres's `->>` stringifies any scalar, so without
      // this guard a numeric-looking `repository` parameter could match a
      // JSON number - see `sqlite-notification-entity-linking-repository.ts`
      // for the equivalent `json_type(...) = 'text'` guard.
      const result = await pool.query<{ id: string }>(
        `SELECT id
         FROM hub_projects
         WHERE metadata ->> 'repository' = $1
           AND jsonb_typeof(metadata -> 'repository') = 'string'
         ORDER BY id
         LIMIT 2`,
        [repository],
      );
      return result.rows.length === 1 ? result.rows[0].id : null;
    },
  };
}
