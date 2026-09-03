/**
 * Proof tests for the L02 audit-blocker fix: under
 * `MC_DATABASE_BACKEND=postgres`, seed/demo entry points must fail closed
 * *before* the `better-sqlite3` driver is ever imported/constructed, and
 * must never create a stray SQLite/WAL/SHM file — instead of the pre-fix
 * behavior of `seed-api.ts` opening its own private `better-sqlite3.Database`
 * unconditionally.
 *
 * Covers the two legitimate, narrowly-scoped SQLite-only exceptions
 * documented in `docs/architecture/persistence-boundaries.md` ("Web/API
 * PostgreSQL parity: Layer L02"): `seed-api.ts`'s `clearDatabase` /
 * `resetDemoDatabase`, and `triage/lifecycle.ts`'s `clearTriageSampleData`
 * (reachable only from `/api/settings/mode`'s demo-only
 * `clear-triage-samples` action).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('seed/demo fail-closed under MC_DATABASE_BACKEND=postgres', () => {
  const originalBackend = process.env.MC_DATABASE_BACKEND;
  const originalDbPath = process.env.MC_DB_PATH;
  let scratchDir: string;
  let scratchDbPath: string;

  beforeEach(() => {
    vi.resetModules();
    scratchDir = mkdtempSync(join(tmpdir(), 'mc-l02-stray-file-'));
    scratchDbPath = join(scratchDir, 'mission-control.db');
    process.env.MC_DATABASE_BACKEND = 'postgres';
    process.env.MC_DB_PATH = scratchDbPath;
  });

  afterEach(() => {
    if (originalBackend === undefined) delete process.env.MC_DATABASE_BACKEND;
    else process.env.MC_DATABASE_BACKEND = originalBackend;
    if (originalDbPath === undefined) delete process.env.MC_DB_PATH;
    else process.env.MC_DB_PATH = originalDbPath;
    rmSync(scratchDir, { recursive: true, force: true });
    vi.doUnmock('@/db');
    vi.resetModules();
  });

  describe('poisoned-import proof (fails before the driver is touched)', () => {
    beforeEach(() => {
      // Poisons the shared `@/db` singleton the same way the real module
      // does: the exported binding itself is inert (so a legitimate static
      // `import db from '@/db'` never throws at import time — see
      // `src/lib/triage/lifecycle.ts`), and only *property access* on it
      // (i.e. actually touching the driver, exactly how `src/db/index.ts`'s
      // real lazy `Proxy` triggers `initDatabase()`/`better-sqlite3`) throws
      // distinctly from the expected fail-closed message. This catches a
      // guard-ordering regression without mocking `better-sqlite3` itself.
      const poisoned = new Proxy(
        {},
        {
          get(): never {
            throw new Error('POISON: @/db driver property was accessed');
          },
        },
      );
      vi.doMock('@/db', () => ({ default: poisoned, sqlite: poisoned }));
    });

    it('clearDatabase fails closed without touching @/db', async () => {
      const { clearDatabase } = await import('@/lib/seed-api');
      await expect(clearDatabase()).rejects.toThrow(
        'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
      );
    });

    it('resetDemoDatabase fails closed without touching @/db', async () => {
      const { resetDemoDatabase } = await import('@/lib/seed-api');
      await expect(resetDemoDatabase()).rejects.toThrow(
        'Seed/demo database management is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
      );
    });

    it('clearTriageSampleData fails closed without touching @/db', async () => {
      const { clearTriageSampleData } = await import('@/lib/triage/lifecycle');
      await expect(clearTriageSampleData()).rejects.toThrow(
        'Clearing triage demo/sample data is SQLite-only and is not available when MC_DATABASE_BACKEND=postgres',
      );
    });
  });

  describe('stray-file proof (real @/db, not mocked)', () => {
    it('creates no .db/-wal/-shm file for clearDatabase', async () => {
      const { clearDatabase } = await import('@/lib/seed-api');
      await expect(clearDatabase()).rejects.toThrow('MC_DATABASE_BACKEND=postgres');
      expect(existsSync(scratchDbPath)).toBe(false);
      expect(existsSync(`${scratchDbPath}-wal`)).toBe(false);
      expect(existsSync(`${scratchDbPath}-shm`)).toBe(false);
    });

    it('creates no .db/-wal/-shm file for resetDemoDatabase', async () => {
      const { resetDemoDatabase } = await import('@/lib/seed-api');
      await expect(resetDemoDatabase()).rejects.toThrow('MC_DATABASE_BACKEND=postgres');
      expect(existsSync(scratchDbPath)).toBe(false);
      expect(existsSync(`${scratchDbPath}-wal`)).toBe(false);
      expect(existsSync(`${scratchDbPath}-shm`)).toBe(false);
    });

    it('creates no .db/-wal/-shm file for clearTriageSampleData', async () => {
      const { clearTriageSampleData } = await import('@/lib/triage/lifecycle');
      await expect(clearTriageSampleData()).rejects.toThrow('MC_DATABASE_BACKEND=postgres');
      expect(existsSync(scratchDbPath)).toBe(false);
      expect(existsSync(`${scratchDbPath}-wal`)).toBe(false);
      expect(existsSync(`${scratchDbPath}-shm`)).toBe(false);
    });
  });

  describe('SQLite mode delegates to the shared @/db singleton (no private connection)', () => {
    const marker = Symbol('shared-sqlite-singleton');

    beforeEach(() => {
      process.env.MC_DATABASE_BACKEND = 'sqlite';
      // Stands in for the real `@/db` singleton so this test can assert
      // `clearDatabase`/`resetDemoDatabase` receive *this exact* shared
      // handle — proving `getDb()` no longer opens a private
      // `new Database(DB_PATH)` connection of its own, which was the
      // original audit-blocker bug.
      vi.doMock('@/db', () => ({
        sqlite: {
          marker,
          pragma: vi.fn((statement: string) => {
            if (statement === 'table_list') return [];
            if (statement === 'foreign_keys') return 0;
            return undefined;
          }),
          exec: vi.fn(),
          transaction: vi.fn((fn: (...args: unknown[]) => unknown) => fn),
        },
      }));
    });

    it('clearDatabase clears via the shared singleton, not a private connection', async () => {
      const { clearDatabase } = await import('@/lib/seed-api');
      await clearDatabase();
      const { sqlite } = await import('@/db');
      expect(sqlite.marker).toBe(marker);
      expect(existsSync(scratchDbPath)).toBe(false);
    });
  });
});
