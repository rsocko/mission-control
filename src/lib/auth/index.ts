import { authLogger } from '@/lib/logger';
import { resolveCertificateCredentials, buildCertificateAuthParams } from './certificate';
import { isPkceEnabled, generatePkceChallenge, storePkceVerifier, consumePkceVerifier } from './pkce';
/**
 * Multi-Account OAuth2 Manager
 * 
 * Handles Microsoft Graph OAuth2 flows for both personal (consumers)
 * and work/school (organizations) accounts. Supports multiple simultaneous
 * account connections with independent token management.
 * 
 * Key concepts:
 * - Each connector instance has its own token set (access + refresh)
 * - Personal accounts use tenant "consumers"
 * - Work accounts use tenant "organizations" or a specific tenant ID
 * - Tokens are stored encrypted in connector_configs.credentials
 * 
 * Multi-app-registration support:
 * - Set MS_CLIENT_ID_PERSONAL / MS_CLIENT_SECRET_PERSONAL for a dedicated personal-account app
 * - Set MS_CLIENT_ID_WORK / MS_CLIENT_SECRET_WORK for a dedicated work/school-account app
 * - Both fall back to MS_CLIENT_ID / MS_CLIENT_SECRET when the specific vars are absent
 * - The resolved clientId is stored in connector settings so refreshes use the same app
 */

import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';
import type { ConnectorConfig } from '@/types';

// Microsoft OAuth2 endpoints
const MS_AUTH_BASE = 'https://login.microsoftonline.com';
const MS_GRAPH_SCOPES = {
  todo: ['Tasks.ReadWrite', 'Tasks.ReadWrite.Shared'],
  calendar: ['Calendars.ReadWrite'],
  email: ['Mail.Read'],
};

export interface AccountInfo {
  id: string;
  displayName: string;
  email: string;
  accountType: 'personal' | 'work';
  tenantId: string;
  connectorInstanceId: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp
  scope: string;
  accountType: 'personal' | 'work';
  tenantId: string;
  userEmail?: string;
  userName?: string;
}

/**
 * Resolve the client ID and secret to use for a given account type.
 *
 * Priority order:
 *  1. Account-type-specific vars (MS_CLIENT_ID_PERSONAL / MS_CLIENT_ID_WORK)
 *  2. Generic fallback (MS_CLIENT_ID / MS_CLIENT_SECRET)
 */
export function resolveClientCredentials(accountType: 'personal' | 'work'): { clientId: string; clientSecret: string } {
  const specificId = accountType === 'personal'
    ? process.env.MS_CLIENT_ID_PERSONAL
    : process.env.MS_CLIENT_ID_WORK;
  const specificSecret = accountType === 'personal'
    ? process.env.MS_CLIENT_SECRET_PERSONAL
    : process.env.MS_CLIENT_SECRET_WORK;

  const clientId = specificId || process.env.MS_CLIENT_ID || '';
  const clientSecret = specificSecret || process.env.MS_CLIENT_SECRET || '';

  return { clientId, clientSecret };
}

/**
 * Generate the OAuth2 authorization URL for Microsoft
 */
export function getAuthUrl(params: {
  connectorInstanceId: string;
  accountType: 'personal' | 'work';
  tenantId?: string;
  scopes?: string[];
  /** Override the client ID (e.g. when using a dedicated per-account-type app registration). */
  clientId?: string;
}): string {
  const { clientId: resolvedClientId } = resolveClientCredentials(params.accountType);
  const clientId = params.clientId || resolvedClientId;
  const redirectUri = process.env.MS_REDIRECT_URI || 'http://localhost:3099/api/auth/microsoft/callback';

  // Use appropriate tenant
  const tenant = params.accountType === 'personal'
    ? 'consumers'
    : (params.tenantId || 'organizations');

  const scopes = params.scopes || [
    ...MS_GRAPH_SCOPES.todo,
    'offline_access',
    'User.Read',
  ];

  const state = JSON.stringify({
    connectorInstanceId: params.connectorInstanceId,
    accountType: params.accountType,
    tenantId: tenant,
    clientId,
  });

  const authUrl = new URL(`${MS_AUTH_BASE}/${tenant}/oauth2/v2.0/authorize`);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', scopes.join(' '));
  authUrl.searchParams.set('state', Buffer.from(state).toString('base64'));
  authUrl.searchParams.set('prompt', 'select_account');

  // Add PKCE challenge for public client flows
  if (isPkceEnabled(params.accountType)) {
    const { verifier, challenge, challengeMethod } = generatePkceChallenge();
    storePkceVerifier(params.connectorInstanceId, verifier);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', challengeMethod);
    authLogger.info({ connectorInstanceId: params.connectorInstanceId }, 'Using PKCE public client flow');
  }

  return authUrl.toString();
}

/**
 * Exchange authorization code for tokens
 */
export async function exchangeCodeForTokens(params: {
  code: string;
  accountType: 'personal' | 'work';
  tenantId: string;
  /** Client ID of the app registration used to start the OAuth flow. Falls back to env vars. */
  clientId?: string;
  /** Client secret of the app registration used to start the OAuth flow. Falls back to env vars. */
  clientSecret?: string;
  /** Connector instance ID — needed to retrieve the PKCE verifier for public client flows. */
  connectorInstanceId?: string;
}): Promise<TokenSet> {
  const { clientId: resolvedId, clientSecret: resolvedSecret } = resolveClientCredentials(params.accountType);
  const clientId = params.clientId || resolvedId;
  const clientSecret = params.clientSecret || resolvedSecret;
  const redirectUri = process.env.MS_REDIRECT_URI || 'http://localhost:3099/api/auth/microsoft/callback';

  const tokenUrl = `${MS_AUTH_BASE}/${params.tenantId}/oauth2/v2.0/token`;

  // Build auth params: PKCE > certificate > client_secret
  let authParams: Record<string, string>;
  const pkceVerifier = params.connectorInstanceId ? consumePkceVerifier(params.connectorInstanceId) : null;

  if (pkceVerifier) {
    // Public client PKCE flow — no secret or cert needed
    authLogger.info('Using PKCE public client flow for token exchange');
    authParams = { client_id: clientId, code_verifier: pkceVerifier };
  } else {
    const certCredentials = resolveCertificateCredentials(params.accountType);
    if (certCredentials) {
      authLogger.info('Using certificate-based authentication for token exchange');
      authParams = await buildCertificateAuthParams(clientId, params.tenantId, certCredentials);
    } else {
      authParams = { client_id: clientId, client_secret: clientSecret };
    }
  }

  const body = new URLSearchParams({
    ...authParams,
    code: params.code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    authLogger.error({ status: res.status, errorBody }, 'Token exchange failed');
    throw new Error(`Token exchange failed (HTTP ${res.status}): ${errorBody}`);
  }

  const data = await res.json();

  if (!data.refresh_token) {
    authLogger.warn('Token exchange response missing refresh token');
  }

  // Get user info
  const userInfo = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${data.access_token}` },
  }).then(r => r.json()).catch(() => ({}));

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
    accountType: params.accountType,
    tenantId: params.tenantId,
    userEmail: userInfo.mail || userInfo.userPrincipalName,
    userName: userInfo.displayName,
  };
}

/**
 * Refresh an expired access token with retry logic for transient failures.
 */
// Fully-qualified Graph API scopes for token refresh.
// Personal accounts (consumers tenant) require the full resource URI prefix
// on refresh grants — shorthand scopes return opaque tokens instead of JWTs.
const GRAPH_REFRESH_SCOPES = 'https://graph.microsoft.com/Tasks.ReadWrite https://graph.microsoft.com/Tasks.ReadWrite.Shared https://graph.microsoft.com/User.Read offline_access';

export async function refreshAccessToken(tokenSet: TokenSet, retries = 2, clientCredentials?: { clientId: string; clientSecret: string }): Promise<TokenSet> {
  const { clientId: resolvedId, clientSecret: resolvedSecret } = resolveClientCredentials(tokenSet.accountType);
  const clientId = clientCredentials?.clientId || resolvedId;
  const clientSecret = clientCredentials?.clientSecret || resolvedSecret;

  const tokenUrl = `${MS_AUTH_BASE}/${tokenSet.tenantId}/oauth2/v2.0/token`;

  // Resolve certificate credentials once (cheap); assertion is generated per-attempt
  const certCredentials = resolveCertificateCredentials(tokenSet.accountType);
  const usePublicClient = isPkceEnabled(tokenSet.accountType);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Build auth params per attempt so certificate assertions get a fresh jti
      let authParams: Record<string, string>;
      if (usePublicClient) {
        // Public client refresh — only client_id, no secret or cert
        authParams = { client_id: clientId };
      } else if (certCredentials) {
        authParams = await buildCertificateAuthParams(clientId, tokenSet.tenantId, certCredentials);
      } else {
        authParams = { client_id: clientId || '', client_secret: clientSecret || '' };
      }

      const body = new URLSearchParams({
        ...authParams,
        refresh_token: tokenSet.refreshToken,
        grant_type: 'refresh_token',
        scope: GRAPH_REFRESH_SCOPES,
      });

      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      if (!res.ok) {
        const errorBody = await res.text().catch(() => '');
        const errorDetail = `HTTP ${res.status}: ${errorBody}`;

        // Non-retryable errors (invalid_grant means refresh token is revoked)
        if (res.status === 400 || res.status === 401) {
          authLogger.error({ status: res.status, errorDetail }, 'Token refresh failed');
          throw new Error(`Token refresh failed — re-authentication required. Detail: ${errorDetail}`);
        }

        // Retryable errors (5xx, network issues)
        lastError = new Error(`Token refresh attempt ${attempt + 1} failed: ${errorDetail}`);
        authLogger.warn({ attempt: attempt + 1, maxAttempts: retries + 1, errorDetail }, 'Token refresh attempt failed');
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
          continue;
        }
        throw lastError;
      }

      const data = await res.json();

      const newToken = data.access_token;
      if (!newToken) {
        authLogger.error({ responseKeys: Object.keys(data) }, 'Token refresh response missing access token');
        throw new Error('Token refresh response missing access_token field');
      }
      authLogger.info({ expiresInSeconds: data.expires_in, hasRefreshToken: !!data.refresh_token }, 'Token refresh succeeded');

      return {
        ...tokenSet,
        accessToken: newToken,
        refreshToken: data.refresh_token || tokenSet.refreshToken,
        expiresAt: Date.now() + (data.expires_in * 1000),
        scope: GRAPH_REFRESH_SCOPES,
      };
    } catch (err) {
      if (err instanceof Error && err.message.includes('re-authentication required')) {
        throw err;
      }
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries) {
        authLogger.warn({ err: lastError, attempt: attempt + 1, maxAttempts: retries + 1 }, 'Token refresh network error');
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
    }
  }

  throw lastError || new Error('Token refresh failed after retries');
}

// Simple per-instance refresh lock to prevent concurrent refresh races
const refreshLocks = new Map<string, Promise<string>>();

function connectorCredentials(value: object): ConnectorConfig['credentials'] {
  return value as unknown as ConnectorConfig['credentials'];
}

/**
 * Force-invalidate a connector's cached access token so the next getValidToken
 * call triggers a refresh. Used when the API returns 401 even though our local
 * expiresAt hasn't elapsed (e.g. Microsoft revoked the token early).
 */
export async function invalidateToken(connectorInstanceId: string): Promise<void> {
  const repository = (await getCorePersistenceRepositoriesForBackend()).connectors;
  const config = await repository.get(connectorInstanceId);
  if (config) {
    const creds = config.credentials as unknown as TokenSet;
    if (creds) {
      await repository.updateCredentials(
        connectorInstanceId,
        connectorCredentials({ ...creds, expiresAt: 0 }),
      );
      authLogger.info({ connectorInstanceId }, 'Invalidated connector token');
    }
  }
}

/**
 * Get a valid access token for a connector instance (auto-refreshes if expired).
 * Uses a lock to prevent concurrent refresh attempts that could race on token rotation.
 */
export async function getValidToken(connectorInstanceId: string): Promise<string> {
  const repository = (await getCorePersistenceRepositoriesForBackend()).connectors;
  const config = await repository.get(connectorInstanceId);
  if (!config) throw new Error(`Connector ${connectorInstanceId} not found`);

  const credentials = config.credentials as unknown as TokenSet;
  if (!credentials?.accessToken) throw new Error('No tokens stored for this connector');

  // Check if expired (with 5min buffer)
  if (Date.now() > credentials.expiresAt - 300000) {
    // Use lock to prevent concurrent refresh races
    const existing = refreshLocks.get(connectorInstanceId);
    if (existing) {
      return existing;
    }

    const refreshPromise = (async () => {
      try {
        // Re-read credentials inside lock in case another call already refreshed
        const freshConfig = await repository.get(connectorInstanceId);
        const freshCreds = freshConfig?.credentials as unknown as TokenSet;
        if (freshCreds && Date.now() < freshCreds.expiresAt - 300000) {
          authLogger.info({ connectorInstanceId }, 'Token was already refreshed by another request');
          return freshCreds.accessToken;
        }

        const credsToRefresh = freshCreds || credentials;
        if (!credsToRefresh.refreshToken) {
          throw new Error(`No refresh token available for ${connectorInstanceId} — re-authentication required`);
        }
        // Resolve client credentials: prefer the per-connector stored clientId (supports
        // multiple app registrations) then fall back to environment vars.
        const connectorSettings = (freshConfig?.settings || config.settings) as Record<string, unknown> | null;
        const storedClientId = connectorSettings?.clientId as string | undefined;
        const storedClientSecret = connectorSettings?.clientSecret as string | undefined;
        const clientCredentials = storedClientId
          ? { clientId: storedClientId, clientSecret: storedClientSecret || resolveClientCredentials(credsToRefresh.accountType).clientSecret }
          : undefined;
        authLogger.info({ connectorInstanceId, expiresAt: credsToRefresh.expiresAt, now: Date.now() }, 'Refreshing connector token');
        const refreshed = await refreshAccessToken(credsToRefresh, 2, clientCredentials);

        if (!refreshed.accessToken) {
          throw new Error('Token refresh returned empty access token');
        }

        // Save refreshed tokens
        await repository.updateCredentials(
          connectorInstanceId,
          connectorCredentials(refreshed),
        );

        authLogger.info({ connectorInstanceId, expiresAt: refreshed.expiresAt }, 'Connector token refreshed successfully');
        return refreshed.accessToken;
      } finally {
        refreshLocks.delete(connectorInstanceId);
      }
    })();

    refreshLocks.set(connectorInstanceId, refreshPromise);
    return refreshPromise;
  }

  return credentials.accessToken;
}

/**
 * Store tokens for a connector instance.
 *
 * @param clientId - Optional: the client ID of the app registration used for this connector.
 *   Stored in settings so future token refreshes use the same app registration.
 */
export async function storeTokens(connectorInstanceId: string, tokenSet: TokenSet, clientId?: string): Promise<void> {
  const { clientSecret } = clientId ? resolveClientCredentials(tokenSet.accountType) : { clientSecret: undefined };
  const repository = (await getCorePersistenceRepositoriesForBackend()).connectors;
  const config = await repository.get(connectorInstanceId);
  if (!config) throw new Error(`Connector ${connectorInstanceId} not found`);
  await repository.updateCredentials(
    connectorInstanceId,
    connectorCredentials(tokenSet),
    {
      accountType: tokenSet.accountType,
      tenantId: tokenSet.tenantId,
      userEmail: tokenSet.userEmail,
      userName: tokenSet.userName,
      ...(clientId ? { clientId, clientSecret } : {}),
    },
  );
}

/**
 * Get a valid access token scoped to Outlook/Substrate API.
 * The substrate.office.com/todob2 API requires a token with audience
 * https://outlook.office.com rather than https://graph.microsoft.com.
 * This enables access to the My Day feed endpoint that Graph doesn't expose.
 * 
 * Handles refresh token rotation: if Microsoft returns a new refresh token
 * during the substrate token request, it is persisted to avoid invalidating
 * future Graph token refreshes.
 */
export async function getSubstrateToken(connectorInstanceId: string): Promise<string> {
  const repository = (await getCorePersistenceRepositoriesForBackend()).connectors;
  const config = await repository.get(connectorInstanceId);
  if (!config) throw new Error(`Connector ${connectorInstanceId} not found`);

  const credentials = config.credentials as unknown as TokenSet & { substrateToken?: string; substrateExpiresAt?: number };
  if (!credentials?.refreshToken) throw new Error('No refresh token stored for this connector');

  // Check if we have a cached substrate token that's still valid (5min buffer)
  if (credentials.substrateToken && credentials.substrateExpiresAt && Date.now() < credentials.substrateExpiresAt - 300000) {
    return credentials.substrateToken;
  }

  // Use lock to prevent concurrent substrate token refresh races
  const lockKey = `substrate:${connectorInstanceId}`;
  const existing = refreshLocks.get(lockKey);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async () => {
    try {
      // Re-read credentials inside lock in case another call already refreshed
      const freshConfig = await repository.get(connectorInstanceId);
      const freshCreds = freshConfig?.credentials as unknown as TokenSet & { substrateToken?: string; substrateExpiresAt?: number };
      if (freshCreds?.substrateToken && freshCreds.substrateExpiresAt && Date.now() < freshCreds.substrateExpiresAt - 300000) {
        return freshCreds.substrateToken;
      }

      const credsToUse = freshCreds || credentials;

      // Resolve client credentials: prefer the per-connector stored clientId then env vars.
      const connSettings = (freshConfig?.settings || config.settings) as Record<string, unknown> | null;
      const storedClientId = connSettings?.clientId as string | undefined;
      const storedClientSecret = connSettings?.clientSecret as string | undefined;
      const { clientId: resolvedId, clientSecret: resolvedSecret } = resolveClientCredentials(credsToUse.accountType);
      const clientId = storedClientId || resolvedId;
      const clientSecret = storedClientSecret || resolvedSecret;

      // Request a new token with Outlook audience
      const tokenUrl = `${MS_AUTH_BASE}/${credsToUse.tenantId}/oauth2/v2.0/token`;

      // Resolve certificate credentials once; assertion generated per-attempt for fresh jti
      const certCreds = resolveCertificateCredentials(credsToUse.accountType);
      const usePublicClient = isPkceEnabled(credsToUse.accountType);

      let lastError: Error | null = null;
      for (let attempt = 0; attempt <= 2; attempt++) {
        // Build auth params per attempt so certificate assertions get a fresh jti
        let authParams: Record<string, string>;
        if (usePublicClient) {
          authParams = { client_id: clientId };
        } else if (certCreds) {
          authParams = await buildCertificateAuthParams(clientId, credsToUse.tenantId, certCreds);
        } else {
          authParams = { client_id: clientId, client_secret: clientSecret };
        }

        const body = new URLSearchParams({
          ...authParams,
          refresh_token: credsToUse.refreshToken,
          grant_type: 'refresh_token',
          scope: 'https://outlook.office.com/Tasks.ReadWrite offline_access',
        });

        const res = await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });

        if (!res.ok) {
          const errorBody = await res.text().catch(() => '');
          if (res.status === 400 || res.status === 401) {
            authLogger.error({ status: res.status, errorBody }, 'Substrate token refresh failed');
            throw new Error(`Substrate token refresh failed — re-authentication may be required. Detail: HTTP ${res.status}`);
          }
          lastError = new Error(`Substrate token refresh attempt ${attempt + 1} failed: HTTP ${res.status}`);
          authLogger.warn({ attempt: attempt + 1, maxAttempts: 3, err: lastError }, 'Substrate token refresh attempt failed');
          if (attempt < 2) {
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
            continue;
          }
          throw lastError;
        }

        const data = await res.json();

        // Cache the substrate token AND update the primary refresh token if rotated.
        // Microsoft may issue a new refresh_token on any token request — if we don't
        // persist it, the old refresh_token becomes invalid and Graph token refresh breaks.
        const updatedCredentials: Record<string, unknown> = {
          ...credsToUse,
          substrateToken: data.access_token,
          substrateExpiresAt: Date.now() + (data.expires_in * 1000),
        };

        // Persist rotated refresh token to prevent invalidation of future refreshes
        if (data.refresh_token && data.refresh_token !== credsToUse.refreshToken) {
          updatedCredentials.refreshToken = data.refresh_token;
          authLogger.info('Substrate token request returned a rotated refresh token');
        }

        await repository.updateCredentials(
          connectorInstanceId,
          connectorCredentials(updatedCredentials),
        );

        return data.access_token as string;
      }

      throw lastError || new Error('Substrate token refresh failed after retries');
    } finally {
      refreshLocks.delete(lockKey);
    }
  })();

  refreshLocks.set(lockKey, refreshPromise);
  return refreshPromise;
}

/**
 * Probe permissions for a connected account
 */
export async function probePermissions(connectorInstanceId: string): Promise<{
  account: { email: string; name: string; type: string };
  permissions: Array<{ scope: string; granted: boolean; required: boolean }>;
  canRead: boolean;
  canWrite: boolean;
  issues: string[];
}> {
  const token = await getValidToken(connectorInstanceId);
  const issues: string[] = [];

  // Test Graph API access
  const permissions: Array<{ scope: string; granted: boolean; required: boolean }> = [];

  // Test user profile
  const meRes = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const meOk = meRes.ok;
  const meData = meOk ? await meRes.json() : {};

  // Test todo lists read
  const todoReadRes = await fetch('https://graph.microsoft.com/v1.0/me/todo/lists', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const canReadTodo = todoReadRes.ok;
  permissions.push({ scope: 'Tasks.ReadWrite', granted: canReadTodo, required: true });
  if (!canReadTodo) issues.push('Cannot read Todo lists — Tasks.ReadWrite permission may be blocked by IT policy');

  // Test creating a todo (dry run — just check endpoint access)
  // We'll test write by trying to get a specific list's tasks
  let canWriteTodo = false;
  if (canReadTodo) {
    const lists = await todoReadRes.json();
    if (lists.value?.length > 0) {
      const testListId = lists.value[0].id;
      const writeTestRes = await fetch(`https://graph.microsoft.com/v1.0/me/todo/lists/${testListId}/tasks?$top=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      canWriteTodo = writeTestRes.ok;
    }
  }
  permissions.push({ scope: 'Tasks.ReadWrite (write)', granted: canWriteTodo, required: false });

  // Test calendar access
  const calRes = await fetch('https://graph.microsoft.com/v1.0/me/calendars', {
    headers: { Authorization: `Bearer ${token}` },
  });
  permissions.push({ scope: 'Calendars.ReadWrite', granted: calRes.ok, required: false });
  if (!calRes.ok) issues.push('Calendar access not available — may need admin consent');

  // Test mail access
  const mailRes = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  permissions.push({ scope: 'Mail.Read', granted: mailRes.ok, required: false });

  return {
    account: {
      email: meData.mail || meData.userPrincipalName || 'unknown',
      name: meData.displayName || 'Unknown',
      type: meData.userPrincipalName?.includes('#EXT#') ? 'guest' : 'member',
    },
    permissions,
    canRead: canReadTodo,
    canWrite: canWriteTodo,
    issues,
  };
}

// Re-export certificate utilities for use by other modules
export { isCertificateAuthConfigured, resolveCertificateCredentials } from './certificate';
export { isPkceEnabled } from './pkce';
