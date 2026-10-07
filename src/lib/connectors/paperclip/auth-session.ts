import 'server-only';

import { ExternalAgentError } from '@/lib/external-agents/errors';
import { discoverPaperclip } from '@/lib/external-agents/paperclip';

const SESSION_TTL_MS = 10 * 60 * 1000;
const CONNECTOR_KEY_TTL_MS = 90 * 24 * 60 * 60 * 1000;

interface PaperclipAuthSession {
  id: string;
  apiOrigin: string;
  challengeId: string;
  challengeToken: string;
  bootstrapToken: string;
  pollPath: string;
  approvalUrl: string;
  suggestedPollIntervalMs: number;
  expiresAt: string;
  connectorToken?: string;
  keyId?: string;
  keyExpiresAt?: string | null;
  userId?: string;
  userName?: string | null;
  companies?: Array<{ id: string; name: string; status: string | null }>;
}

interface ChallengeResponse {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  pollPath: string;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

interface ChallengeStatus {
  status: 'pending' | 'approved' | 'cancelled' | 'expired';
}

interface BoardIdentity {
  userId: string;
  user?: { id?: string; name?: string | null } | null;
  keyId: string | null;
}

interface CreatedBoardKey {
  id: string;
  token: string;
  expiresAt: string | null;
}

interface BoardKey {
  id: string;
  expiresAt: string | null;
}

const sessions = new Map<string, PaperclipAuthSession>();

function normalizeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ExternalAgentError(
      'Paperclip API origin must be an absolute HTTP(S) URL',
      'VALIDATION_ERROR',
      422,
    );
  }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname)
    || url.hostname.endsWith('.localhost');
  if (
    !['http:', 'https:'].includes(url.protocol)
    || (!local && url.protocol !== 'https:')
    || url.username
    || url.password
    || (url.pathname !== '/' && url.pathname !== '')
    || url.search
    || url.hash
  ) {
    throw new ExternalAgentError(
      'Paperclip API origin must be an HTTPS origin without credentials, path, query, or fragment',
      'VALIDATION_ERROR',
      422,
    );
  }
  return url.origin;
}

function apiUrl(origin: string, path: string): string {
  return new URL(`/api${path}`, origin).toString();
}

async function requestJson<T>(
  url: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      Accept: 'application/json',
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === 'object' && 'error' in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${response.status}`;
    throw new ExternalAgentError(
      `Paperclip authorization failed: ${message}`,
      response.status === 401 ? 'CREDENTIAL_INVALID' : 'PROVIDER_ERROR',
      response.status >= 500 ? 502 : response.status,
    );
  }
  return body as T;
}

function requireSession(id: string): PaperclipAuthSession {
  const session = sessions.get(id);
  if (!session) {
    throw new ExternalAgentError(
      'Paperclip authorization session was not found',
      'NOT_FOUND',
      404,
    );
  }
  if (Date.parse(session.expiresAt) <= Date.now()) {
    sessions.delete(id);
    throw new ExternalAgentError(
      'Paperclip authorization session expired',
      'PROVIDER_STATE_REJECTED',
      410,
    );
  }
  return session;
}

export async function startPaperclipAuthorization(apiOriginInput: string) {
  const apiOrigin = normalizeOrigin(apiOriginInput);
  const challenge = await requestJson<ChallengeResponse>(
    apiUrl(apiOrigin, '/cli-auth/challenges'),
    {
      method: 'POST',
      body: {
        command: 'Connect Mission Control',
        clientName: 'Mission Control connector',
        requestedAccess: 'board',
        requestedCompanyId: null,
      },
    },
  );
  const id = crypto.randomUUID();
  const expiresAt = Number.isFinite(Date.parse(challenge.expiresAt))
    ? challenge.expiresAt
    : new Date(Date.now() + SESSION_TTL_MS).toISOString();
  let approvalUrl: string;
  try {
    approvalUrl = challenge.approvalUrl
      ? new URL(challenge.approvalUrl).toString()
      : new URL(challenge.approvalPath, apiOrigin).toString();
  } catch {
    throw new ExternalAgentError(
      'Paperclip returned an invalid approval URL',
      'PROVIDER_ERROR',
      502,
    );
  }
  if (new URL(approvalUrl).origin !== apiOrigin) {
    throw new ExternalAgentError(
      'Paperclip returned an approval URL for a different origin',
      'PROVIDER_SCOPE_MISMATCH',
      502,
    );
  }
  sessions.set(id, {
    id,
    apiOrigin,
    challengeId: challenge.id,
    challengeToken: challenge.token,
    bootstrapToken: challenge.boardApiToken,
    pollPath: challenge.pollPath,
    approvalUrl,
    suggestedPollIntervalMs: Math.max(500, challenge.suggestedPollIntervalMs || 1000),
    expiresAt,
  });
  return {
    authSessionId: id,
    approvalUrl,
    expiresAt,
    suggestedPollIntervalMs: Math.max(500, challenge.suggestedPollIntervalMs || 1000),
  };
}

export async function pollPaperclipAuthorization(id: string) {
  const session = requireSession(id);
  if (session.connectorToken) {
    return completedSession(session);
  }
  const status = await requestJson<ChallengeStatus>(
    `${apiUrl(session.apiOrigin, session.pollPath)}?token=${encodeURIComponent(session.challengeToken)}`,
  );
  if (status.status !== 'approved') {
    if (status.status === 'cancelled' || status.status === 'expired') {
      sessions.delete(id);
    }
    return { status: status.status };
  }

  const identity = await requestJson<BoardIdentity>(
    apiUrl(session.apiOrigin, '/cli-auth/me'),
    { token: session.bootstrapToken },
  );
  const discovery = await discoverPaperclip({
    endpoint: session.apiOrigin,
    credential: session.bootstrapToken,
  });
  const namedKey = await requestJson<CreatedBoardKey>(
    apiUrl(session.apiOrigin, '/board-api-keys'),
    {
      method: 'POST',
      token: session.bootstrapToken,
      body: {
        name: 'mission-control-connector',
        expiresAt: new Date(Date.now() + CONNECTOR_KEY_TTL_MS).toISOString(),
        requestedCompanyId: null,
      },
    },
  );
  try {
    await requestJson(
      apiUrl(session.apiOrigin, '/cli-auth/revoke-current'),
      { method: 'POST', token: session.bootstrapToken, body: {} },
    );
  } catch (revokeError) {
    try {
      await requestJson(
        apiUrl(session.apiOrigin, `/board-api-keys/${encodeURIComponent(namedKey.id)}`),
        { method: 'DELETE', token: session.bootstrapToken },
      );
    } catch (cleanupError) {
      throw new ExternalAgentError(
        `Paperclip temporary-key revocation failed and the connector key could not be cleaned up: ${
          cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        }`,
        'PROVIDER_ERROR',
        502,
      );
    }
    throw revokeError;
  }
  session.connectorToken = namedKey.token;
  session.keyId = namedKey.id;
  session.keyExpiresAt = namedKey.expiresAt;
  session.userId = identity.userId;
  session.userName = identity.user?.name ?? null;
  session.companies = discovery.companies;
  return completedSession(session);
}

function completedSession(session: PaperclipAuthSession) {
  return {
    status: 'approved' as const,
    apiOrigin: session.apiOrigin,
    keyId: session.keyId!,
    keyExpiresAt: session.keyExpiresAt ?? null,
    userId: session.userId!,
    userName: session.userName ?? null,
    companies: session.companies ?? [],
  };
}

export function consumePaperclipAuthorization(
  id: string,
  apiOriginInput: string,
  companyId: string,
) {
  const session = requireSession(id);
  const apiOrigin = normalizeOrigin(apiOriginInput);
  if (!session.connectorToken || !session.keyId || !session.userId) {
    throw new ExternalAgentError(
      'Paperclip authorization has not been approved',
      'PROVIDER_STATE_REJECTED',
      409,
    );
  }
  if (session.apiOrigin !== apiOrigin) {
    throw new ExternalAgentError(
      'Paperclip authorization does not match this API origin',
      'PROVIDER_SCOPE_MISMATCH',
      422,
    );
  }
  const company = session.companies?.find((candidate) => candidate.id === companyId);
  if (!company) {
    throw new ExternalAgentError(
      'Paperclip company is not accessible with this authorization',
      'PROVIDER_SCOPE_MISMATCH',
      422,
    );
  }
  return {
    apiToken: session.connectorToken,
    companyName: company.name,
    keyId: session.keyId,
    keyExpiresAt: session.keyExpiresAt ?? null,
    boardUserId: session.userId,
    boardUserName: session.userName ?? null,
  };
}

export function completePaperclipAuthorization(id: string) {
  sessions.delete(id);
}

export async function getPaperclipBoardKeyMetadata(
  apiOrigin: string,
  apiToken: string,
) {
  const identity = await requestJson<BoardIdentity>(
    apiUrl(normalizeOrigin(apiOrigin), '/cli-auth/me'),
    { token: apiToken },
  );
  const keys = await requestJson<BoardKey[]>(
    apiUrl(normalizeOrigin(apiOrigin), '/board-api-keys'),
    { token: apiToken },
  );
  const key = keys.find((candidate) => candidate.id === identity.keyId);
  return {
    keyId: identity.keyId,
    expiresAt: key?.expiresAt ?? null,
    userId: identity.userId,
    userName: identity.user?.name ?? null,
  };
}
