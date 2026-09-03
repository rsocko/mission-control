import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  events: [] as string[],
  failSafetyNetCount: 0,
}));

vi.mock('better-sqlite3', () => {
  class FakeDatabase {
    inTransaction = false;

    constructor(databasePath: string) {
      state.events.push(`open:${databasePath}`);
    }

    pragma(statement: string): void {
      state.events.push(`pragma:${statement}`);
    }

    exec(sql: string): void {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.events.push(`exec:${normalized}`);
      if (
        state.failSafetyNetCount > 0
        && normalized.startsWith('CREATE TABLE IF NOT EXISTS task_field_states')
      ) {
        state.failSafetyNetCount--;
        throw new Error('safety-net failure');
      }
    }

    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      state.events.push(`prepare:${normalized}`);
      return {
        all: vi.fn(() => []),
        get: vi.fn(() => undefined),
        run: vi.fn(() => undefined),
      };
    }

    transaction(callback: () => void) {
      state.events.push('transaction:create');
      return () => {
        state.events.push('transaction:run');
        callback();
      };
    }

    close(): void {
      state.events.push('close');
    }
  }

  return { default: FakeDatabase };
});

vi.mock('drizzle-orm/better-sqlite3', () => ({
  drizzle: vi.fn(() => {
    state.events.push('drizzle');
    return { transaction: vi.fn() };
  }),
}));

vi.mock('@/db/schema', () => ({}));

vi.mock('fs', () => {
  const fileSystem = {
    existsSync: vi.fn((candidate: string) => {
      state.events.push(`exists:${candidate}`);
      return false;
    }),
    mkdirSync: vi.fn((candidate: string) => {
      state.events.push(`mkdir:${candidate}`);
    }),
    readFileSync: vi.fn(),
  };
  return { ...fileSystem, default: fileSystem };
});

vi.mock('@/lib/notifications/providers/registry', () => ({
  getNotificationProvider: vi.fn(),
  normalizeNotificationUrl: vi.fn(),
  registerNotificationProvider: vi.fn(),
}));

vi.mock('@/lib/telemetry/database', () => ({
  createObservedDatabase: vi.fn((database: unknown) => {
    state.events.push('observe');
    return database;
  }),
  DatabaseTelemetryCollector: class {
    reset(): void {
      state.events.push('telemetry:reset');
    }

    snapshot(): Record<string, never> {
      return {};
    }

    withoutObservation<T>(callback: () => T): T {
      return callback();
    }
  },
}));

vi.mock('@/lib/logger', () => ({
  dbLogger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const originalEnvironment = { ...process.env };

function eventIndex(prefix: string, occurrence = 0): number {
  let remaining = occurrence;
  return state.events.findIndex((event) => {
    if (!event.startsWith(prefix)) return false;
    if (remaining > 0) {
      remaining--;
      return false;
    }
    return true;
  });
}

beforeEach(() => {
  vi.resetModules();
  state.events.length = 0;
  state.failSafetyNetCount = 0;
  process.env = {
    ...originalEnvironment,
    MC_DB_PATH: 'C:\\database-tests\\mission-control.db',
    MC_PROCESS_ROLE: 'web',
    MC_DATABASE_INITIALIZER_ROLE: 'web',
    MC_DB_BUSY_TIMEOUT_MS: '3210',
  };
});

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('database bootstrap characterization', () => {
  it('configures the connection, schema, and repairs in the established order', async () => {
    const { initializeDatabase } = await import('@/db');

    initializeDatabase();

    const open = eventIndex('open:');
    const wal = eventIndex('pragma:journal_mode = WAL');
    const foreignKeys = eventIndex('pragma:foreign_keys = ON');
    const busyTimeout = eventIndex('pragma:busy_timeout = 3210');
    const observe = eventIndex('observe');
    const drizzle = eventIndex('drizzle');
    const firstSafetyNet = eventIndex(
      'exec:CREATE TABLE IF NOT EXISTS task_field_states',
    );
    const finalSafetyNet = eventIndex(
      'exec:CREATE TABLE IF NOT EXISTS sync_deletion_candidates',
    );
    const repair = eventIndex('transaction:run');
    const publishComplete = eventIndex('telemetry:reset');

    expect([
      open,
      wal,
      foreignKeys,
      busyTimeout,
      observe,
      drizzle,
      firstSafetyNet,
      finalSafetyNet,
      repair,
      publishComplete,
    ]).toEqual([...[
      open,
      wal,
      foreignKeys,
      busyTimeout,
      observe,
      drizzle,
      firstSafetyNet,
      finalSafetyNet,
      repair,
      publishComplete,
    ]].sort((left, right) => left - right));
    expect(open).toBeGreaterThanOrEqual(0);

    const eventCount = state.events.length;
    initializeDatabase();
    expect(state.events).toHaveLength(eventCount);
  });

  it('keeps worker connections read-ready without running owner bootstrap work', async () => {
    process.env.MC_PROCESS_ROLE = 'worker';
    const { initializeDatabase } = await import('@/db');

    initializeDatabase();

    expect(state.events).toContain('pragma:foreign_keys = ON');
    expect(state.events).toContain('pragma:busy_timeout = 3210');
    expect(state.events).not.toContain('pragma:journal_mode = WAL');
    expect(state.events.some(event => event.startsWith('exec:'))).toBe(false);
    expect(state.events).not.toContain('transaction:run');
  });

  it('propagates bootstrap failures and clears partial state before retrying', async () => {
    state.failSafetyNetCount = 1;
    const { initializeDatabase } = await import('@/db');

    expect(() => initializeDatabase()).toThrow('safety-net failure');
    initializeDatabase();

    const firstOpen = eventIndex('open:');
    const close = eventIndex('close');
    const secondOpen = eventIndex('open:', 1);
    expect(firstOpen).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(firstOpen);
    expect(secondOpen).toBeGreaterThan(close);
    expect(state.events.filter(event => event === 'telemetry:reset')).toHaveLength(1);
  });
});
