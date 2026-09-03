import Database from 'better-sqlite3';
import {
  createSqliteNotificationEntityLinkingRepository,
} from '@/db/persistence/sqlite-notification-entity-linking-repository';
import {
  describeNotificationEntityLinkingContract,
} from '../contracts/notification-entity-linking.contract';

describeNotificationEntityLinkingContract('SQLite', () => {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      connector_instance_id TEXT NOT NULL,
      source_id TEXT NOT NULL
    );
    CREATE TABLE hub_projects (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL
    );
  `);

  return {
    repository: createSqliteNotificationEntityLinkingRepository(sqlite),
    seedTask: (input) => {
      sqlite.prepare(
        'INSERT INTO tasks (id, connector_instance_id, source_id) VALUES (?, ?, ?)',
      ).run(input.id, input.connectorInstanceId, input.sourceId);
    },
    seedProject: (input) => {
      const metadata = input.repositoryJsonValue === undefined
        ? '{}'
        : `{"repository":${input.repositoryJsonValue}}`;
      sqlite.prepare(
        'INSERT INTO hub_projects (id, metadata) VALUES (?, ?)',
      ).run(input.id, metadata);
    },
    close: () => {
      sqlite.close();
    },
  };
});
