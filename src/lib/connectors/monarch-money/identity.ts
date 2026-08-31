import 'server-only';

import { createHash, randomBytes } from 'node:crypto';

export const FINANCE_IDENTITY_NAMESPACE_CREDENTIAL = 'identityNamespace';

const identityNamespacePattern = /^[a-f0-9]{64}$/;
const identityKindPattern = /^[a-z][a-z0-9-]{0,31}$/;

function parseCredentials(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return JSON.parse(value) as Record<string, unknown>;
  return (value as Record<string, unknown> | null) ?? {};
}

export function createFinanceIdentityNamespace(): string {
  return randomBytes(32).toString('hex');
}

export function financeIdentityNamespaceFromCredentials(
  credentials: unknown,
): string | null {
  const value = parseCredentials(credentials)[FINANCE_IDENTITY_NAMESPACE_CREDENTIAL];
  return typeof value === 'string' && identityNamespacePattern.test(value)
    ? value
    : null;
}

export function financeConnectorScopedReference(
  identityNamespace: string,
  kind: string,
  upstreamId: string,
): string {
  if (!identityNamespacePattern.test(identityNamespace)) {
    throw new Error('Finance connector identity namespace is invalid');
  }
  if (!identityKindPattern.test(kind) || !upstreamId) {
    throw new Error('Finance connector identity input is invalid');
  }
  const digest = createHash('sha256')
    .update(['finance-identity-v1', identityNamespace, kind, upstreamId].join('\n'))
    .digest('base64url');
  return `${kind}-v1:${digest}`;
}

export function validateFinanceConnectorScopedReference(
  kind: string,
  value: string | null,
): string | null {
  if (value === null) return null;
  if (
    !identityKindPattern.test(kind)
    || !new RegExp(`^${kind}-v1:[A-Za-z0-9_-]{43}$`).test(value)
  ) {
    throw new Error('Finance connector scoped reference is invalid');
  }
  return value;
}
