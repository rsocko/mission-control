import type { Pool } from 'pg';
import { dbLogger } from '@/lib/logger';
import { runPostgresVectorMigrations } from './migrations';

export const POSTGRES_HNSW_MAX_DIMENSIONS = 4_000;
export const POSTGRES_HNSW_VALIDATED_SCALE = 100_000;
export const POSTGRES_HNSW_MIN_CANDIDATES = 200;
const MINIMUM_PGVECTOR_VERSION = [0, 8, 0] as const;

export type PostgresVectorMode = 'optional' | 'required';

export type PostgresVectorCapability =
  | {
      available: true;
      mode: PostgresVectorMode;
      extensionVersion: string;
      maxDimensions: number;
    }
  | {
      available: false;
      mode: PostgresVectorMode;
      extensionVersion: null;
      reason:
        | 'extension-unavailable'
        | 'unsupported-version'
        | 'schema-unavailable'
        | 'schema-disabled';
    };

export class PostgresVectorUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PostgresVectorUnavailableError';
  }
}

export function resolvePostgresVectorMode(
  value: string | undefined = process.env.MC_POSTGRES_VECTOR_MODE,
): PostgresVectorMode {
  const mode = value?.trim().toLowerCase() || 'optional';
  if (mode === 'optional' || mode === 'required') return mode;
  throw new Error('MC_POSTGRES_VECTOR_MODE must be optional or required');
}

function isSupportedVersion(version: string): boolean {
  const parsed = version.split('.').slice(0, 3).map((part) => Number.parseInt(part, 10));
  if (parsed.length < 2 || parsed.some((part) => !Number.isSafeInteger(part) || part < 0)) {
    return false;
  }
  for (let index = 0; index < MINIMUM_PGVECTOR_VERSION.length; index++) {
    const actual = parsed[index] ?? 0;
    const minimum = MINIMUM_PGVECTOR_VERSION[index];
    if (actual > minimum) return true;
    if (actual < minimum) return false;
  }
  return true;
}

function unavailable(
  mode: PostgresVectorMode,
  reason: Extract<PostgresVectorCapability, { available: false }>['reason'],
): PostgresVectorCapability {
  if (mode === 'required') {
    const detail = reason === 'extension-unavailable'
      ? 'pgvector is not installed in this database'
      : 'the installed pgvector version is older than 0.8.0';
    throw new PostgresVectorUnavailableError(
      `PostgreSQL indexed vector retrieval is required, but ${detail}. `
      + 'Install pgvector through the database administrator bootstrap path before startup.',
    );
  }
  return { available: false, mode, extensionVersion: null, reason };
}

export async function initializePostgresVectorSupport(
  pool: Pool,
  options: {
    mode?: PostgresVectorMode;
    migrationsFolder?: string;
  } = {},
): Promise<PostgresVectorCapability> {
  const mode = options.mode ?? resolvePostgresVectorMode();
  const result = await pool.query<{ extversion: string }>(
    `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
  );
  const version = result.rows[0]?.extversion;
  if (!version) return unavailable(mode, 'extension-unavailable');
  if (!isSupportedVersion(version)) return unavailable(mode, 'unsupported-version');

  try {
    await runPostgresVectorMigrations(pool, {
      migrationsFolder: options.migrationsFolder,
    });
  } catch (error) {
    if (mode === 'required') {
      throw new PostgresVectorUnavailableError(
        'PostgreSQL indexed vector retrieval is required, but its application schema '
        + 'could not be initialized. Verify schema ownership and migration privileges.',
        { cause: error },
      );
    }
    dbLogger.warn(
      { code: errorCode(error) },
      'PostgreSQL indexed vector schema is unavailable; using bounded semantic retrieval',
    );
    return {
      available: false,
      mode,
      extensionVersion: null,
      reason: 'schema-unavailable',
    };
  }
  return {
    available: true,
    mode,
    extensionVersion: version,
    maxDimensions: POSTGRES_HNSW_MAX_DIMENSIONS,
  };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : undefined;
}

export function disabledPostgresVectorCapability(
  mode: PostgresVectorMode = 'optional',
): PostgresVectorCapability {
  return {
    available: false,
    mode,
    extensionVersion: null,
    reason: 'schema-disabled',
  };
}
