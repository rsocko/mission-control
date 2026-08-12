export type RateLimitPolicy = {
  name: string;
  limit: number;
  windowMs: number;
};

type Bucket = {
  count: number;
  resetAt: number;
  touchedAt: number;
};

export type RateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
};

const MAX_BUCKETS = 10_000;

export class InMemoryRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly maxBuckets = MAX_BUCKETS) {}

  check(key: string, policy: RateLimitPolicy, now = Date.now()): RateLimitResult {
    const bucketKey = `${policy.name}:${key}`;
    let bucket = this.buckets.get(bucketKey);

    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + policy.windowMs, touchedAt: now };
      this.buckets.set(bucketKey, bucket);
    }

    bucket.count += 1;
    bucket.touchedAt = now;
    this.evictIfNeeded(now);

    const allowed = bucket.count <= policy.limit;
    return {
      allowed,
      limit: policy.limit,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: bucket.resetAt,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  clear() {
    this.buckets.clear();
  }

  private evictIfNeeded(now: number) {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }

    while (this.buckets.size > this.maxBuckets) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

export const publicRateLimitPolicies: readonly RateLimitPolicy[] = [
  { name: 'triage-capture', limit: 30, windowMs: 60_000 },
  { name: 'triage-image-capture', limit: 20, windowMs: 60_000 },
  { name: 'inbound-webhook', limit: 60, windowMs: 60_000 },
  { name: 'connector-webhook', limit: 120, windowMs: 60_000 },
  { name: 'n8n-webhook', limit: 60, windowMs: 60_000 },
  { name: 'rymessage-webhook', limit: 60, windowMs: 60_000 },
  { name: 'scout-ingest', limit: 60, windowMs: 60_000 },
  { name: 'work-todo-ingest', limit: 60, windowMs: 60_000 },
];

export function getPublicRateLimitPolicy(pathname: string, method: string) {
  if (method !== 'POST' && method !== 'GET') return undefined;
  if (pathname === '/api/triage/capture' && method === 'POST') return publicRateLimitPolicies[0];
  if (pathname === '/api/triage/capture/image' && method === 'POST') return publicRateLimitPolicies[1];
  if (/^\/api\/inbound-webhooks\/[^/]+\/receive$/.test(pathname) && method === 'POST') {
    return publicRateLimitPolicies[2];
  }
  if (/^\/api\/webhooks\/[^/]+$/.test(pathname)) return publicRateLimitPolicies[3];
  if (pathname === '/api/integrations/n8n/webhook' && method === 'POST') return publicRateLimitPolicies[4];
  if (pathname === '/api/integrations/rymessage' && (method === 'POST' || method === 'GET')) {
    return publicRateLimitPolicies[5];
  }
  if (pathname === '/api/scout/ingest' && method === 'POST') return publicRateLimitPolicies[6];
  if (pathname === '/api/work-todo/ingest' && method === 'POST') return publicRateLimitPolicies[7];
  return undefined;
}

function validClientAddress(value: string | null) {
  return value?.trim().replace(/[^a-zA-Z0-9:.%_-]/g, '') || null;
}

export function getRateLimitClientKey(
  request: Request,
  trustedProxyHops = Number.parseInt(process.env.MC_TRUSTED_PROXY_HOPS ?? '0', 10),
) {
  const hops = Number.isInteger(trustedProxyHops) ? Math.min(10, Math.max(0, trustedProxyHops)) : 0;
  if (hops === 0) return 'anonymous';

  const forwarded = request.headers.get('x-forwarded-for')
    ?.split(',')
    .map((value) => validClientAddress(value))
    .filter((value): value is string => Boolean(value));
  if (forwarded && forwarded.length > hops) {
    return forwarded[forwarded.length - hops - 1]!;
  }

  return validClientAddress(request.headers.get('x-real-ip')) ?? 'anonymous';
}

export function rateLimitHeaders(result: RateLimitResult) {
  return {
    'RateLimit-Limit': String(result.limit),
    'RateLimit-Remaining': String(result.remaining),
    'RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
  };
}
