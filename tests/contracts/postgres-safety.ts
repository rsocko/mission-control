import { assessNonProductionDatabaseTarget } from '@/lib/non-production-database-target';

/**
 * Safety guard for PostgreSQL integration tests that run destructive DDL/DML.
 * Locality alone is insufficient because a local server can host a restored
 * production database; the database name must be explicitly test-marked.
 */
export function assertSafeIntegrationTestTarget(connectionString: string): void {
  const result = assessNonProductionDatabaseTarget(
    connectionString,
    ['postgres:', 'postgresql:'],
  );
  if (result.safe) return;

  switch (result.issue) {
    case 'invalid-url':
      throw new Error('MC_TEST_POSTGRES_URL must be a valid PostgreSQL connection URL');
    case 'invalid-protocol':
      throw new Error(
        `MC_TEST_POSTGRES_URL must use the postgres:// or postgresql:// protocol `
        + `(got "${result.protocol}"). Refusing to run destructive integration tests against a `
        + 'connection string that is not unambiguously PostgreSQL.',
      );
    case 'invalid-database-name':
      throw new Error('MC_TEST_POSTGRES_URL contains an invalid encoded database name');
    case 'production-looking':
      throw new Error(
        `Refusing to run destructive PostgreSQL integration tests against a target that looks like `
        + `production (host="${result.host}", database="${result.database}"). Point `
        + 'MC_TEST_POSTGRES_URL at a local or clearly-named test database instead.',
      );
    case 'missing-non-production-marker':
      throw new Error(
        `Refusing to run destructive PostgreSQL integration tests against a database that is not `
        + `clearly marked for testing (host="${result.host}", database="${result.database}"). `
        + 'The database name must contain a delimited "test", "ci", "dev", "sandbox", or "local" '
        + 'token - being on localhost/127.0.0.1 is not sufficient on its own.',
      );
  }
}
