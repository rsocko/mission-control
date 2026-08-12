import type {
  ExternalIdentityEvidence,
  ExternalIdentityObservation,
} from '@/lib/external-identities/types';
import type {
  GitHubRestIssue,
  GitHubRestRepository,
} from './github-client';

export const DEFAULT_GITHUB_API_ORIGIN = 'https://api.github.com';

export interface TrustedGitHubOrigin {
  hostKey: string;
  restBaseUrl: string;
  graphqlUrl: string;
}

export interface GitHubGraphQLRepositoryIdentity {
  id: string;
  nameWithOwner: string;
  url: string;
}

export function normalizeGitHubOrigin(
  configuredOrigin = DEFAULT_GITHUB_API_ORIGIN,
): TrustedGitHubOrigin {
  let parsed: URL;
  try {
    parsed = new URL(configuredOrigin);
  } catch {
    throw new Error('GitHub API origin must be a valid absolute URL');
  }

  if (parsed.username || parsed.password) {
    throw new Error('GitHub API origin must not include credentials');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('GitHub API origin must not include a query string or fragment');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (!hostname) {
    throw new Error('GitHub API origin must include a hostname');
  }
  const loopback = isLoopbackHostname(hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('GitHub API origin must use HTTPS unless it is an explicit loopback origin');
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const githubCom = !parsed.port
    && (hostname === 'api.github.com' || hostname === 'github.com');
  if (githubCom && path !== '') {
    throw new Error('GitHub.com API origin must not include a path');
  }
  if (!githubCom && path !== '' && path !== '/api/v3') {
    throw new Error('GitHub Enterprise API origin path must be empty or /api/v3');
  }

  if (githubCom) {
    return {
      hostKey: 'github.com',
      restBaseUrl: 'https://api.github.com',
      graphqlUrl: 'https://api.github.com/graphql',
    };
  }

  const authority = formatAuthority(hostname, parsed.port);
  const origin = `${parsed.protocol}//${authority}`;
  return {
    hostKey: authority,
    restBaseUrl: `${origin}/api/v3`,
    graphqlUrl: `${origin}/api/graphql`,
  };
}

export function assertTrustedGitHubUrl(
  value: string,
  trustedOrigin: TrustedGitHubOrigin,
): URL {
  const parsed = new URL(value);
  if (parsed.username || parsed.password) {
    throw new Error('GitHub response URL must not include credentials');
  }
  const normalized = normalizeGitHubOrigin(parsed.origin);
  if (normalized.hostKey !== trustedOrigin.hostKey) {
    throw new Error('GitHub response URL does not match the configured host');
  }
  return parsed;
}

export function repositoryEvidenceFromRest(
  repository: GitHubRestRepository,
  origin: TrustedGitHubOrigin,
  observedAt: string,
): ExternalIdentityObservation | undefined {
  if (!repository.node_id) return undefined;
  const { owner, repository: name } = splitRepositoryName(repository.full_name);
  return {
    identity: {
      provider: 'github',
      hostKey: origin.hostKey,
      entityType: 'repository',
      stableId: repository.node_id,
    },
    locator: {
      owner,
      repository: name,
      apiUrl: trustedLocatorUrl(repository.url, origin),
      webUrl: trustedLocatorUrl(repository.html_url, origin),
    },
    observationSource: 'rest',
    observedAt,
  };
}

export function repositoryEvidenceFromGraphQL(
  repository: GitHubGraphQLRepositoryIdentity,
  origin: TrustedGitHubOrigin,
  observedAt: string,
): ExternalIdentityObservation {
  const { owner, repository: name } = splitRepositoryName(repository.nameWithOwner);
  return {
    identity: {
      provider: 'github',
      hostKey: origin.hostKey,
      entityType: 'repository',
      stableId: repository.id,
    },
    locator: {
      owner,
      repository: name,
      webUrl: trustedLocatorUrl(repository.url, origin),
    },
    observationSource: 'graphql',
    observedAt,
  };
}

export function issueEvidenceFromRest(
  issue: GitHubRestIssue,
  repository: ExternalIdentityObservation,
  origin: TrustedGitHubOrigin,
  observedAt: string,
): ExternalIdentityEvidence | undefined {
  if (!issue.node_id) return undefined;
  return issueEvidence(
    issue.node_id,
    issue.number,
    trustedLocatorUrl(issue.url, origin),
    trustedLocatorUrl(issue.html_url, origin),
    repository,
    'rest',
    observedAt,
  );
}

export function issueEvidenceFromGraphQL(
  stableId: string,
  issueNumber: number,
  webUrl: string | undefined,
  repository: ExternalIdentityObservation,
  origin: TrustedGitHubOrigin,
  observedAt: string,
): ExternalIdentityEvidence {
  return issueEvidence(
    stableId,
    issueNumber,
    undefined,
    trustedLocatorUrl(webUrl, origin),
    repository,
    'graphql',
    observedAt,
  );
}

function issueEvidence(
  stableId: string,
  issueNumber: number,
  apiUrl: string | undefined,
  webUrl: string | undefined,
  repository: ExternalIdentityObservation,
  observationSource: 'graphql' | 'rest',
  observedAt: string,
): ExternalIdentityEvidence {
  return {
    repository,
    entity: {
      identity: {
        provider: 'github',
        hostKey: repository.identity.hostKey,
        entityType: 'issue',
        stableId,
      },
      locator: {
        owner: repository.locator.owner,
        repository: repository.locator.repository,
        issueNumber,
        apiUrl,
        webUrl,
      },
      observationSource,
      observedAt,
    },
  };
}

function trustedLocatorUrl(
  value: string | undefined,
  origin: TrustedGitHubOrigin,
): string | undefined {
  if (!value) return undefined;
  return assertTrustedGitHubUrl(value, origin).toString();
}

function splitRepositoryName(nameWithOwner: string): { owner: string; repository: string } {
  const parts = nameWithOwner.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('GitHub repository identity must include owner/name');
  }
  return { owner: parts[0], repository: parts[1] };
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname === '[::1]';
}

function formatAuthority(hostname: string, port: string): string {
  const formattedHostname = hostname.includes(':') && !hostname.startsWith('[')
    ? `[${hostname}]`
    : hostname;
  return port ? `${formattedHostname}:${port}` : formattedHostname;
}
