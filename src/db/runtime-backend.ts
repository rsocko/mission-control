export type DatabaseBackend = 'sqlite' | 'postgres';

export function resolveDatabaseBackend(
  value = process.env.MC_DATABASE_BACKEND,
): DatabaseBackend {
  if (value === undefined || value === '' || value === 'sqlite') return 'sqlite';
  if (value === 'postgres') return 'postgres';
  throw new Error('MC_DATABASE_BACKEND must be sqlite or postgres');
}
