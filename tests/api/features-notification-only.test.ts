/**
 * Features API — notificationOnly derivation
 *
 * Verifies that source classification comes from the connector profile catalog
 * and notification-only connectors never become task mutation destinations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock DB rows ────────────────────────────────────────────────────────────

let mockConfigs: Array<{
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  capabilities: string;
  settings: string;
  deletedAt: null;
}> = [];

type ChainableProxy = Record<PropertyKey, unknown>;

function chainable<T>(terminal: T) {
  const chain: ChainableProxy = new Proxy({}, {
    get(_, prop: string | symbol) {
      if (prop === 'then') return (resolve: (value: T) => unknown) => resolve(terminal);
      if (prop === Symbol.iterator) {
        return () => (Array.isArray(terminal) ? terminal : [])[Symbol.iterator]();
      }
      return vi.fn(() => chain);
    },
  });
  return chain;
}

vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => chainable(mockConfigs)),
  },
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: { deletedAt: 'deletedAt' },
}));

vi.mock('@/lib/ai/provider-factory', () => ({
  getProviderInfo: () => ({ provider: 'test', model: 'test', baseUrl: 'http://test' }),
}));

vi.mock('@/lib/ai/config-resolver', () => ({
  getResolvedAIConfig: () => ({ configured: false }),
}));

vi.mock('drizzle-orm', () => ({
  isNull: vi.fn(() => null),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
  type: string,
  caps: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
) {
  return {
    id: `${type}-1`,
    type,
    name: type,
    enabled: true,
    capabilities: JSON.stringify({ read: true, write: false, ...caps }),
    settings: JSON.stringify(settings),
    deletedAt: null,
  };
}

async function fetchFeatures() {
  // Dynamic import to get fresh module with current mocks
  const mod = await import('@/app/api/features/route');
  const res = await mod.GET();
  return res.json();
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('GET /api/features — notificationOnly', () => {
  beforeEach(() => {
    mockConfigs = [];
    vi.resetModules();
  });

  it('scout connector is NOT notificationOnly', async () => {
    mockConfigs = [makeConfig('scout', { read: true, write: false, lists: true, tags: true })];
    const json = await fetchFeatures();
    const scout = json.enabledSources.find((s: { type: string }) => s.type === 'scout');
    expect(scout).toBeDefined();
    expect(scout.notificationOnly).toBe(false);
  });

  it('github-issues connector is NOT notificationOnly', async () => {
    mockConfigs = [makeConfig('github-issues', { read: true, write: true })];
    const json = await fetchFeatures();
    const gh = json.enabledSources.find((s: { type: string }) => s.type === 'github-issues');
    expect(gh).toBeDefined();
    expect(gh.notificationOnly).toBe(false);
  });

  it('custom-rest connector is NOT notificationOnly', async () => {
    mockConfigs = [makeConfig('custom-rest', { read: true, write: false })];
    const json = await fetchFeatures();
    const cr = json.enabledSources.find((s: { type: string }) => s.type === 'custom-rest');
    expect(cr).toBeDefined();
    expect(cr.notificationOnly).toBe(false);
  });

  it.each([
    'outlook-email',
    'outlook-calendar',
    'rymessage',
    'home-assistant',
    'finance',
    'finance-manager',
    'monarch-money',
  ])('%s is explicitly notification-only', async (type) => {
    mockConfigs = [makeConfig(type, { read: true, write: true, taskCreate: true })];
    const json = await fetchFeatures();
    const source = json.enabledSources.find((s: { type: string }) => s.type === type);
    expect(source).toBeDefined();
    expect(source.notificationOnly).toBe(true);
    expect(json.taskDestinations).toEqual([]);
    if (['finance', 'finance-manager', 'monarch-money'].includes(type)) {
      expect(json.financeEnabled).toBe(true);
    }
  });

  it('uses taskCreate rather than generic write support for mutation destinations', async () => {
    mockConfigs = [
      makeConfig('document-intelligence', { read: true, write: true }),
      makeConfig('custom-rest', { read: true, write: true }, {
        updateEndpoint: '/tasks/{id}',
      }),
      makeConfig('github-issues', { read: true, write: true, taskCreate: true }),
    ];
    const json = await fetchFeatures();
    expect(json.taskDestinations.map((destination: { type: string }) => destination.type))
      .toEqual(['github-issues']);
  });

  it('resolves Custom REST task creation independently from update support', async () => {
    mockConfigs = [
      makeConfig('custom-rest', { read: true, write: false }, {
        createEndpoint: '/tasks',
      }),
    ];
    const json = await fetchFeatures();
    expect(json.taskDestinations.map((destination: { type: string }) => destination.type))
      .toEqual(['custom-rest']);
  });

  it('retains write-based creation fallback for unknown legacy connectors', async () => {
    mockConfigs = [
      makeConfig('legacy-task-system', { read: true, write: true }),
    ];
    const json = await fetchFeatures();
    expect(json.taskDestinations.map((destination: { type: string }) => destination.type))
      .toEqual(['legacy-task-system']);
  });

  it('does not let stale stored classification override a registered task producer', async () => {
    mockConfigs = [makeConfig('custom-rest', { read: true, write: false, notificationOnly: true })];
    const json = await fetchFeatures();
    const cr = json.enabledSources.find((s: { type: string }) => s.type === 'custom-rest');
    expect(cr).toBeDefined();
    expect(cr.notificationOnly).toBe(false);
  });
});
