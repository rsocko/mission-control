/**
 * Safety guard for PostgreSQL integration tests that run against a real
 * database via `MC_TEST_POSTGRES_URL`. These tests execute destructive
 * DDL/DML (temporary tables, inserts, deletes) so this guard refuses to run
 * against anything that isn't unambiguously a local/test database, even if
 * `MC_TEST_POSTGRES_URL` is set.
 *
 * Being on `localhost`/`127.0.0.1` is NOT sufficient on its own — a
 * developer's local Postgres can just as easily host a restored production
 * snapshot. The *database name* must still be explicitly test-marked
 * (contain a delimited "test", "ci", "dev", "sandbox", or "local" token)
 * regardless of host.
 *
 * Not a test file itself — shared by `tests/db/postgres-*-repository*.test.ts`
 * integration suites (matches the `tests/contracts/postgres*.ts` naming
 * pattern reserved for this PostgreSQL adapter work).
 */

function isPostgresProtocol(protocol: string): boolean {
  return protocol === 'postgres:' || protocol === 'postgresql:';
}

function looksLikeProduction(host: string, database: string): boolean {
  const needle = /prod(uction)?/i;
  return needle.test(host) || needle.test(database);
}

function looksLikeTestDatabase(database: string): boolean {
  const needle = /(?:^|[-_.])(test|tests|testing|ci|dev|sandbox|local)(?:[-_.]|$)/i;
  return needle.test(database);
}

/**
 * Validates that `connectionString` is safe for destructive integration
 * tests. Throws (rather than silently skipping) when the target isn't
 * unambiguously safe, so a misconfigured `MC_TEST_POSTGRES_URL` fails loudly
 * instead of quietly mutating a real database.
 */
export function assertSafeIntegrationTestTarget(connectionString: string): void {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('MC_TEST_POSTGRES_URL must be a valid PostgreSQL connection URL');
  }

  if (!isPostgresProtocol(url.protocol)) {
    throw new Error(
      `MC_TEST_POSTGRES_URL must use the postgres:// or postgresql:// protocol `
      + `(got "${url.protocol}"). Refusing to run destructive integration tests against a `
      + 'connection string that is not unambiguously PostgreSQL.',
    );
  }

  const host = url.hostname;
  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  } catch {
    throw new Error('MC_TEST_POSTGRES_URL contains an invalid encoded database name');
  }

  if (looksLikeProduction(host, database)) {
    throw new Error(
      `Refusing to run destructive PostgreSQL integration tests against a target that looks like `
      + `production (host="${host}", database="${database}"). Point MC_TEST_POSTGRES_URL at a local `
      + 'or clearly-named test database instead.',
    );
  }

  // Host alone (even localhost/127.0.0.1) never grants safety — the database
  // name itself must be test-marked, since a local Postgres instance can
  // just as easily host a restored production/shared database.
  if (!looksLikeTestDatabase(database)) {
    throw new Error(
      `Refusing to run destructive PostgreSQL integration tests against a database that is not `
      + `clearly marked for testing (host="${host}", database="${database}"). The database name `
      + 'must contain a delimited "test", "ci", "dev", "sandbox", or "local" token — being on localhost/127.0.0.1 is '
      + 'not sufficient on its own.',
    );
  }
}
