import 'server-only';

import {
  DEFAULT_TYRION_PRODUCTION_BRIDGE_URL,
  defaultTyrionBridgeUrlForEnvironment,
} from './constants';

export {
  DEFAULT_TYRION_BRIDGE_URL,
  DEFAULT_TYRION_PRODUCTION_BRIDGE_URL,
} from './constants';
const MAX_BRIDGE_URL_LENGTH = 2048;
const DEFAULT_OPERATIONS_HOST = 'tyrion.example';
const INTERNAL_OPERATIONS_HOST = 'tyrion-operations-ui';
const PUBLIC_GATEWAY_PATH = '/api/connector/v1';

export class TyrionBridgeUrlValidationError extends Error {
  readonly code = 'invalid_bridge_url';

  constructor(message: string) {
    super(message);
    this.name = 'TyrionBridgeUrlValidationError';
  }
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number);
  if (
    octets.length !== 4
    || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false;
  }
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  const isIpv6 = normalized.includes(':');
  return normalized === 'localhost'
    || normalized === '::1'
    || (isIpv6 && (
      normalized.startsWith('fc')
      || normalized.startsWith('fd')
    ))
    || normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || (!normalized.includes('.') && !normalized.includes(':'))
    || isPrivateIpv4(normalized);
}

function isForbiddenLinkLocalHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  const octets = normalized.split('.').map(Number);
  const mappedIpv4 = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  const mappedHigh = mappedIpv4 ? Number.parseInt(mappedIpv4[1], 16) : -1;
  return (octets.length === 4 && octets[0] === 169 && octets[1] === 254)
    || ((mappedHigh >> 8) === 169 && (mappedHigh & 0xff) === 254)
    || /^fe[89ab][0-9a-f]:/i.test(normalized);
}

function rawPathname(input: string): string {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i.exec(input);
  return match?.[1] ?? '/';
}

function assertSafeBasePath(input: string): void {
  const rawPath = rawPathname(input);
  if (rawPath.includes('\\') || /%(?:2f|5c|25)/i.test(rawPath)) {
    throw new TyrionBridgeUrlValidationError(
      'Tyrion Bridge API URL path must not contain encoded separators, nested encoding, or traversal',
    );
  }
  let decodedPath = rawPath;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const decoded = decodeURIComponent(decodedPath);
      if (decoded === decodedPath) break;
      decodedPath = decoded;
    } catch {
      throw new TyrionBridgeUrlValidationError('Tyrion Bridge API URL path is invalid');
    }
  }
  if (
    decodedPath.includes('\\')
    || decodedPath.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    throw new TyrionBridgeUrlValidationError(
      'Tyrion Bridge API URL path must not contain encoded separators, nested encoding, or traversal',
    );
  }
}

function normalizedBasePath(pathname: string): string {
  return pathname === '/' ? '' : pathname.replace(/\/+$/, '');
}

export function normalizeTyrionBridgeUrl(
  value: unknown,
): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TyrionBridgeUrlValidationError('Tyrion Bridge API URL is required');
  }
  const input = value.trim();
  if (input.length > MAX_BRIDGE_URL_LENGTH) {
    throw new TyrionBridgeUrlValidationError('Tyrion Bridge API URL is too long');
  }

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TyrionBridgeUrlValidationError('Tyrion Bridge API URL is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new TyrionBridgeUrlValidationError('Tyrion Bridge API URL must use HTTP or HTTPS');
  }
  if (
    url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new TyrionBridgeUrlValidationError(
      'Tyrion Bridge API URL must not contain credentials, a query, or a fragment',
    );
  }
  assertSafeBasePath(input);

  const hostname = normalizedHostname(url.hostname);
  const basePath = normalizedBasePath(url.pathname);
  if (
    hostname === INTERNAL_OPERATIONS_HOST
    || hostname.startsWith(`${INTERNAL_OPERATIONS_HOST}.`)
    || hostname.startsWith(`${INTERNAL_OPERATIONS_HOST}-`)
  ) {
    throw new TyrionBridgeUrlValidationError(
      'The Tyrion operations UI is not the Tyrion Bridge API',
    );
  }
  if (hostname === DEFAULT_OPERATIONS_HOST && basePath !== PUBLIC_GATEWAY_PATH) {
    throw new TyrionBridgeUrlValidationError(
      `Use ${DEFAULT_TYRION_PRODUCTION_BRIDGE_URL} for the protected Tyrion Bridge API`,
    );
  }
  if (isForbiddenLinkLocalHostname(hostname)) {
    throw new TyrionBridgeUrlValidationError(
      'Tyrion Bridge API URL must not target a link-local address',
    );
  }
  if (url.protocol === 'http:' && !isPrivateHostname(hostname)) {
    throw new TyrionBridgeUrlValidationError(
      'Public Tyrion Bridge API URLs must use HTTPS',
    );
  }
  if (url.hostname !== hostname && !hostname.includes(':')) url.hostname = hostname;
  return `${url.origin}${basePath}`;
}

export function getTyrionBridgeUrl(
  settings?: Record<string, unknown> | null,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = settings?.bridgeUrl;
  return normalizeTyrionBridgeUrl(
    typeof configured === 'string' && configured.trim()
      ? configured
      : defaultTyrionBridgeUrlForEnvironment(environment.NODE_ENV),
  );
}
