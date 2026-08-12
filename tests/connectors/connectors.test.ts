/**
 * Connector Unit Tests - Sync behavior, initialization, conflict handling
 * Tests #112
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import type { ConnectorConfig, ConnectorCapabilities } from '@/types';

const createFetchMock = (status: number) => (vi.fn(
  async () => new Response(JSON.stringify({}), { status })
) as unknown as typeof fetch);

// Mock fetch globally before any connector imports
beforeAll(() => {
  global.fetch = createFetchMock(200);
});

// Mock database for connectors that use it
vi.mock('@/db', () => ({
  default: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => []),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(),
      })),
    })),
  },
}));

vi.mock('@/db/schema', () => ({
  connectorConfigs: { id: 'id', type: 'type' },
}));

vi.mock('@/lib/auth', () => ({
  getValidToken: vi.fn(() => Promise.resolve(null)),
  getSubstrateToken: vi.fn(() => Promise.resolve(null)),
  invalidateToken: vi.fn(),
}));

vi.mock('@/lib/mode', () => ({
  getTimezone: vi.fn(() => 'America/New_York'),
}));

vi.mock('@/lib/utils/date', () => ({
  getLocalToday: vi.fn(() => '2026-07-17'),
}));

vi.mock('@/lib/micro-status', () => ({
  extractMicroStatusFromTags: vi.fn(() => ({ microStatus: null, filteredTags: [] })),
  isMicroStatusTag: vi.fn(() => false),
  updateTagsWithMicroStatus: vi.fn((tags: string[]) => tags),
  microStatusToTag: vi.fn(() => null),
  getMicroStatusTagColor: vi.fn(() => null),
  MICRO_STATUS_TAG_PREFIX: 'mc:',
}));

// ─── CONNECTOR REGISTRY ────────────────────────────────────────────────────

describe('ConnectorRegistry', () => {
  it('should register and create connectors', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const registry = new ConnectorRegistry();

    const mockConnector = {
      id: '',
      type: 'test',
      displayName: 'Test',
      icon: '🧪',
      capabilities: { read: true, write: false, delete: false, sync: false, subtasks: false, lists: false, tags: false, tagWriteBack: false } as ConnectorCapabilities,
      initialize: vi.fn(),
      testConnection: vi.fn(() => Promise.resolve({ success: true, message: 'ok' })),
      dispose: vi.fn(),
      fetchTasks: vi.fn(async function* () { yield []; }),
      fetchNotifications: vi.fn(() => Promise.resolve([])),
      fetchSourceLists: vi.fn(() => Promise.resolve([])),
      getLastSyncToken: vi.fn(() => Promise.resolve(null)),
    };

    registry.registerFactory('test', { create: () => mockConnector });

    const config: ConnectorConfig = {
      id: 'test-1',
      type: 'test',
      name: 'Test Connector',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 60,
      capabilities: mockConnector.capabilities,
      credentials: {},
      settings: {},
      syncedLists: [],
    };

    const connector = await registry.createConnector(config);
    expect(connector).toBe(mockConnector);
    expect(mockConnector.initialize).toHaveBeenCalledWith(config);
    expect(registry.getConnector('test-1')).toBe(mockConnector);
  });

  it('should throw for unknown connector type', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const registry = new ConnectorRegistry();

    await expect(registry.createConnector({
      id: 'unknown-1',
      type: 'nonexistent',
      name: 'Unknown',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 60,
      capabilities: {} as ConnectorCapabilities,
      credentials: {},
      settings: {},
      syncedLists: [],
    })).rejects.toThrow('No factory registered for connector type: nonexistent');
  });

  it('should remove connector and call dispose', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const registry = new ConnectorRegistry();

    const mockConnector = {
      id: '',
      type: 'test',
      displayName: 'Test',
      icon: '🧪',
      capabilities: {} as ConnectorCapabilities,
      initialize: vi.fn(),
      testConnection: vi.fn(),
      dispose: vi.fn(() => Promise.resolve()),
      fetchTasks: vi.fn(async function* () { yield []; }),
      fetchNotifications: vi.fn(() => Promise.resolve([])),
      fetchSourceLists: vi.fn(() => Promise.resolve([])),
      getLastSyncToken: vi.fn(() => Promise.resolve(null)),
    };

    registry.registerFactory('test', { create: () => mockConnector });
    await registry.createConnector({
      id: 'rm-1',
      type: 'test',
      name: 'To Remove',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 60,
      capabilities: {} as ConnectorCapabilities,
      credentials: {},
      settings: {},
      syncedLists: [],
    });

    await registry.removeConnector('rm-1');
    expect(mockConnector.dispose).toHaveBeenCalled();
    expect(registry.getConnector('rm-1')).toBeUndefined();
  });

  it('replaces an initialized connector after settings change', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const registry = new ConnectorRegistry();
    const connectors = [
      {
        id: '',
        type: 'test',
        displayName: 'Test',
        icon: 'test',
        capabilities: {} as ConnectorCapabilities,
        initialize: vi.fn(),
        testConnection: vi.fn(),
        dispose: vi.fn(),
        fetchTasks: vi.fn(async function* () { yield []; }),
        fetchNotifications: vi.fn(() => Promise.resolve([])),
        fetchSourceLists: vi.fn(() => Promise.resolve([])),
        getLastSyncToken: vi.fn(() => Promise.resolve(null)),
      },
      {
        id: '',
        type: 'test',
        displayName: 'Test',
        icon: 'test',
        capabilities: {} as ConnectorCapabilities,
        initialize: vi.fn(),
        testConnection: vi.fn(),
        dispose: vi.fn(),
        fetchTasks: vi.fn(async function* () { yield []; }),
        fetchNotifications: vi.fn(() => Promise.resolve([])),
        fetchSourceLists: vi.fn(() => Promise.resolve([])),
        getLastSyncToken: vi.fn(() => Promise.resolve(null)),
      },
    ];
    registry.registerFactory('test', { create: vi.fn(() => connectors.shift()!) });
    const config: ConnectorConfig = {
      id: 'refresh-1',
      type: 'test',
      name: 'Test Connector',
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: 60,
      capabilities: {} as ConnectorCapabilities,
      credentials: {},
      settings: { repos: ['octo/old'] },
      syncedLists: ['octo/old'],
    };

    const previous = await registry.createConnector(config);
    const refreshedConfig = {
      ...config,
      settings: { repos: ['octo/old', 'octo/new'] },
      syncedLists: ['octo/old', 'octo/new'],
    };
    const refreshed = await registry.replaceConnector(refreshedConfig);

    expect(refreshed).not.toBe(previous);
    expect(refreshed.initialize).toHaveBeenCalledWith(refreshedConfig);
    expect(previous.dispose).not.toHaveBeenCalled();
    expect(registry.getConnector(config.id)).toBe(refreshed);
  });

  it('validates static catalogs when factories register', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const registry = new ConnectorRegistry();

    expect(() => registry.registerFactory('invalid', {
      create: () => ({}) as never,
      notificationTypes: [{
        key: 'Invalid Key',
        label: 'Invalid',
        description: 'Invalid key',
        defaultLevel: 'fyi',
        pushEligible: false,
        pushRecommendation: 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_only',
      }],
    })).toThrow('lowercase snake case');
  });

  it('exposes factory catalogs without initializing a connector', async () => {
    const { ConnectorRegistry } = await import('@/lib/connectors');
    const create = vi.fn();
    const registry = new ConnectorRegistry();
    registry.registerFactory('catalog-test', {
      create,
      notificationTypes: [{
        key: 'attention_needed',
        label: 'Attention needed',
        description: 'An event needs attention.',
        defaultLevel: 'action_needed',
        pushEligible: true,
        pushRecommendation: 'off',
        sensitivity: 'standard',
        defaultPreview: 'title_only',
      }],
    });

    expect(registry.getNotificationTypeCatalog('catalog-test')).toHaveLength(1);
    expect(create).not.toHaveBeenCalled();
  });

  it('resolves custom REST catalogs from locally stored instance settings', async () => {
    const { connectorRegistry } = await import('@/lib/connectors');

    const catalog = connectorRegistry.getNotificationTypeCatalog('custom-rest', {
      id: 'custom-1',
      type: 'custom-rest',
      name: 'Custom',
      enabled: true,
      syncMode: 'poll',
      capabilities: {} as ConnectorCapabilities,
      credentials: {},
      settings: {
        notificationTypeCatalog: [{
          key: 'local_alert',
          label: 'Local alert',
          description: 'Configured locally.',
          defaultLevel: 'heads_up',
          pushEligible: true,
          pushRecommendation: 'off',
          sensitivity: 'standard',
          defaultPreview: 'title_only',
        }],
      },
      syncedLists: [],
    });

    expect(catalog.map(item => item.key)).toEqual(['local_alert']);
  });
});

// ─── FINANCE MANAGER CONNECTOR ─────────────────────────────────────────────

describe('FinanceManagerConnector', () => {
  const FINANCE_CONFIG: ConnectorConfig = {
    id: 'test-finance',
    type: 'finance-manager',
    name: 'Test Finance',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 240,
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: false,
      lists: false,
      tags: true,
      tagWriteBack: false,
    },
    credentials: {},
    settings: {},
    syncedLists: [],
  };

  it('should initialize with correct metadata', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);

    expect(connector.id).toBe('test-finance');
    expect(connector.type).toBe('finance-manager');
    expect(connector.displayName).toBe('Tyrion');
    expect(connector.icon).toBe('💰');
    expect(connector.capabilities.notificationOnly).toBe(true);
  });

  it('should return empty tasks when no bridge running', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);

    const tasks = (await Array.fromAsync(connector.fetchTasks())).flat();
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBe(0);
  });

  it('should not infer Tyrion automation deliveries from finance projections', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);

    const notifications = await connector.fetchNotifications();
    expect(notifications).toEqual([]);
  });

  it('should report connection failure gracefully', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);

    const result = await connector.testConnection();
    expect(result.success).toBe(false);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('should handle sync failure gracefully', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);

    const result = await connector.sync();
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('should dispose without error', async () => {
    const { FinanceManagerConnector } = await import('@/lib/connectors/monarch-money');
    const connector = new FinanceManagerConnector();
    await connector.initialize(FINANCE_CONFIG);
    await expect(connector.dispose()).resolves.not.toThrow();
  });
});

// ─── GITHUB ISSUES CONNECTOR ───────────────────────────────────────────────

describe('GitHubIssuesConnector', () => {
  const GITHUB_CONFIG: ConnectorConfig = {
    id: 'test-github',
    type: 'github-issues',
    name: 'Test GitHub',
    enabled: true,
    syncMode: 'poll',
    pollIntervalMinutes: 15,
    capabilities: {
      read: true,
      write: true,
      delete: false,
      sync: true,
      subtasks: true,
      lists: true,
      tags: true,
      tagWriteBack: true,
    },
    credentials: { token: 'fake-token' },
    settings: { repos: ['owner/repo'], fetchNotifications: false },
    syncedLists: [],
  };

  beforeEach(() => {
    // Mock global fetch for GitHub API calls
    global.fetch = createFetchMock(401);
  });

  it('should initialize with correct metadata', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(GITHUB_CONFIG);

    expect(connector.id).toBe('test-github');
    expect(connector.type).toBe('github-issues');
    expect(connector.displayName).toBe('GitHub Issues');
    expect(connector.icon).toBe('🐙');
  });

  it('should have correct capabilities', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(GITHUB_CONFIG);

    expect(connector.capabilities.read).toBe(true);
    expect(connector.capabilities.write).toBe(true);
    expect(connector.capabilities.delete).toBe(false);
    expect(connector.capabilities.subtasks).toBe(true);
    expect(connector.capabilities.tags).toBe(true);
    expect(connector.capabilities.tagWriteBack).toBe(true);
  });

  it('should return null sync token initially', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(GITHUB_CONFIG);

    const token = await connector.getLastSyncToken();
    expect(token).toBeNull();
  });

  it('should dispose without error', async () => {
    const { GitHubIssuesConnector } = await import('@/lib/connectors/github-issues');
    const connector = new GitHubIssuesConnector();
    await connector.initialize(GITHUB_CONFIG);
    await expect(connector.dispose()).resolves.not.toThrow();
  });
});

// ─── DEFAULT FACTORIES REGISTRATION ────────────────────────────────────────

describe('registerDefaultConnectorFactories', () => {
  beforeEach(() => {
    // Mock global fetch to prevent any network calls
    global.fetch = createFetchMock(200);
  });

  it('should register all expected connector types', async () => {
    const { connectorRegistry } = await import('@/lib/connectors');
    
    // The registry should have factories for all types after import
    const testConfig = (type: string): ConnectorConfig => ({
      id: `test-${type}`,
      type,
      name: `Test ${type}`,
      enabled: true,
      syncMode: 'poll' as const,
      pollIntervalMinutes: 60,
      capabilities: { read: true, write: false, delete: false, sync: true, subtasks: false, lists: false, tags: false, tagWriteBack: false },
      credentials: {},
      settings: type === 'github-issues' ? { repos: [] } : {},
      syncedLists: [],
    });

    // These should all create without throwing
    const types = ['microsoft-todo', 'github-issues', 'finance-manager'];
    for (const type of types) {
      const connector = await connectorRegistry.createConnector(testConfig(type));
      expect(connector).toBeDefined();
      expect(connector.type).toBeDefined();
    }
  });
});
