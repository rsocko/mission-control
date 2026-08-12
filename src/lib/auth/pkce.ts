/**
 * PKCE (Proof Key for Code Exchange) support for Public Client OAuth2 flows.
 *
 * When a tenant blocks both client secrets AND certificate credentials on app
 * registrations, a public client with PKCE can still authenticate. Instead of
 * proving identity with a secret/cert, the app proves it initiated the request
 * by presenting a code_verifier that matches the code_challenge sent at auth start.
 *
 * Required configuration:
 *   The app registration must have "Allow public client flows" enabled in Azure Portal
 *   under Authentication → Advanced settings.
 *
 * Environment variables:
 *   MS_PUBLIC_CLIENT=true                     — Enables PKCE for all account types
 *   MS_PUBLIC_CLIENT_PERSONAL=true            — Enables PKCE for personal accounts only
 *   MS_PUBLIC_CLIENT_WORK=true                — Enables PKCE for work accounts only
 *
 * When PKCE is enabled for an account type, token exchange and refresh omit
 * client_secret/client_assertion entirely and rely solely on the code_verifier
 * (for initial exchange) or just client_id (for refresh).
 *
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow#request-an-authorization-code
 */

import { createHash, randomBytes } from 'node:crypto';

/**
 * In-memory store for PKCE code verifiers, keyed by connector instance ID.
 * These are ephemeral — they only need to survive from auth start to callback
 * (typically seconds). In a multi-instance deployment, you'd use a shared store,
 * but for a single-container app this is sufficient.
 */
const verifierStore = new Map<string, { verifier: string; createdAt: number }>();

// Clean up stale verifiers older than 10 minutes (auth flows that were abandoned)
const VERIFIER_TTL_MS = 10 * 60 * 1000;

function cleanStaleVerifiers() {
  const now = Date.now();
  for (const [key, entry] of verifierStore) {
    if (now - entry.createdAt > VERIFIER_TTL_MS) {
      verifierStore.delete(key);
    }
  }
}

/**
 * Check whether PKCE (public client) mode is enabled for a given account type.
 */
export function isPkceEnabled(accountType: 'personal' | 'work'): boolean {
  const suffix = accountType === 'personal' ? '_PERSONAL' : '_WORK';
  const specific = process.env[`MS_PUBLIC_CLIENT${suffix}`];
  if (specific) return specific.toLowerCase() === 'true';
  return process.env.MS_PUBLIC_CLIENT?.toLowerCase() === 'true';
}

/**
 * Generate a PKCE code verifier and challenge pair.
 *
 * The verifier is a high-entropy random string (43-128 chars, base64url).
 * The challenge is the SHA-256 hash of the verifier, base64url-encoded.
 *
 * @returns { verifier, challenge, challengeMethod }
 */
export function generatePkceChallenge(): { verifier: string; challenge: string; challengeMethod: 'S256' } {
  // Generate 32 bytes of randomness → 43 base64url characters
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, challengeMethod: 'S256' };
}

/**
 * Store a PKCE verifier for a connector instance (used during auth flow initiation).
 */
export function storePkceVerifier(connectorInstanceId: string, verifier: string): void {
  cleanStaleVerifiers();
  verifierStore.set(connectorInstanceId, { verifier, createdAt: Date.now() });
}

/**
 * Retrieve and consume the PKCE verifier for a connector instance (used during callback).
 * Returns null if no verifier is stored (non-PKCE flow or expired).
 */
export function consumePkceVerifier(connectorInstanceId: string): string | null {
  const entry = verifierStore.get(connectorInstanceId);
  if (!entry) return null;
  verifierStore.delete(connectorInstanceId);
  // Check TTL
  if (Date.now() - entry.createdAt > VERIFIER_TTL_MS) return null;
  return entry.verifier;
}
