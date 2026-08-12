import { afterEach, describe, expect, it } from 'vitest';
import {
  isTrustedFinanceReadRequest,
  trustedFinanceMutationActor,
} from '@/lib/connectors/monarch-money/finance-request';

function request(headers: HeadersInit, url = 'http://next-internal:3099/api/finance/overview') {
  return {
    url,
    headers: new Headers(headers),
  } as Request;
}

const proxiedHeaders = {
  host: 'next-internal:3099',
  'x-forwarded-host': 'mc.example',
  'x-forwarded-proto': 'https',
  'sec-fetch-site': 'same-origin',
};

afterEach(() => {
  delete process.env.MC_API_KEY;
});

describe('Finance request authorization', () => {
  it('accepts a same-origin Referer against the external proxy origin', () => {
    expect(isTrustedFinanceReadRequest(request({
      ...proxiedHeaders,
      referer: 'https://mc.example/finance?view=review',
    }))).toBe(true);
  });

  it('accepts an explicit same-origin Origin against the external proxy origin', () => {
    expect(isTrustedFinanceReadRequest(request({
      ...proxiedHeaders,
      origin: 'https://mc.example',
    }))).toBe(true);
  });

  it('accepts the supported direct same-origin request shape', () => {
    expect(isTrustedFinanceReadRequest(request({
      host: 'localhost:3099',
      origin: 'http://localhost:3099',
      'sec-fetch-site': 'same-origin',
    }, 'http://localhost:3099/api/finance/overview'))).toBe(true);
  });

  it('uses a validated Host fallback with the first forwarded protocol', () => {
    expect(isTrustedFinanceReadRequest(request({
      host: 'mc.example',
      'x-forwarded-proto': 'https, http',
      referer: 'https://mc.example/finance',
      'sec-fetch-site': 'same-origin',
    }))).toBe(true);
  });

  it.each([
    ['cross-site Origin', { ...proxiedHeaders, origin: 'https://attacker.example' }],
    ['cross-site Referer', { ...proxiedHeaders, referer: 'https://attacker.example/finance' }],
    ['cross-site Fetch Metadata', {
      ...proxiedHeaders,
      referer: 'https://mc.example/finance',
      'sec-fetch-site': 'cross-site',
    }],
    ['missing browser source', proxiedHeaders],
    ['missing Fetch Metadata', {
      host: 'next-internal:3099',
      'x-forwarded-host': 'mc.example',
      'x-forwarded-proto': 'https',
      referer: 'https://mc.example/finance',
    }],
    ['malformed Origin', { ...proxiedHeaders, origin: 'not a URL' }],
    ['malformed Referer', { ...proxiedHeaders, referer: 'not a URL' }],
    ['Origin containing a path', { ...proxiedHeaders, origin: 'https://mc.example/finance' }],
  ])('rejects %s', (_name, headers) => {
    expect(isTrustedFinanceReadRequest(request(headers))).toBe(false);
  });

  it.each([
    ['invalid forwarded host', { ...proxiedHeaders, 'x-forwarded-host': 'mc.example/evil' }],
    ['missing forwarded protocol', {
      host: 'next-internal:3099',
      'x-forwarded-host': 'mc.example',
      'sec-fetch-site': 'same-origin',
      referer: 'https://mc.example/finance',
    }],
    ['unsupported forwarded protocol', { ...proxiedHeaders, 'x-forwarded-proto': 'ftp' }],
    ['overlong first forwarded protocol', {
      ...proxiedHeaders,
      'x-forwarded-proto': 'h'.repeat(17),
    }],
    ['empty first forwarded host', { ...proxiedHeaders, 'x-forwarded-host': ', mc.example' }],
    ['percent-encoded forwarded host', {
      ...proxiedHeaders,
      'x-forwarded-host': '%6dc.example',
    }],
    ['overlong first forwarded host', {
      ...proxiedHeaders,
      'x-forwarded-host': `${'a'.repeat(513)}.example`,
    }],
  ])('rejects %s', (_name, headers) => {
    expect(isTrustedFinanceReadRequest(request({
      ...headers,
      referer: 'https://mc.example/finance',
    }))).toBe(false);
  });

  it('uses only the bounded first forwarded values', () => {
    expect(isTrustedFinanceReadRequest(request({
      ...proxiedHeaders,
      'x-forwarded-host': 'mc.example, attacker.example',
      'x-forwarded-proto': 'https, http',
      referer: 'https://mc.example/finance',
    }))).toBe(true);
  });

  it('accepts valid explicit API-key and bearer credentials as service access', () => {
    process.env.MC_API_KEY = 'trusted-token';
    expect(isTrustedFinanceReadRequest(request({ 'x-mc-api-key': 'trusted-token' }))).toBe(true);
    expect(isTrustedFinanceReadRequest(request({
      authorization: 'Bearer trusted-token',
    }))).toBe(true);
    expect(trustedFinanceMutationActor(request({
      authorization: 'bearer trusted-token',
    }))).toBe('service');
  });

  it.each([
    ['invalid API key', { 'x-mc-api-key': 'invalid-token' }],
    ['invalid bearer', { authorization: 'Bearer invalid-token' }],
    ['empty bearer', { authorization: 'Bearer' }],
    ['unrelated edge bearer', { authorization: 'Bearer edge-identity-token' }],
    ['conflicting credentials', {
      'x-mc-api-key': 'trusted-token',
      authorization: 'Bearer invalid-token',
    }],
  ])('fails closed for an explicit %s even with same-origin browser headers', (_name, credential) => {
    process.env.MC_API_KEY = 'trusted-token';
    const browserRequest = request({
      ...proxiedHeaders,
      origin: 'https://mc.example',
      ...credential,
    });
    expect(isTrustedFinanceReadRequest(browserRequest)).toBe(false);
    expect(trustedFinanceMutationActor(browserRequest)).toBeNull();
  });

  it('fails closed for an explicit credential when no service key is configured', () => {
    const browserRequest = request({
      ...proxiedHeaders,
      origin: 'https://mc.example',
      'x-mc-api-key': 'unexpected-token',
    });
    expect(isTrustedFinanceReadRequest(browserRequest)).toBe(false);
    expect(trustedFinanceMutationActor(browserRequest)).toBeNull();
  });

  it('attributes credential-free same-origin mutations to the parent administrator', () => {
    expect(trustedFinanceMutationActor(request({
      ...proxiedHeaders,
      origin: 'https://mc.example',
    }))).toBe('parent-admin');
  });
});
