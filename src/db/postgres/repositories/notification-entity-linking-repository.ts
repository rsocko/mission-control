import type { Pool } from 'pg';
import type {
  NotificationEntityLinkingRepository,
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
      const fallback = await pool.query<{ id: string }>(
        `SELECT id
         FROM tasks
         WHERE connector_instance_id = $1
           AND source_id LIKE $2
         ORDER BY id
         LIMIT 2`,
        [input.connectorInstanceId, `%${sourceId}`],
      );
      return fallback.rows.length === 1 ? fallback.rows[0] : null;
    },
    async findProjectByRepository(repository) {
      const result = await pool.query<{ id: string }>(
        `SELECT id
         FROM hub_projects
         WHERE metadata ->> 'repository' = $1
         ORDER BY id
         LIMIT 2`,
        [repository],
      );
      return result.rows.length === 1 ? result.rows[0].id : null;
    },
  };
}
