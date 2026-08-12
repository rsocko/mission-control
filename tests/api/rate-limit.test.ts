import { afterEach, describe, expect, it } from 'vitest';
import {
  getPublicRateLimitPolicy,
  getRateLimitClientKey,
  InMemoryRateLimiter,
} from '@/lib/api/rate-limit';
import { proxy } from '@/proxy';
import { NextRequest } from 'next/server';

describe('public API rate limiting', () => {
  afterEach(() => {
    delete process.env.MC_TRUSTED_PROXY_HOPS;
  });

  it('enforces a limit, resets after the window, and returns retry metadata', () => {
    const limiter = new InMemoryRateLimiter();
    const policy = { name: 'test', limit: 2, windowMs: 1_000 };
    expect(limiter.check('client', policy, 0).allowed).toBe(true);
    expect(limiter.check('client', policy, 1).remaining).toBe(0);
    const blocked = limiter.check('client', policy, 2);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(limiter.check('client', policy, 1_001).allowed).toBe(true);
  });

  it('bounds bucket storage and isolates route policies', () => {
    const limiter = new InMemoryRateLimiter(1);
    const policy = { name: 'one', limit: 1, windowMs: 60_000 };
    expect(limiter.check('a', policy, 0).allowed).toBe(true);
    expect(limiter.check('b', policy, 0).allowed).toBe(true);
    expect(limiter.check('a', policy, 0).allowed).toBe(true);
    expect(getPublicRateLimitPolicy('/api/triage/capture', 'POST')?.name).toBe('triage-capture');
    expect(getPublicRateLimitPolicy('/api/integrations/n8n/webhook', 'POST')?.name).toBe('n8n-webhook');
    expect(getPublicRateLimitPolicy('/api/triage/capture', 'GET')).toBeUndefined();
  });

  it('ignores spoofed forwarded addresses unless trusted proxy hops are configured', () => {
    const request = new Request('https://mc.example/api/triage/capture', {
      headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.5' },
    });
    expect(getRateLimitClientKey(request)).toBe('anonymous');
    expect(getRateLimitClientKey(request, 1)).toBe('198.51.100.10');
  });

  it('uses the client address before the configured proxy chain', () => {
    const request = new Request('https://mc.example/api/triage/capture', {
      headers: { 'x-forwarded-for': '198.51.100.10, 203.0.113.4, 203.0.113.5' },
    });
    expect(getRateLimitClientKey(request, 2)).toBe('198.51.100.10');
  });

  it('allows normal requests below the route limit', () => {
    const limiter = new InMemoryRateLimiter();
    const policy = getPublicRateLimitPolicy('/api/work-todo/ingest', 'POST')!;
    expect(limiter.check('client', policy, Date.now()).allowed).toBe(true);
  });

  it('returns a standards-compliant 429 response when a public route is exhausted', async () => {
    const client = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
    process.env.MC_TRUSTED_PROXY_HOPS = '1';
    const request = () => new NextRequest('https://mc.example/api/triage/capture', {
      method: 'POST',
      headers: { 'x-forwarded-for': `${client}, 203.0.113.5` },
    });

    for (let index = 0; index < 30; index += 1) {
      expect(proxy(request()).status).toBe(200);
    }

    const response = proxy(request());
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBeTruthy();
    expect(response.headers.get('RateLimit-Limit')).toBe('30');
    expect(response.headers.get('RateLimit-Remaining')).toBe('0');
  });
});
