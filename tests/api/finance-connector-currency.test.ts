import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { importInitializedSqliteDatabase } from '../helpers/initialized-sqlite-database';

vi.unmock('drizzle-orm');
vi.unmock('crypto');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-currency-'));
process.env.MC_DB_PATH = join(directory, 'currency.db');
process.env.MC_SYNC_EXECUTION_MODE = 'worker';

let sqlite: typeof import('@/db').sqlite;
let route: typeof import('@/app/api/connectors/route');

function request(method: 'POST' | 'PATCH', body: object): Request {
  return new Request('http://localhost/api/connectors', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createBody(settings: Record<string, unknown>) {
  return {
    id: 'finance-currency-test',
    type: 'finance-manager',
    name: 'Tyrion',
    enabled: false,
    syncMode: 'poll',
    pollIntervalMinutes: 240,
    credentials: {},
    settings,
  };
}

beforeAll(async () => {
  ({ sqlite } = await importInitializedSqliteDatabase());
  route = await import('@/app/api/connectors/route');
}, 30_000);

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM connector_sync_operator_runs;
    DELETE FROM connector_sync_controls;
    DELETE FROM sync_schedules;
    DELETE FROM connector_configs;
  `);
});

afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
  delete process.env.MC_DB_PATH;
  delete process.env.MC_SYNC_EXECUTION_MODE;
});

describe.sequential('Finance connector household currency', () => {
  it.each([
    [{}, 'household_currency_required'],
    [{ householdCurrency: 'usd' }, 'household_currency_invalid'],
    [{ householdCurrency: 'ZZZ' }, 'household_currency_invalid'],
    [{ householdCurrency: 'US' }, 'household_currency_invalid'],
  ])('rejects unsupported create state without normalization', async (settings, code) => {
    const response = await route.POST(request('POST', createBody(settings)));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: code, code });
  });

  it('stores an exact ISO-4217 currency and preserves it on unrelated edits', async () => {
    const created = await route.POST(request('POST', createBody({
      bridgeUrl: 'https://tyrion.example/api/connector/v1',
      householdCurrency: 'USD',
    })));
    expect(created.status).toBe(201);

    expect((await route.PATCH(request('PATCH', {
      id: 'finance-currency-test',
      name: 'Tyrion renamed',
    }))).status).toBe(200);
    expect((await route.PATCH(request('PATCH', {
      id: 'finance-currency-test',
      settings: { bridgeUrl: 'https://bridge.example.test/connector/v1' },
    }))).status).toBe(200);

    const row = sqlite.prepare(`
      SELECT name, settings FROM connector_configs WHERE id = ?
    `).get('finance-currency-test') as { name: string; settings: string };
    expect(row.name).toBe('Tyrion renamed');
    expect(JSON.parse(row.settings)).toEqual({
      bridgeUrl: 'https://bridge.example.test/connector/v1',
      householdCurrency: 'USD',
    });
  });

  it('preserves legacy unconfigured state on unrelated edits and exposes it explicitly', async () => {
    const timestamp = '2026-08-22T12:00:00.000Z';
    sqlite.prepare(`
      INSERT INTO connector_configs (
        id, type, name, enabled, sync_mode, poll_interval_minutes, capabilities,
        credentials, settings, synced_lists, created_at, updated_at, deleted_at
      ) VALUES (
        'legacy-finance', 'finance-manager', 'Legacy Tyrion', 0, 'poll', 240,
        '{}', '{}', '{"bridgeUrl":"https://tyrion.example/api/connector/v1"}',
        '[]', ?, ?, NULL
      )
    `).run(timestamp, timestamp);

    expect((await route.PATCH(request('PATCH', {
      id: 'legacy-finance',
      name: 'Legacy Tyrion renamed',
    }))).status).toBe(200);
    const { serializeConnectorForBrowser } = await import('@/lib/connectors/public-config');
    const row = sqlite.prepare(`
      SELECT * FROM connector_configs WHERE id = 'legacy-finance'
    `).get() as Record<string, unknown>;
    expect(serializeConnectorForBrowser({
      ...row,
      type: 'finance-manager',
      credentials: {},
      settings: JSON.parse(String(row.settings)),
    })).toMatchObject({
      configurationState: {
        status: 'needs-configuration',
        code: 'household_currency_unavailable',
      },
    });
    expect(JSON.parse(String(row.settings))).toEqual({
      bridgeUrl: 'https://tyrion.example/api/connector/v1',
    });
  });

  it('rejects an invalid currency edit without overwriting the existing value', async () => {
    await route.POST(request('POST', createBody({ householdCurrency: 'USD' })));
    const response = await route.PATCH(request('PATCH', {
      id: 'finance-currency-test',
      settings: { householdCurrency: 'usd' },
    }));
    expect(response.status).toBe(400);
    expect(JSON.parse((sqlite.prepare(`
      SELECT settings FROM connector_configs WHERE id = ?
    `).get('finance-currency-test') as { settings: string }).settings))
      .toEqual({ householdCurrency: 'USD' });
  });
});
