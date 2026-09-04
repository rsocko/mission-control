import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.unmock('@/db');
vi.unmock('drizzle-orm');

const directory = mkdtempSync(join(tmpdir(), 'mc-finance-notification-filter-'));
const databasePath = join(directory, 'notifications.db');
const merchantA = `merchant-v1_${'A'.repeat(43)}`;
const merchantB = `merchant-v1_${'B'.repeat(43)}`;
let sqlite: Database.Database;
let getNotifications: (request: Request) => Promise<Response>;
let shutdownRuntimeDatabase: typeof import('@/db/runtime').shutdownRuntimeDatabase;
let closeSqlite: () => void;

function insertNotification(input: {
  id: string;
  connectorType?: string;
  category?: string;
  merchantKey?: string | null;
  merchantLabel?: string | null;
}) {
  const presentation = input.merchantKey === undefined && input.merchantLabel === undefined
    ? {}
    : {
        financeMerchantKey: input.merchantKey,
        financeMerchantLabel: input.merchantLabel,
      };
  sqlite.prepare(`
    INSERT INTO notifications (
      id, source_id, connector_type, connector_instance_id, title, body,
      level, level_rank, category, state, read_state, disposition, source_state,
      sync_state, received_at, sort_at, metadata, presentation
    ) VALUES (?, ?, ?, ?, ?, NULL, 'heads_up', 2, ?, 'unread', 'unread',
      'inbox', 'active', 'synced', ?, ?, '{}', ?)
  `).run(
    input.id,
    `m5:${input.id}`,
    input.connectorType ?? 'finance-manager',
    `connector:${input.id}`,
    `Invented ${input.id}`,
    input.category ?? 'finance',
    '2026-08-10T12:00:00.000Z',
    `2026-08-10T12:00:${String(input.id.length).padStart(2, '0')}.000Z`,
    JSON.stringify(presentation),
  );
}

async function responseFor(query: string) {
  const response = await getNotifications(
    new Request(`http://localhost/api/notifications${query ? `?${query}` : ''}`),
  );
  return {
    response,
    body: await response.json() as {
      notifications?: Array<{ id: string; relatedTaskId: string | null }>;
      facets?: {
        source: Record<string, number>;
        merchant: Array<{ key: string; label: string; count: number }>;
      };
      error?: string;
    },
  };
}

describe('Finance notification filtering contract', () => {
  beforeAll(async () => {
    process.env.MC_DB_PATH = databasePath;
    vi.resetModules();
    const [database, runtime] = await Promise.all([
      import('@/db'),
      import('@/db/runtime'),
    ]);
    sqlite = database.sqlite;
    closeSqlite = sqlite.close.bind(sqlite);
    await runtime.initializeRuntimeDatabase();
    shutdownRuntimeDatabase = runtime.shutdownRuntimeDatabase;
    ({ GET: getNotifications } = await import('@/app/api/notifications/route'));

    insertNotification({ id: 'merchant-a', merchantKey: merchantA, merchantLabel: 'Invented Market' });
    insertNotification({ id: 'merchant-b', merchantKey: merchantB, merchantLabel: 'Fictional Transit' });
    insertNotification({ id: 'finance-category-only' });
    insertNotification({
      id: 'merchant-a-legacy-source',
      connectorType: 'monarch-money',
      merchantKey: merchantA,
      merchantLabel: 'Invented Market',
    });
    insertNotification({ id: 'finance-alias-source', connectorType: 'finance' });
    insertNotification({ id: 'non-finance', connectorType: 'github-issues', category: 'development' });
    insertNotification({
      id: 'invalid-merchant-key',
      merchantKey: 'merchant-v1_not-normalized',
      merchantLabel: 'Should not facet',
    });
    insertNotification({
      id: 'empty-merchant-label',
      merchantKey: `merchant-v1_${'C'.repeat(43)}`,
      merchantLabel: '',
    });
    for (let index = 0; index < 55; index += 1) {
      const suffix = index.toString(36).padStart(2, '0');
      insertNotification({
        id: `bounded-${suffix}`,
        merchantKey: `merchant-v1_${suffix}${'D'.repeat(41)}`,
        merchantLabel: `Invented Merchant ${suffix}`,
      });
    }
  });

  afterAll(async () => {
    await shutdownRuntimeDatabase();
    closeSqlite();
    delete process.env.MC_DB_PATH;
    rmSync(directory, { recursive: true, force: true });
  });

  it('keeps category filtering distinct from exact merchant mover filtering', async () => {
    const category = await responseFor('category=finance&limit=200');
    const merchant = await responseFor(`merchant=${merchantA}&limit=200`);
    const combined = await responseFor(`category=finance&merchant=${merchantA}&limit=200`);

    expect(category.response.status).toBe(200);
    expect(category.body.notifications?.map(item => item.id)).toEqual(expect.arrayContaining([
      'merchant-a',
      'merchant-b',
      'finance-category-only',
      'merchant-a-legacy-source',
    ]));
    expect(merchant.body.notifications?.map(item => item.id).sort()).toEqual([
      'merchant-a',
      'merchant-a-legacy-source',
    ]);
    expect(combined.body.notifications?.map(item => item.id).sort()).toEqual([
      'merchant-a',
      'merchant-a-legacy-source',
    ]);
    expect(combined.body.notifications?.every(item => item.relatedTaskId === null)).toBe(true);
  });

  it.each(['finance', 'finance-manager', 'monarch-money'])(
    'matches all stored Finance provider aliases for source=%s',
    async source => {
      const { response, body } = await responseFor(`source=${source}&limit=200`);
      expect(response.status).toBe(200);
      expect(body.notifications?.map(item => item.id)).toEqual(expect.arrayContaining([
        'merchant-a',
        'merchant-a-legacy-source',
        'finance-alias-source',
      ]));
      expect(body.facets?.source['finance-manager']).toBeGreaterThanOrEqual(3);
      expect(body.facets?.source.finance).toBeUndefined();
      expect(body.facets?.source['monarch-money']).toBeUndefined();
    },
  );

  it('returns bounded, unique, normalized merchant facets with presentation labels', async () => {
    const { response, body } = await responseFor('category=finance&limit=1');
    expect(response.status).toBe(200);
    expect(body.facets?.merchant).toHaveLength(50);
    expect(new Set(body.facets?.merchant.map(facet => facet.key)).size).toBe(50);
    expect(body.facets?.merchant).toContainEqual({
      key: merchantA,
      label: 'Invented Market',
      count: 2,
    });
    expect(body.facets?.merchant.some(facet => facet.label === 'Should not facet')).toBe(false);
    expect(body.facets?.merchant.some(facet => facet.label === '')).toBe(false);
  });

  it('rejects empty, unknown-format, duplicate, and injection-shaped merchant values', async () => {
    for (const query of [
      'merchant=',
      'merchant=Invented%20Market',
      "merchant=merchant-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'%20OR%201%3D1",
      `merchant=${merchantA}&merchant=${merchantA}`,
    ]) {
      const { response, body } = await responseFor(query);
      expect(response.status).toBe(400);
      expect(body.error).toBe('merchant must be supplied once as a normalized merchant key');
    }

    const unknown = `merchant-v1_${'Z'.repeat(43)}`;
    const { response, body } = await responseFor(`merchant=${unknown}`);
    expect(response.status).toBe(400);
    expect(body.error).toBe(
      'merchant does not match available normalized notification metadata',
    );
  });
});
