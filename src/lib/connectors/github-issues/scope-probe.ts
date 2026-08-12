/**
 * GitHub PAT scope probe — detects which OAuth scopes are granted on the token
 * by reading the `X-OAuth-Scopes` response header from any GitHub REST API call.
 */

import { GITHUB_REST_URL } from './github-client';

export interface GitHubScopeDefinition {
  scope: string;
  label: string;
  description: string;
  granted: boolean;
  required: boolean;
}

export interface GitHubPermissionsResult {
  account: { login: string; name: string; avatarUrl: string };
  scopes: GitHubScopeDefinition[];
  rawScopes: string[];
  issues: string[];
  tokenType: 'classic' | 'fine-grained' | 'unknown';
}

/**
 * Known GitHub classic token scopes we care about.
 * `X-OAuth-Scopes` header returns a comma-separated list for classic PATs.
 * Fine-grained tokens do NOT return `X-OAuth-Scopes` (it's empty or absent).
 */
const SCOPE_DEFINITIONS: Array<{ scope: string; label: string; description: string; required: boolean }> = [
  { scope: 'repo', label: 'Repositories', description: 'Full access to repos — issues, labels, PRs, code', required: true },
  { scope: 'project', label: 'Projects v2', description: 'Read/write GitHub Projects v2 boards', required: false },
  { scope: 'notifications', label: 'Notifications', description: 'Read notifications for alert sync', required: false },
  { scope: 'read:org', label: 'Org Access', description: 'Read org membership for private org repos', required: false },
  { scope: 'read:user', label: 'User Profile', description: 'Read user profile information', required: false },
];

/**
 * Probes the GitHub API with the given token and returns detected scopes.
 */
export async function probeGitHubScopes(token: string): Promise<GitHubPermissionsResult> {
  const issues: string[] = [];

  // Make a lightweight API call to read response headers
  const res = await fetch(`${GITHUB_REST_URL}/user`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github.v3+json',
    },
  });

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status}: ${res.statusText}`);
  }

  const userData = await res.json();
  const oauthScopesHeader = res.headers.get('x-oauth-scopes') || '';

  // Determine token type
  // Fine-grained tokens have no X-OAuth-Scopes header (empty string)
  // Classic tokens list their scopes
  const rawScopes = oauthScopesHeader
    .split(',')
    .map((s: string) => s.trim())
    .filter(Boolean);

  const tokenType: GitHubPermissionsResult['tokenType'] = rawScopes.length === 0
    ? 'fine-grained'
    : 'classic';

  // For classic tokens, check each expected scope
  const scopes: GitHubScopeDefinition[] = SCOPE_DEFINITIONS.map(def => {
    let granted: boolean;

    if (tokenType === 'fine-grained') {
      // Fine-grained tokens don't expose scopes via header — we can't determine them this way.
      // Mark all as unknown/not-detectable (we'll show a different message in UI).
      granted = false;
    } else {
      // Classic token: check if scope is present in the header
      granted = rawScopes.includes(def.scope);
    }

    if (!granted && def.required) {
      issues.push(`Missing required scope: ${def.scope} (${def.description})`);
    }

    return { ...def, granted };
  });

  // For fine-grained tokens, add a note
  if (tokenType === 'fine-grained') {
    issues.push('Fine-grained tokens do not expose scopes via API headers. Permission detection is limited — check your token settings on GitHub if features are missing.');
  }

  return {
    account: {
      login: userData.login || 'unknown',
      name: userData.name || userData.login || 'Unknown',
      avatarUrl: userData.avatar_url || '',
    },
    scopes,
    rawScopes,
    issues,
    tokenType,
  };
}
