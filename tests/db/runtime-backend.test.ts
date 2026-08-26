import { describe, expect, it } from 'vitest';
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
});

