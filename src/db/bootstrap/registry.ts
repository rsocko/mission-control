import type Database from 'better-sqlite3';
import { SqliteDatabaseBootstrapAdapter } from './sqlite-bootstrap-adapter';

export {
  createOrderedBootstrapSteps,
  type DatabaseBootstrapStep,
  SqliteDatabaseBootstrapAdapter,
} from './sqlite-bootstrap-adapter';

export function runOrderedDatabaseBootstrap(
  sqlite: Database.Database,
  migrationsFolder: string,
): void {
  new SqliteDatabaseBootstrapAdapter(sqlite, migrationsFolder).initializeSync();
}
