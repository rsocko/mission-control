/**
 * Features API — notificationOnly derivation
 *
 * Verifies that source classification comes from the connector profile catalog
 * and notification-only connectors never become task mutation destinations.
 *
 * The route reads connectors through the operational-utility feature subport
 * and AI status through the async provider-configuration service, so this suite
 * doubles those seams and never imports `@/db`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConnectorFeatureSnapshot } from '@/db/persistence/operational-utility';

// ─── Mock connector snapshots ────────────────────────────────────────────────

let mockConfigs: ConnectorFeatureSnapshot[] = [];
let operationalUtilityAvailable = true;
let aiConfigured = false;

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    operationalUtility: operationalUtilityAvailable
      ? { features: { listActiveConnectors: async () => mockConfigs } }
      : undefined,
  }),
}));

vi.mock('@/lib/ai/provider-configuration-service', () => ({
  loadAIProviderConfiguration: async () => ({
    resolved: {
      configured: aiConfigured,
      provider: 'test',
      model: 'test-model',
      baseUrl: 'http://test',
    },
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(
  type: string,
  caps: Record<string, unknown> = {},
  settings: Record<string, unknown> = {},
): ConnectorFeatureSnapshot {
  return {
    id: `${type}-1`,
    type,
    name: type,
    capabilities: JSON.stringify({ read: true, write: false, ...caps }),
    settings: JSON.stringify(settings),
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
    operationalUtilityAvailable = true;
    aiConfigured = false;
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

  it('accepts already-decoded capability and settings documents', async () => {
    mockConfigs = [{
      id: 'github-1',
      type: 'github-issues',
      name: 'github-issues',
      capabilities: { read: true, write: true, taskCreate: true },
      settings: { accountType: 'work' },
    }];
    const json = await fetchFeatures();
    expect(json.taskDestinations).toEqual([
      expect.objectContaining({ type: 'github-issues', account: 'work' }),
    ]);
  });

  it('reports AI status from the provider configuration service', async () => {
    aiConfigured = true;
    const json = await fetchFeatures();
    expect(json.aiEnabled).toBe(true);
    expect(json.aiProvider).toEqual({
      provider: 'test',
      model: 'test-model',
      baseUrl: 'http://test',
    });
  });

  it('reports 503 when the backend does not provide operational utility persistence', async () => {
    operationalUtilityAvailable = false;
    const mod = await import('@/app/api/features/route');
    const response = await mod.GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: 'Operational utility persistence is not available in the selected backend',
    });
  });
});
