import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSettingsGet = vi.fn();
const mockSettingsSet = vi.fn();
const mockFindActiveGitHubToken = vi.fn();

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

vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => ({
    githubCredentialFallback: {
      findActiveGitHubToken: mockFindActiveGitHubToken,
    },
  }),
}));

vi.mock('@/lib/logger', () => ({
  default: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

describe('triage source settings API persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSettingsGet.mockResolvedValue(null);
    mockSettingsSet.mockResolvedValue(undefined);
    mockFindActiveGitHubToken.mockResolvedValue(null);
  });

  it('preserves the credential response contract with portable repositories', async () => {
    mockSettingsGet.mockResolvedValue({
      github: { pat: 'synthetic-settings-token', username: 'octocat' },
      reddit: {},
      youtube: { playlists: [] },
    });
    const { GET } = await import('@/app/api/triage/sources/route');

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.github).toMatchObject({
      username: 'octocat',
      configured: true,
      connectedViaConnector: false,
    });
    expect(body.github.pat).not.toContain('synthetic-settings-token');
  });

  it('writes related credential settings through SettingsRepository', async () => {
    const { POST } = await import('@/app/api/triage/sources/route');
    const response = await POST(new Request('http://localhost/api/triage/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: 'github',
        credentials: { pat: 'synthetic-new-token', username: 'octocat' },
      }),
    }));

    expect(response.status).toBe(200);
    expect(mockSettingsSet).toHaveBeenCalledWith(
      'triage_source_credentials',
      expect.objectContaining({
        github: { pat: 'synthetic-new-token', username: 'octocat' },
      }),
    );
  });

  it('returns 500 rather than falling back after persistence failure', async () => {
    mockSettingsGet.mockRejectedValue(new Error('settings unavailable'));
    const { GET } = await import('@/app/api/triage/sources/route');

    const response = await GET();

    expect(response.status).toBe(500);
    expect(mockFindActiveGitHubToken).not.toHaveBeenCalled();
  });
});
