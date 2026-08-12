import { afterEach, describe, expect, it } from 'vitest';
import { isTrustedMutationRequest } from '@/lib/api/trusted-request';

afterEach(() => {
  delete process.env.MC_API_KEY;
});

describe('trusted mutation requests', () => {
  it('accepts same-origin browser requests', () => {
    const request = {
      url: 'https://mc.example/api/tasks/1/breakdown',
      headers: new Headers({
        host: 'mc.example',
        origin: 'https://mc.example',
        'sec-fetch-site': 'same-origin',
      }),
    } as Request;

    expect(isTrustedMutationRequest(request)).toBe(true);
  });

  it('rejects cross-origin browser requests', () => {
    const request = {
      url: 'https://mc.example/api/tasks/1/breakdown',
      headers: new Headers({
        host: 'mc.example',
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
      }),
    } as Request;

    expect(isTrustedMutationRequest(request)).toBe(false);
  });

  it('accepts a configured API bearer token', () => {
    process.env.MC_API_KEY = 'trusted-token';
    const request = {
      url: 'https://mc.example/api/tasks/1/breakdown',
      headers: new Headers({ authorization: 'Bearer trusted-token' }),
    } as Request;

    expect(isTrustedMutationRequest(request)).toBe(true);
  });

  it('accepts the established X-MC-API-Key header', () => {
    process.env.MC_API_KEY = 'trusted-token';
    const request = {
      url: 'https://mc.example/api/tasks/1/breakdown',
      headers: new Headers({ 'x-mc-api-key': 'trusted-token' }),
    } as Request;

    expect(isTrustedMutationRequest(request)).toBe(true);
  });
});
