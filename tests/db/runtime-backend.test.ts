import { describe, expect, it } from 'vitest';
import db from '@/db';
import { resolveDatabaseBackend } from '@/db/runtime-backend';

describe('database backend selection', () => {
  it('preserves SQLite as the default', () => {
    expect(resolveDatabaseBackend()).toBe('sqlite');
    expect(resolveDatabaseBackend('')).toBe('sqlite');
    expect(resolveDatabaseBackend('sqlite')).toBe('sqlite');
  });

  it('selects PostgreSQL explicitly', () => {
    expect(resolveDatabaseBackend('postgres')).toBe('postgres');
  });

  it('rejects unknown values rather than falling back', () => {
    expect(() => resolveDatabaseBackend('postgresql')).toThrow(
      'MC_DATABASE_BACKEND must be sqlite or postgres',
    );
  });

  it('rejects SQLite compatibility access when PostgreSQL is selected', () => {
    const previous = process.env.MC_DATABASE_BACKEND;
    process.env.MC_DATABASE_BACKEND = 'postgres';
    try {
      expect(() => db.select).toThrow(
        'This workflow still uses the SQLite compatibility API',
      );
    } finally {
      if (previous === undefined) delete process.env.MC_DATABASE_BACKEND;
      else process.env.MC_DATABASE_BACKEND = previous;
    }
  });
});
