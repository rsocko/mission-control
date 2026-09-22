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
  // SQLite's default LIKE (no ICU extension loaded) already folds only the
  // 26 ASCII letters case-insensitively and leaves non-ASCII bytes
  // case-sensitive - exactly the `asciiFoldLower` semantics documented in
  // `./notification-entity-linking` - so this query is left unchanged; only
  // the PostgreSQL adapter needs an explicit fold to match it.
  const findTaskBySuffix = sqlite.prepare(`
    SELECT id
    FROM tasks
    WHERE connector_instance_id = ?
      AND source_id LIKE ?
    ORDER BY id
    LIMIT 2
  `);
  // `json_type(...) = 'text'` excludes matches where `$.repository` is
  // missing, JSON null, or a non-string JSON scalar (number/boolean): SQLite
  // storage-class comparison rules already make `json_extract(...) = ?`
  // (a TEXT parameter) never equal a non-TEXT JSON value, but the explicit
  // guard documents that behavior and keeps it aligned with the PostgreSQL
  // adapter, whose `->>` operator stringifies any scalar and would otherwise
  // match a numeric-looking parameter.
  const findProject = sqlite.prepare(`
    SELECT id
    FROM hub_projects
    WHERE json_extract(metadata, '$.repository') = ?
      AND json_type(metadata, '$.repository') = 'text'
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
