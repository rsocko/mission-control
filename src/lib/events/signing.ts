import { createHmac } from 'crypto';

/**
 * Raised when neither the subscription secret nor `MC_EVENT_SECRET` is
 * configured. Outbound events are never sent unsigned: a missing signing
 * secret is a configuration fault that must surface, not be silently
 * downgraded to an empty `X-MC-Signature` header.
 */
export class MissingEventSigningSecretError extends Error {
  readonly code = 'signing_secret_missing';

  constructor() {
    super('No outbound event signing secret is configured');
    this.name = 'MissingEventSigningSecretError';
  }
}

export function resolveEventSigningSecret(secret?: string | null): string {
  const signingSecret = secret || process.env.MC_EVENT_SECRET || '';
  if (!signingSecret) {
    throw new MissingEventSigningSecretError();
  }
  return signingSecret;
}

export function buildEventSignature(payload: string, secret?: string | null): string {
  const signingSecret = resolveEventSigningSecret(secret);
  return `sha256=${createHmac('sha256', signingSecret).update(payload).digest('hex')}`;
}
