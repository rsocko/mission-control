import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// This suite exercises real drizzle query building (`db.update(...).where(eq(...))`
// inside `mergeConnectorSettings`) against a real temp SQLite database, so it needs
// the genuine `drizzle-orm` operators rather than the lightweight structural mock
// installed globally in tests/setup.ts (which only supports shallow inspection, not
// actual SQL compilation/execution).
vi.unmock('drizzle-orm');

const testDirectory = mkdtempSync(join(tmpdir(), 'mc-connector-config-store-'));
process.env.MC_DB_PATH = join(testDirectory, 'connector-config-store.db');

describe('shared connector config store', () => {
  let db: typeof import('@/db').default;
  let sqlite: typeof import('@/db').sqlite;
  let schema: typeof import('@/db/schema');
  let mergeConnectorSettings: typeof import(
    '@/lib/connectors/shared/connector-config-store'
  ).mergeConnectorSettings;
  let patchConnectorSettingsState: typeof import(
    '@/lib/connectors/shared/connector-config-store'
  ).patchConnectorSettingsState;

  beforeAll(async () => {
    vi.resetModules();
    const database = await import('@/db');
    const schemaModule = await import('@/db/schema');
    const store = await import('@/lib/connectors/shared/connector-config-store');
    db = database.default;
    sqlite = database.sqlite;
    schema = schemaModule;
    mergeConnectorSettings = store.mergeConnectorSettings;
    patchConnectorSettingsState = store.patchConnectorSettingsState;
  });

  afterAll(() => {
    sqlite?.close();
    rmSync(testDirectory, { recursive: true, force: true });
    delete process.env.MC_DB_PATH;
  });

  async function insertConnector(id: string, settings: Record<string, unknown>) {
    const now = new Date().toISOString();
    await db.insert(schema.connectorConfigs).values({
      id,
      type: 'github-issues',
      name: id,
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 5,
      capabilities: {} as import('@/types').ConnectorCapabilities,
      credentials: {},
      settings,
      syncedLists: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  function readRawSettings(id: string): unknown {
    const row = sqlite.prepare(
      'SELECT settings FROM connector_configs WHERE id = ?',
    ).get(id) as { settings: string };
    return JSON.parse(row.settings) as unknown;
  }

  describe('mergeConnectorSettings', () => {
    // NOTE: `mergeConnectorSettings` intentionally preserves the historical
    // `testConnection()` write path byte-for-byte: it manually
    // `JSON.stringify`s the merged settings object before calling
    // `.set({ settings: ... })`. Because the `settings` column is declared
    // with `{ mode: 'json' }`, drizzle's own `mapToDriverValue` JSON-encodes
    // whatever it is given a second time, so the column ends up holding a
    // *double*-encoded JSON string. This is a pre-existing quirk of the code
    // being extracted here (not introduced by this refactor) - the in-memory
    // return value from `mergeConnectorSettings` is unaffected and remains a
    // plain merged object, which is all any current caller relies on.
    it('merge-patches the settings blob and returns the merged result', async () => {
      await insertConnector('merge-1', { repos: ['octo/repo'], fetchNotifications: true });

      const merged = await mergeConnectorSettings(
        'merge-1',
        { repos: ['octo/repo'], fetchNotifications: true },
        { authenticatedUser: 'octocat' },
      );

      expect(merged).toEqual({
        repos: ['octo/repo'],
        fetchNotifications: true,
        authenticatedUser: 'octocat',
      });
      // Column mode is 'json', so the driver JSON-encodes the already-stringified
      // value once more; `readRawSettings` undoes only the outer layer, leaving
      // the inner JSON string.
      expect(readRawSettings('merge-1')).toBe(JSON.stringify(merged));
    });

    it('overwrites existing keys named in the patch while leaving others untouched', async () => {
      await insertConnector('merge-2', { authenticatedUser: 'old-login', repos: [] });

      const merged = await mergeConnectorSettings(
        'merge-2',
        { authenticatedUser: 'old-login', repos: [] },
        { authenticatedUser: 'new-login' },
      );

      expect(merged).toEqual({ authenticatedUser: 'new-login', repos: [] });
      expect(JSON.parse(readRawSettings('merge-2') as string).authenticatedUser).toBe(
        'new-login',
      );
    });
  });

  describe('patchConnectorSettingsState', () => {
    interface PollState {
      cursor?: string;
      lastPolledAt?: string;
    }

    it('initializes a nested sub-state key when absent and persists it under the settings blob', async () => {
      await insertConnector('state-2', { repos: [] });

      const { settings, state } = patchConnectorSettingsState<PollState>(
        'state-2',
        'notificationPollState',
        { cursor: 'abc', lastPolledAt: '2026-01-01T00:00:00.000Z' },
      );

      expect(state).toEqual({ cursor: 'abc', lastPolledAt: '2026-01-01T00:00:00.000Z' });
      expect(settings.notificationPollState).toEqual(state);
      expect((readRawSettings('state-2') as Record<string, unknown>).notificationPollState).toEqual(state);
    });

    it('merge-patches an existing nested sub-state instead of replacing it', async () => {
      await insertConnector('state-3', {
        repos: [],
        notificationPollState: { cursor: 'page-1', lastPolledAt: '2026-01-01T00:00:00.000Z' },
      });

      const { state } = patchConnectorSettingsState<PollState>(
        'state-3',
        'notificationPollState',
        { cursor: 'page-2' },
      );

      expect(state).toEqual({ cursor: 'page-2', lastPolledAt: '2026-01-01T00:00:00.000Z' });
    });

    it('deletes a key from the nested sub-state when the patch value is undefined', async () => {
      await insertConnector('state-4', {
        repos: [],
        notificationPollState: { cursor: 'page-1', lastPolledAt: '2026-01-01T00:00:00.000Z' },
      });

      const { state } = patchConnectorSettingsState<PollState>(
        'state-4',
        'notificationPollState',
        { cursor: undefined },
      );

      expect(state).toEqual({ lastPolledAt: '2026-01-01T00:00:00.000Z' });
      expect('cursor' in state).toBe(false);
    });

    it('reads the latest persisted settings rather than a stale caller-held snapshot', async () => {
      await insertConnector('state-5', {
        repos: [],
        notificationPollState: { cursor: 'stale-if-cached' },
      });
      // Simulate a concurrent writer updating the row directly, bypassing the
      // in-memory state any caller might otherwise be holding.
      sqlite.prepare('UPDATE connector_configs SET settings = ? WHERE id = ?').run(
        JSON.stringify({ repos: [], notificationPollState: { cursor: 'written-elsewhere' } }),
        'state-5',
      );

      const { state } = patchConnectorSettingsState<PollState>(
        'state-5',
        'notificationPollState',
        { lastPolledAt: '2026-02-02T00:00:00.000Z' },
      );

      expect(state).toEqual({
        cursor: 'written-elsewhere',
        lastPolledAt: '2026-02-02T00:00:00.000Z',
      });
    });

    it('throws when the connector row no longer exists', () => {
      expect(() =>
        patchConnectorSettingsState<PollState>('missing-connector', 'notificationPollState', {
          cursor: 'x',
        }),
      ).toThrow(/no longer exists/);
    });
  });
});
