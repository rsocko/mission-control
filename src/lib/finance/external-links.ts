import 'server-only';

import {
  externalTargetSchema,
} from '@/lib/finance-insights/contract';
import {
  buildMonarchExternalTargetLink,
  resolveMonarchOrigin,
  type FinanceExternalTargetLink as MonarchExternalTargetLink,
  type FinanceTargetMappings as MonarchTargetMappings,
} from './external-targets';

const DEFAULT_TYRION_ORIGIN = 'https://tyrion.example';

const MONARCH_PATHS = {
  transactions: '/transactions',
  budgets: '/plan',
  recurring: '/recurring',
  reports: '/reports',
  accounts: '/accounts',
  investments: '/investments',
  goals: '/goals',
  forecasts: '/plan',
} as const;

function allowedHosts(): Set<string> {
  return new Set([
    'app.monarchmoney.com',
    'tyrion.example',
    ...(process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

function owlAllowedHosts(): Set<string> {
  return new Set([
    'localhost',
    '127.0.0.1',
    ...(process.env.FINANCE_OWL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

function approvedOrigin(value: string | undefined, fallback: string): URL {
  const url = new URL(value?.trim() || fallback);
  if (url.protocol !== 'https:' || url.username || url.password || !allowedHosts().has(url.hostname.toLowerCase())) {
    throw new Error('Finance external URL is not approved');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function approvedOwlOrigin(value: string | undefined): URL | null {
  if (!value?.trim()) return null;
  const url = new URL(value.trim());
  const hostname = url.hostname.toLowerCase();
  const localHttp = url.protocol === 'http:'
    && (hostname === 'localhost' || hostname === '127.0.0.1');
  if (
    (!localHttp && url.protocol !== 'https:')
    || url.username
    || url.password
    || !owlAllowedHosts().has(hostname)
  ) {
    throw new Error('OWL external URL is not approved');
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function link(origin: URL, pathname: string): string {
  return new URL(pathname, origin).toString();
}

export function resolveFinanceExternalLinks() {
  const monarch = resolveMonarchOrigin();
  const tyrion = approvedOrigin(process.env.TYRION_OPERATIONS_URL, DEFAULT_TYRION_ORIGIN);

  return {
    monarch: Object.fromEntries(
      Object.entries(MONARCH_PATHS).map(([name, pathname]) => [name, link(monarch, pathname)]),
    ) as Record<keyof typeof MONARCH_PATHS, string>,
    tyrionConfiguration: link(tyrion, '/configuration'),
  };
}

export interface FinanceTargetMappings {
  monarchTransactionIds?: MonarchTargetMappings['monarchTransactionIds'];
  owlDocumentIds?: Readonly<Record<string, string | number>>;
}

export type FinanceExternalTargetLink = MonarchExternalTargetLink | {
  system: 'owl';
  label: string;
  url: string;
};

const PAPERLESS_DOCUMENT_IDENTIFIER = /^[1-9]\d{0,18}$/;

export function buildFinanceExternalTargetLink(
  targetValue: unknown,
  mappings: FinanceTargetMappings = {},
): FinanceExternalTargetLink | null {
  const parsed = externalTargetSchema.safeParse(targetValue);
  if (!parsed.success) return null;
  const target = parsed.data;
  if (target.system === 'owl') {
    const documentId = mappings.owlDocumentIds?.[target.sourceRef];
    if (
      documentId === undefined
      || !PAPERLESS_DOCUMENT_IDENTIFIER.test(String(documentId))
    ) {
      return null;
    }
    const origin = approvedOwlOrigin(process.env.PAPERLESS_BASE_URL);
    if (!origin) return null;
    return {
      system: 'owl',
      label: 'Open document in OWL',
      url: link(origin, `/documents/${documentId}/details`),
    };
  }

  return buildMonarchExternalTargetLink(target, {
    origin: resolveMonarchOrigin(),
    mappings,
  });
}
