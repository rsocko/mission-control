import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated by PostgreSQL notification push');
});

const OWNED_RUNTIME_PATHS = [
  'src/app/api/push/preferences/route.ts',
  'src/app/api/push/scheduler/route.ts',
  'src/lib/notifications/quiet-hours.ts',
  'src/lib/push/notification-push-service.ts',
  'src/lib/push/scheduler.ts',
] as const;

describe('notification push PostgreSQL import safety', () => {
  it('imports both routes without evaluating SQLite', async () => {
    await expect(import('@/app/api/push/preferences/route')).resolves.toBeDefined();
    await expect(import('@/app/api/push/scheduler/route')).resolves.toBeDefined();
  });

  it.each(OWNED_RUNTIME_PATHS)('%s has no SQLite handle, driver, or deferred fallback', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).not.toMatch(/from\s*['"]@\/db['"]/);
    expect(source).not.toMatch(/import\(\s*['"]@\/db['"]\s*\)/);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
  });

  it('keeps the PostgreSQL adapter independent from SQLite persistence', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/db/postgres/repositories/notification-push-repository.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/better-sqlite3|sqlite-notification|persistence\/sqlite/);
    expect(source).not.toMatch(/from\s*['"]@\/db['"]/);
  });
});
