import 'server-only';

import { createHash } from 'node:crypto';

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export function canonicalizeFinanceInsightV1(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) {
      throw new TypeError('Canonical numbers must be finite safe integers');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizeFinanceInsightV1).join(',')}]`;
  }
  const object = value as { readonly [key: string]: CanonicalJsonValue };
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalizeFinanceInsightV1(object[key]!)}`)
    .join(',')}}`;
}

export function financeInsightDigestV1(value: CanonicalJsonValue): string {
  return `sha256:${createHash('sha256')
    .update(canonicalizeFinanceInsightV1(value))
    .digest('hex')}`;
}
