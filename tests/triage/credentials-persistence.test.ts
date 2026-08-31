import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockSettingsGet = vi.fn();
const mockFindActiveGitHubToken = vi.fn();

vi.mock('@/lib/persistence/runtime', () => ({
  getCorePersistenceRepositories: () => ({
    settings: { get: mockSettingsGet },
  }),
}));

vi.mock('@/lib/triage/persistence', () => ({
  getTriagePersistenceRepositories: () => ({
    githubCredentialFallback: {
      findActiveGitHubToken: mockFindActiveGitHubToken,
    },
  }),
}));

describe('triage scheduled-import credentials', () => {
  const originalGitHubPat = process.env.GITHUB_PAT;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GITHUB_PAT;
    mockSettingsGet.mockResolvedValue(null);
    mockFindActiveGitHubToken.mockResolvedValue(null);
  });

  afterEach(() => {
    if (originalGitHubPat === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = originalGitHubPat;
  });

  it('uses portable settings before the connector fallback', async () => {
    mockSettingsGet.mockResolvedValue({
      github: { pat: 'synthetic-settings-token', username: 'octocat' },
    });
    const { resolveGitHubCredentials } = await import('@/lib/triage/credentials');

    await expect(resolveGitHubCredentials()).resolves.toEqual({
      token: 'synthetic-settings-token',
      username: 'octocat',
      source: 'triage-settings',
    });
    expect(mockFindActiveGitHubToken).not.toHaveBeenCalled();
  });

  it('uses the narrow active-connector token fallback before the environment', async () => {
    process.env.GITHUB_PAT = 'synthetic-env-token';
    mockFindActiveGitHubToken.mockResolvedValue('synthetic-connector-token');
    const { resolveGitHubCredentials } = await import('@/lib/triage/credentials');

    await expect(resolveGitHubCredentials()).resolves.toEqual({
      token: 'synthetic-connector-token',
      source: 'connector',
    });
  });

  it('fails closed when settings persistence fails', async () => {
    process.env.GITHUB_PAT = 'synthetic-env-token';
    mockSettingsGet.mockRejectedValue(new Error('settings unavailable'));
    const { resolveGitHubCredentials } = await import('@/lib/triage/credentials');

    await expect(resolveGitHubCredentials()).rejects.toThrow('settings unavailable');
    expect(mockFindActiveGitHubToken).not.toHaveBeenCalled();
  });
});
