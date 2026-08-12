type MonarchExternalTarget =
  | { system: 'monarch'; targetKind: 'transaction' | 'recurring'; sourceRef: string }
  | {
    system: 'monarch';
    targetKind: 'reportFilter';
    reportKind: 'spending';
    period: { start: string; end: string };
    categorySourceRef: string | null;
    merchantKey: string | null;
  }
  | { system: 'monarch'; targetKind: 'safeRoot'; root: keyof typeof MONARCH_PATHS };

export const DEFAULT_MONARCH_ORIGIN = 'https://app.monarchmoney.com';

const MONARCH_PATHS = {
  transactions: '/transactions',
  recurring: '/recurring',
  reports: '/reports',
} as const;

export interface FinanceTargetMappings {
  monarchTransactionIds?: Readonly<Record<string, string>>;
}

export interface FinanceExternalTargetLink {
  system: 'monarch';
  label: string;
  url: string;
}

const SOURCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const MERCHANT_KEY = /^merchant-v1_[A-Za-z0-9_-]{43}$/;
const MONARCH_ROOTS = new Set<keyof typeof MONARCH_PATHS>([
  'transactions',
  'recurring',
  'reports',
]);

function hasExactlyKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isSourceReference(value: unknown): value is string {
  return typeof value === 'string'
    && SOURCE_IDENTIFIER.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseMonarchTarget(value: unknown): MonarchExternalTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (target.system !== 'monarch') return null;

  if (target.targetKind === 'safeRoot') {
    return hasExactlyKeys(target, ['system', 'targetKind', 'root'])
      && typeof target.root === 'string'
      && MONARCH_ROOTS.has(target.root as keyof typeof MONARCH_PATHS)
      ? target as MonarchExternalTarget
      : null;
  }
  if (target.targetKind === 'transaction' || target.targetKind === 'recurring') {
    return hasExactlyKeys(target, ['system', 'targetKind', 'sourceRef'])
      && isSourceReference(target.sourceRef)
      ? target as MonarchExternalTarget
      : null;
  }
  if (target.targetKind !== 'reportFilter') return null;
  if (!hasExactlyKeys(target, [
    'system',
    'targetKind',
    'reportKind',
    'period',
    'categorySourceRef',
    'merchantKey',
  ])) return null;
  if (!target.period || typeof target.period !== 'object' || Array.isArray(target.period)) return null;

  const period = target.period as Record<string, unknown>;
  const categorySourceRef = target.categorySourceRef;
  const merchantKey = target.merchantKey;
  const valid = target.reportKind === 'spending'
    && hasExactlyKeys(period, ['start', 'end'])
    && isCalendarDate(period.start)
    && isCalendarDate(period.end)
    && period.end >= period.start
    && (categorySourceRef === null || isSourceReference(categorySourceRef))
    && (merchantKey === null || (typeof merchantKey === 'string' && MERCHANT_KEY.test(merchantKey)))
    && (categorySourceRef === null || merchantKey === null);
  return valid ? target as MonarchExternalTarget : null;
}

function link(origin: URL, pathname: string): string {
  return new URL(pathname, origin).toString();
}

export function resolveMonarchOrigin(
  value = process.env.MONARCH_WEB_URL,
): URL {
  const origin = new URL(value?.trim() || DEFAULT_MONARCH_ORIGIN);
  const allowedHosts = new Set([
    'app.monarchmoney.com',
    ...(process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
  if (
    origin.protocol !== 'https:'
    || origin.username
    || origin.password
    || !allowedHosts.has(origin.hostname.toLowerCase())
  ) {
    throw new Error('Finance external URL is not approved');
  }
  origin.pathname = '/';
  origin.search = '';
  origin.hash = '';
  return origin;
}

export function buildMonarchExternalTargetLink(
  targetValue: unknown,
  options: {
    origin?: URL;
    mappings?: FinanceTargetMappings;
  } = {},
): FinanceExternalTargetLink | null {
  const target = parseMonarchTarget(targetValue);
  if (!target) return null;
  const origin = options.origin ?? resolveMonarchOrigin();
  const mappings = options.mappings ?? {};

  if (target.targetKind === 'safeRoot') {
    return {
      system: 'monarch',
      label: `Open Monarch ${target.root}`,
      url: link(origin, MONARCH_PATHS[target.root]),
    };
  }
  if (target.targetKind === 'transaction') {
    const transactionId = mappings.monarchTransactionIds?.[target.sourceRef];
    if (transactionId && SOURCE_IDENTIFIER.test(transactionId)) {
      const url = new URL(MONARCH_PATHS.transactions, origin);
      url.searchParams.set('transactionId', transactionId);
      return { system: 'monarch', label: 'Open transaction in Monarch', url: url.toString() };
    }
    return {
      system: 'monarch',
      label: 'Open Monarch transactions',
      url: link(origin, MONARCH_PATHS.transactions),
    };
  }
  if (target.targetKind === 'recurring') {
    return {
      system: 'monarch',
      label: 'Open Monarch recurring',
      url: link(origin, MONARCH_PATHS.recurring),
    };
  }
  return {
    system: 'monarch',
    label: 'Open Monarch reports',
    url: link(origin, MONARCH_PATHS.reports),
  };
}
