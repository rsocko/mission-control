import type { PoolConfig } from 'pg';

const DEFAULT_MAX_CONNECTIONS = 10;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;
const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS = 30_000;

export type PostgresSslMode =
  | 'disable'
  | 'require'
  | 'verify-ca'
  | 'verify-full';

export interface PostgresConfig {
  pool: PoolConfig;
  sslMode: PostgresSslMode;
}

interface PostgresEnvironment {
  MC_POSTGRES_URL?: string;
  MC_POSTGRES_SSL_MODE?: string;
  MC_POSTGRES_MIN_CONNECTIONS?: string;
  MC_POSTGRES_MAX_CONNECTIONS?: string;
  MC_POSTGRES_IDLE_TIMEOUT_MS?: string;
  MC_POSTGRES_CONNECTION_TIMEOUT_MS?: string;
  MC_POSTGRES_STATEMENT_TIMEOUT_MS?: string;
  MC_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS?: string;
  MC_POSTGRES_APPLICATION_NAME?: string;
  MC_PROCESS_ROLE?: string;
}

function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

function parseSslMode(value: string | null | undefined): PostgresSslMode {
  const mode = value || 'verify-full';
  if (mode === 'allow' || mode === 'prefer') return 'require';
  if (
    mode === 'disable'
    || mode === 'require'
    || mode === 'verify-ca'
    || mode === 'verify-full'
  ) {
    return mode;
  }
  throw new Error(
    'MC_POSTGRES_SSL_MODE must be disable, require, verify-ca, or verify-full',
  );
}

function parseConnectionString(value: string | undefined): URL {
  if (!value) {
    throw new Error('MC_POSTGRES_URL is required for the PostgreSQL backend');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('MC_POSTGRES_URL must be a valid PostgreSQL URL');
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('MC_POSTGRES_URL must use the postgres protocol');
  }
  if (!url.hostname || !url.username || url.pathname.length <= 1) {
    throw new Error(
      'MC_POSTGRES_URL must include a host, user, and database name',
    );
  }
  return url;
}

function resolveSsl(mode: PostgresSslMode): PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-ca') {
    return {
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    };
  }
  return { rejectUnauthorized: true };
}

export function resolvePostgresConfig(
  env: PostgresEnvironment = process.env,
): PostgresConfig {
  const url = parseConnectionString(env.MC_POSTGRES_URL);
  const sslMode = parseSslMode(
    env.MC_POSTGRES_SSL_MODE ?? url.searchParams.get('sslmode'),
  );
  url.searchParams.delete('sslmode');

  const max = positiveInteger(
    env.MC_POSTGRES_MAX_CONNECTIONS,
    DEFAULT_MAX_CONNECTIONS,
    'MC_POSTGRES_MAX_CONNECTIONS',
  );
  const min = nonNegativeInteger(
    env.MC_POSTGRES_MIN_CONNECTIONS,
    0,
    'MC_POSTGRES_MIN_CONNECTIONS',
  );
  if (min > max) {
    throw new Error(
      'MC_POSTGRES_MIN_CONNECTIONS cannot exceed MC_POSTGRES_MAX_CONNECTIONS',
    );
  }

  const role = env.MC_PROCESS_ROLE || 'web';
  const configuredApplicationName = env.MC_POSTGRES_APPLICATION_NAME?.trim();
  const applicationName = configuredApplicationName
    ? configuredApplicationName
    : `mission-control-${role}`;

  return {
    sslMode,
    pool: {
      host: url.hostname,
      port: url.port ? Number(url.port) : undefined,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: decodeURIComponent(url.pathname.slice(1)),
      min,
      max,
      idleTimeoutMillis: positiveInteger(
        env.MC_POSTGRES_IDLE_TIMEOUT_MS,
        DEFAULT_IDLE_TIMEOUT_MS,
        'MC_POSTGRES_IDLE_TIMEOUT_MS',
      ),
      connectionTimeoutMillis: positiveInteger(
        env.MC_POSTGRES_CONNECTION_TIMEOUT_MS,
        DEFAULT_CONNECTION_TIMEOUT_MS,
        'MC_POSTGRES_CONNECTION_TIMEOUT_MS',
      ),
      statement_timeout: positiveInteger(
        env.MC_POSTGRES_STATEMENT_TIMEOUT_MS,
        DEFAULT_STATEMENT_TIMEOUT_MS,
        'MC_POSTGRES_STATEMENT_TIMEOUT_MS',
      ),
      idle_in_transaction_session_timeout: positiveInteger(
        env.MC_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS,
        DEFAULT_IDLE_TRANSACTION_TIMEOUT_MS,
        'MC_POSTGRES_IDLE_TRANSACTION_TIMEOUT_MS',
      ),
      application_name: applicationName,
      keepAlive: true,
      allowExitOnIdle: min === 0,
      ssl: resolveSsl(sslMode),
    },
  };
}
