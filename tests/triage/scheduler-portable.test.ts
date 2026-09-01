import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();
const mockGitHubCredentials = vi.fn();
const mockGitHubImport = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
  },
}));

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositoriesForBackend: async () => ({
    settings: {
      get: mockSettingsGet,
      set: mockSettingsSet,
    },
  }),
  getCorePersistenceRepositories: () => ({
    settings: {
      get: mockSettingsGet,
      set: mockSettingsSet,
    },
  }),
}));

vi.mock('@/lib/triage/credentials', () => ({
  resolveGitHubCredentials: mockGitHubCredentials,
  resolveRedditCredentials: vi.fn(),
  resolveYouTubeCredentials: vi.fn(),
}));

vi.mock('@/lib/triage/importers', () => ({
  importAllGitHubStars: mockGitHubImport,
  importAllRedditSaved: vi.fn(),
  importAllYouTubePlaylists: vi.fn(),
}));

vi.mock('@/lib/triage/importers/document-intelligence-importer', () => ({
  importAllDocumentIntelligenceActions: vi.fn(),
}));

vi.mock('@/lib/telemetry/database-operation-context', () => ({
  withDatabaseOperation: (_name: string, operation: () => unknown) => operation(),
}));

vi.mock('@/lib/logger', () => ({
  default: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

function fullResult(outcome: 'success' | 'partial' | 'failure' | 'stale') {
  return {
    outcome,
    imported: outcome === 'success' ? 2 : 0,
    skipped: 1,
    errors: outcome === 'success' ? [] : ['synthetic remote failure'],
    pagesProcessed: 1,
    durationMs: 5,
    lastCursor: null,
  };
}

describe('portable triage scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsGet.mockResolvedValue(null);
    mockSettingsSet.mockResolvedValue(undefined);
    mockGitHubCredentials.mockResolvedValue({
      token: 'synthetic-github-token',
      source: 'triage-settings',
    });
    mockGitHubImport.mockResolvedValue(fullResult('success'));
  });

  it('fails closed instead of returning defaults after settings failure', async () => {
    mockSettingsGet.mockRejectedValue(new Error('settings unavailable'));
    const { TriageSyncScheduler } = await import('@/lib/triage/scheduler');

    await expect(new TriageSyncScheduler().getConfig()).rejects.toThrow('settings unavailable');
  });

  it('persists auto-sync config through the shared SettingsRepository', async () => {
    const { TriageSyncScheduler } = await import('@/lib/triage/scheduler');
    const scheduler = new TriageSyncScheduler();

    const updated = await scheduler.updateConfig({
      sources: {
        'github-stars': { enabled: true, intervalMinutes: 30 },
      },
    });

    expect(updated.sources['github-stars'].enabled).toBe(true);
    expect(mockSettingsSet).toHaveBeenCalledWith('triage_auto_sync', updated);
  });

  it('expresses missing configuration and stale persistence outcomes', async () => {
    const { TriageSyncScheduler } = await import('@/lib/triage/scheduler');
    const scheduler = new TriageSyncScheduler();
    mockGitHubCredentials.mockResolvedValueOnce(null);
    await expect(scheduler.runImport('github-stars')).resolves.toMatchObject({
      outcome: 'missing-config',
      imported: 0,
    });

    mockGitHubImport.mockResolvedValueOnce(fullResult('stale'));
    await expect(scheduler.runImport('github-stars')).resolves.toMatchObject({
      outcome: 'stale',
      errors: ['synthetic remote failure'],
    });
  });

  it('isolates overlapping runs without starting a second remote import', async () => {
    let release!: (value: ReturnType<typeof fullResult>) => void;
    mockGitHubImport.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { TriageSyncScheduler } = await import('@/lib/triage/scheduler');
    const scheduler = new TriageSyncScheduler();

    const first = scheduler.runImport('github-stars');
    await vi.waitFor(() => expect(mockGitHubImport).toHaveBeenCalledTimes(1));
    await expect(scheduler.runImport('github-stars')).resolves.toMatchObject({
      outcome: 'overlap',
    });
    release(fullResult('success'));
    await expect(first).resolves.toMatchObject({ outcome: 'success' });
    expect(mockGitHubImport).toHaveBeenCalledTimes(1);
  });

  it('waits for an active import while stopping scheduled work', async () => {
    let finishRun: ((result: ReturnType<typeof fullResult>) => void) | undefined;
    mockGitHubImport.mockImplementationOnce(() => new Promise((resolve) => {
      finishRun = resolve;
    }));
    const { TriageSyncScheduler } = await import('@/lib/triage/scheduler');
    const scheduler = new TriageSyncScheduler();

    const run = scheduler.runImport('github-stars');
    await vi.waitFor(() => expect(mockGitHubImport).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stop = scheduler.stopAll().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishRun?.(fullResult('success'));
    await expect(run).resolves.toMatchObject({ outcome: 'success' });
    await stop;
    expect(stopped).toBe(true);
  });
});
