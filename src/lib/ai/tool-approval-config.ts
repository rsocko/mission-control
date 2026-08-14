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
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') < MIN_APPROVAL_SECRET_BYTES
  ) {
    throw new HoustonToolApprovalConfigurationError();
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
