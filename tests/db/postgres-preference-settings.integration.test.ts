import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SettingsRepository } from '@/db/persistence/core-repositories';
import { resolvePostgresConfig } from '@/db/postgres/config';
import { PostgresSettingsRepository } from '@/db/postgres/repositories/settings-repository';
import { PostgresPersistenceBackend } from '@/db/postgres/runtime';
import { CorePreferenceSettingsRepository } from '@/lib/settings/preference-settings';
import { assertSafeIntegrationTestTarget } from '../contracts/postgres-safety';
import {
  describePreferenceSettingsRepositoryContract,
  PREFERENCE_SETTING_KEYS,
} from '../contracts/preference-settings-repository.contract';

vi.unmock('drizzle-orm');

const runtime = vi.hoisted(() => ({
  settings: null as SettingsRepository | null,
  sqliteTouch: vi.fn(),
}));

vi.mock('@/db', () => {
  runtime.sqliteTouch();
  throw new Error('SQLite must not load in PostgreSQL preference settings routes');
});

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: async () => {
    if (!runtime.settings) throw new Error('PostgreSQL settings repository is not ready');
    return { settings: runtime.settings };
  },
}));

const connectionString = process.env.MC_TEST_POSTGRES_URL;
const describePostgres = describe.skipIf(!connectionString);

describePostgres('PostgreSQL preference settings parity', () => {
  const backend = new PostgresPersistenceBackend({
    ...(connectionString
      ? {
          config: resolvePostgresConfig({
            MC_POSTGRES_URL: connectionString,
            MC_POSTGRES_APPLICATION_NAME: 'mission-control-preference-settings-test',
          }),
        }
      : {}),
  });
  let settings: PostgresSettingsRepository;

  async function clearPreferences() {
    await backend.context.pool.query(
      'DELETE FROM app_settings WHERE key = ANY($1::text[])',
      [[...PREFERENCE_SETTING_KEYS]],
    );
  }

  beforeAll(async () => {
    assertSafeIntegrationTestTarget(connectionString!);
    await backend.initialize();
    settings = new PostgresSettingsRepository(backend.context.db);
    runtime.settings = settings;
    await clearPreferences();
  }, 120_000);

  afterAll(async () => {
    if (!runtime.settings) return;
    await clearPreferences();
    runtime.settings = null;
    await backend.shutdown();
  });

  describePreferenceSettingsRepositoryContract('PostgreSQL', async () => ({
    settings,
    repository: new CorePreferenceSettingsRepository(settings),
    async close() {},
  }));

  it('serves all three preference routes from live PostgreSQL without SQLite evaluation', async () => {
    await clearPreferences();
    const capture = await import('@/app/api/settings/capture-destination/route');
    const inbox = await import('@/app/api/settings/inbox-lists/route');
    const dopamine = await import('@/app/api/settings/dopamine-menu/route');

    const capturePut = await capture.PUT(new Request(
      'http://localhost/api/settings/capture-destination',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          connectorType: 'microsoft-todo',
          connectorInstanceId: 'work',
          sourceListId: 'inbox',
          sourceListName: 'Inbox',
        }),
      },
    ));
    expect(capturePut.status).toBe(200);
    await expect((await capture.GET()).json()).resolves.toEqual({
      destination: {
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'work',
        sourceListId: 'inbox',
        sourceListName: 'Inbox',
      },
    });

    const lists = [
      { connectorType: 'microsoft-todo', sourceListId: 'one', label: 'One' },
      { connectorType: 'microsoft-todo', sourceListId: 'one', label: 'Duplicate' },
      { connectorType: 'local', label: 'Local' },
    ];
    expect((await inbox.PUT(new Request('http://localhost/api/settings/inbox-lists', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lists }),
    }))).status).toBe(200);
    await expect((await inbox.GET()).json()).resolves.toEqual({ lists });

    expect((await dopamine.PATCH(new Request('http://localhost/api/settings/dopamine-menu', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, threshold: 9 }),
    }))).status).toBe(200);
    await expect((await dopamine.GET()).json()).resolves.toMatchObject({
      enabled: false,
      threshold: 9,
    });
    expect(runtime.sqliteTouch).not.toHaveBeenCalled();
  });
});
