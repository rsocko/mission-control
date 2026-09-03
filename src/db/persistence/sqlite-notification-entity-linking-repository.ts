import type Database from 'better-sqlite3';
import type {
  NotificationEntityLinkingRepository,
} from './notification-entity-linking';

export function createSqliteNotificationEntityLinkingRepository(
  sqlite: Database.Database,
): NotificationEntityLinkingRepository {
  const findExactTask = sqlite.prepare(`
    SELECT id
    FROM tasks
    WHERE connector_instance_id = ?
      AND source_id = ?
    LIMIT 1
  `);
  const findTaskBySuffix = sqlite.prepare(`
    SELECT id
    FROM tasks
    WHERE connector_instance_id = ?
      AND source_id LIKE ?
    ORDER BY id
    LIMIT 2
  `);
  const findProject = sqlite.prepare(`
    SELECT id
    FROM hub_projects
    WHERE json_extract(metadata, '$.repository') = ?
    ORDER BY id
    LIMIT 2
  `);

  return {
    async findTaskBySourceReference(input) {
      const sourceId = `${input.repository}:${input.number}`;
      const exact = findExactTask.get(
        input.connectorInstanceId,
        sourceId,
      ) as { id: string } | undefined;
      if (exact) return exact;
      const fallback = findTaskBySuffix.all(
        input.connectorInstanceId,
        `%${sourceId}`,
      ) as { id: string }[];
      return fallback.length === 1 ? fallback[0] : null;
    },
    async findProjectByRepository(repository) {
      const rows = findProject.all(repository) as { id: string }[];
      return rows.length === 1 ? rows[0].id : null;
    },
  };
}
