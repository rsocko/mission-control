/**
 * Certificate-Based Client Authentication for Microsoft Entra ID
 *
 * When a tenant policy blocks client secrets, this module provides certificate-based
 * authentication as an alternative. Instead of sending a `client_secret` in token
 * requests, we construct a signed JWT assertion (`client_assertion`) using an X.509
 * certificate's private key.
 *
 * Required environment variables:
 *   MS_CERT_THUMBPRINT       - SHA-1 thumbprint of the uploaded certificate (hex, no colons)
 *   MS_CERT_PRIVATE_KEY      - PEM-encoded private key (inline, with \n for newlines)
 *   — OR —
 *   MS_CERT_PRIVATE_KEY_PATH - Path to a PEM file containing the private key
 *
 * Optional per-account-type overrides (same pattern as client ID/secret):
 *   MS_CERT_THUMBPRINT_PERSONAL / MS_CERT_PRIVATE_KEY_PERSONAL / MS_CERT_PRIVATE_KEY_PATH_PERSONAL
 *   MS_CERT_THUMBPRINT_WORK     / MS_CERT_PRIVATE_KEY_WORK     / MS_CERT_PRIVATE_KEY_PATH_WORK
 *
 * How it works:
 *   Microsoft's token endpoint accepts `client_assertion_type=urn:ietf:params:oauth:client-assertion-type:jwt-bearer`
 *   alongside a `client_assertion` JWT. The JWT is signed with the certificate's private key
 *   and includes an x5t header (Base64url-encoded SHA-1 thumbprint) so Microsoft can look up
 *   the matching public certificate on the App Registration.
 *
 * @see https://learn.microsoft.com/en-us/entra/identity-platform/certificate-credentials
 */

import { importPKCS8, SignJWT } from 'jose';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

// Cache imported private keys by identifier to avoid re-parsing on every token request.
// Using a Map of Promises prevents concurrent imports from racing.
const keyCache = new Map<string, Promise<CryptoKey>>();

export interface CertificateCredentials {
  thumbprint: string;
  privateKeyPem: string;
}

/**
 * Resolve certificate credentials for a given account type.
 *
 * Priority order (same pattern as resolveClientCredentials):
 *  1. Account-type-specific vars (MS_CERT_THUMBPRINT_PERSONAL / MS_CERT_THUMBPRINT_WORK)
 *  2. Generic fallback (MS_CERT_THUMBPRINT / MS_CERT_PRIVATE_KEY)
 *
 * Returns null if certificate auth is not configured (no thumbprint set).
 * Throws if partially configured (thumbprint set but private key missing/unreadable).
 */
export function resolveCertificateCredentials(accountType: 'personal' | 'work'): CertificateCredentials | null {
  const suffix = accountType === 'personal' ? '_PERSONAL' : '_WORK';

  const thumbprint = process.env[`MS_CERT_THUMBPRINT${suffix}`] || process.env.MS_CERT_THUMBPRINT;
  if (!thumbprint) return null;

  // Validate thumbprint format: must be exactly 40 hex characters (SHA-1)
  const normalizedThumbprint = thumbprint.replace(/[:\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalizedThumbprint)) {
    throw new Error(
      `MS_CERT_THUMBPRINT is invalid: expected 40 hex characters (SHA-1), got "${thumbprint.slice(0, 20)}...". ` +
      'Remove colons, spaces, and ensure it is the full SHA-1 fingerprint.'
    );
  }

  // Try inline key first, then file path
  let privateKeyPem = process.env[`MS_CERT_PRIVATE_KEY${suffix}`] || process.env.MS_CERT_PRIVATE_KEY;
  if (!privateKeyPem) {
    const keyPath = process.env[`MS_CERT_PRIVATE_KEY_PATH${suffix}`] || process.env.MS_CERT_PRIVATE_KEY_PATH;
    if (keyPath) {
      try {
        privateKeyPem = readFileSync(keyPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Certificate thumbprint is configured but private key file is unreadable at "${keyPath}". ` +
          'Ensure the file exists and is accessible. ' +
          `(${err instanceof Error ? err.message : String(err)})`
        );
      }
    }
  }

  if (!privateKeyPem) {
    throw new Error(
      'MS_CERT_THUMBPRINT is set but no private key is configured. ' +
      'Set MS_CERT_PRIVATE_KEY (inline PEM) or MS_CERT_PRIVATE_KEY_PATH (file path).'
    );
  }

  // Normalize inline key (env vars often use literal \n)
  privateKeyPem = privateKeyPem.replace(/\\n/g, '\n');

  return { thumbprint: normalizedThumbprint, privateKeyPem };
}

/**
 * Check whether certificate-based auth is configured for a given account type.
 */
export function isCertificateAuthConfigured(accountType: 'personal' | 'work'): boolean {
  return resolveCertificateCredentials(accountType) !== null;
}

/**
 * Create a client assertion JWT signed with the certificate's private key.
 *
 * The JWT contains:
 *  - Header: alg=RS256, typ=JWT, x5t=<base64url SHA-1 thumbprint>
 *  - Payload: iss=clientId, sub=clientId, aud=<token endpoint>, exp=+10min, jti=<random>
 *
 * @param clientId - The application (client) ID
 * @param tenantId - The tenant ID (e.g. "consumers", "organizations", or a GUID)
 * @param certCredentials - Certificate thumbprint and private key
 */
export async function createClientAssertion(
  clientId: string,
  tenantId: string,
  certCredentials: CertificateCredentials,
): Promise<string> {
  const { thumbprint, privateKeyPem } = certCredentials;

  // Convert hex thumbprint to base64url (x5t header value)
  const thumbprintBuffer = Buffer.from(thumbprint, 'hex');
  const x5t = thumbprintBuffer.toString('base64url');

  // Import or reuse cached private key (race-safe via Promise caching)
  const keyIdentifier = createHash('sha256').update(privateKeyPem).digest('hex').slice(0, 16);
  let keyPromise = keyCache.get(keyIdentifier);
  if (!keyPromise) {
    keyPromise = importPKCS8(privateKeyPem, 'RS256').catch((err) => {
      keyCache.delete(keyIdentifier);
      throw new Error(
        'Failed to import certificate private key. Ensure it is an unencrypted RSA key in PKCS#8 PEM format. ' +
        `(${err instanceof Error ? err.message : String(err)})`
      );
    });
    keyCache.set(keyIdentifier, keyPromise);
  }
  const signingKey = await keyPromise;

  const audience = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
  const now = Math.floor(Date.now() / 1000);

  const assertion = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT', x5t })
    .setIssuer(clientId)
    .setSubject(clientId)
    .setAudience(audience)
    .setIssuedAt(now)
    .setExpirationTime(now + 600) // 10 minutes
    .setJti(crypto.randomUUID())
    .sign(signingKey);

  return assertion;
}

/**
 * Build the token request body params for certificate-based auth.
 * Replaces the `client_secret` param with `client_assertion` + `client_assertion_type`.
 */
export async function buildCertificateAuthParams(
  clientId: string,
  tenantId: string,
  certCredentials: CertificateCredentials,
): Promise<Record<string, string>> {
  const assertion = await createClientAssertion(clientId, tenantId, certCredentials);
  return {
    client_id: clientId,
    client_assertion_type: CLIENT_ASSERTION_TYPE,
    client_assertion: assertion,
  };
}

export { CLIENT_ASSERTION_TYPE };
