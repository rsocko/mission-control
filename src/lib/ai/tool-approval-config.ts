import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const MIN_APPROVAL_SECRET_BYTES = 32;

export class HoustonToolApprovalConfigurationError extends Error {
  constructor() {
    super('Houston finance approvals are unavailable because the server approval secret is not configured correctly.');
    this.name = 'HoustonToolApprovalConfigurationError';
  }
}

export function getHoustonToolApprovalSecret(
  value = process.env.MC_HOUSTON_TOOL_APPROVAL_SECRET,
): string {
  const secret = getOptionalHoustonToolApprovalSecret(value);
  if (secret === undefined) {
    throw new HoustonToolApprovalConfigurationError();
  }
  return secret;
}

/**
 * Same validation as {@link getHoustonToolApprovalSecret}, but returns
 * `undefined` instead of throwing when the secret is missing or too short.
 * Use this anywhere Houston chat must keep working for non-finance requests
 * even when finance approvals are not configured; only the finance mutation
 * tools themselves should require the secret.
 */
export function getOptionalHoustonToolApprovalSecret(
  value = process.env.MC_HOUSTON_TOOL_APPROVAL_SECRET,
): string | undefined {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') < MIN_APPROVAL_SECRET_BYTES
  ) {
    return undefined;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function verifyHoustonToolApprovalSignature(input: {
  secret: string;
  signature: string;
  approvalId: string;
  toolCallId: string;
  toolName: string;
  toolInput: unknown;
}): boolean {
  const inputDigest = createHash('sha256')
    .update(canonicalJson(input.toolInput))
    .digest('base64url');
  const expected = createHmac('sha256', input.secret)
    .update([
      input.approvalId,
      input.toolCallId,
      input.toolName,
      inputDigest,
    ].join('\n'))
    .digest();
  const actual = Buffer.from(input.signature, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
