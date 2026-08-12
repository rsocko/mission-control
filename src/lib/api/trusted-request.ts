import 'server-only';

const MAX_FORWARDED_HOST_LENGTH = 512;
const MAX_FORWARDED_PROTOCOL_LENGTH = 16;
const MAX_SOURCE_URL_LENGTH = 4096;

type SourceHeader = 'origin' | 'referer';

export function safeEqual(value: string, expected: string) {
  const length = Math.max(value.length, expected.length);
  let difference = value.length ^ expected.length;
  for (let index = 0; index < length; index++) {
    difference |= (value.charCodeAt(index) || 0) ^ (expected.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function firstForwardedValue(
  headers: Headers,
  name: 'x-forwarded-host' | 'x-forwarded-proto',
  maxLength: number,
): { present: boolean; value: string | null } {
  const header = headers.get(name);
  if (header === null) return { present: false, value: null };
  const separator = header.indexOf(',');
  const value = (separator === -1 ? header : header.slice(0, separator)).trim();
  return {
    present: true,
    value: value && value.length <= maxLength ? value : null,
  };
}

export function getExternalRequestOrigin(request: Request): string | null {
  const forwardedHost = firstForwardedValue(
    request.headers,
    'x-forwarded-host',
    MAX_FORWARDED_HOST_LENGTH,
  );
  if (forwardedHost.present && !forwardedHost.value) return null;

  const forwardedProtocol = firstForwardedValue(
    request.headers,
    'x-forwarded-proto',
    MAX_FORWARDED_PROTOCOL_LENGTH,
  );
  if (forwardedProtocol.present && !forwardedProtocol.value) return null;
  if (forwardedHost.present && !forwardedProtocol.present) return null;

  const host = forwardedHost.value ?? request.headers.get('host')?.trim();
  if (
    !host
    || host.length > MAX_FORWARDED_HOST_LENGTH
    || /[\s,%/\\@?#]/.test(host)
  ) {
    return null;
  }

  let protocol = forwardedProtocol.value?.toLowerCase();
  if (!protocol) {
    try {
      protocol = new URL(request.url).protocol.slice(0, -1).toLowerCase();
    } catch {
      return null;
    }
  }
  if (protocol !== 'http' && protocol !== 'https') return null;

  try {
    const externalUrl = new URL(`${protocol}://${host}`);
    if (
      !externalUrl.hostname
      || externalUrl.username
      || externalUrl.password
      || externalUrl.pathname !== '/'
      || externalUrl.search
      || externalUrl.hash
    ) {
      return null;
    }
    return externalUrl.origin;
  } catch {
    return null;
  }
}

export function isSameOriginRequest(
  request: Request,
  sourceHeader: SourceHeader = 'origin',
) {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin') {
    return false;
  }

  const source = request.headers.get(sourceHeader);
  const externalOrigin = getExternalRequestOrigin(request);
  if (!source || source.length > MAX_SOURCE_URL_LENGTH || !externalOrigin) {
    return false;
  }

  try {
    const sourceUrl = new URL(source);
    if (
      (sourceUrl.protocol !== 'http:' && sourceUrl.protocol !== 'https:')
      || sourceUrl.username
      || sourceUrl.password
    ) {
      return false;
    }
    if (
      sourceHeader === 'origin'
      && (sourceUrl.pathname !== '/' || sourceUrl.search || sourceUrl.hash)
    ) {
      return false;
    }
    return sourceUrl.origin === externalOrigin;
  } catch {
    return false;
  }
}

/**
 * Protects browser-only mutation endpoints with same-origin validation while
 * retaining API-key access for trusted automation.
 */
export function isTrustedMutationRequest(request: Request) {
  const expectedApiKey = process.env.MC_API_KEY;
  const apiKeyHeader = request.headers.get('x-mc-api-key');
  if (expectedApiKey && apiKeyHeader) {
    return safeEqual(apiKeyHeader, expectedApiKey);
  }

  const authorization = request.headers.get('authorization');
  if (expectedApiKey && authorization?.startsWith('Bearer ')) {
    return safeEqual(authorization.slice('Bearer '.length).trim(), expectedApiKey);
  }

  return isSameOriginRequest(request);
}
