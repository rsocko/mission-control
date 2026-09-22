const RETRYABLE_POSTGRES_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '55P03', // lock_not_available
  '57P03', // cannot_connect_now
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
]);

interface ErrorLike {
  code?: string;
  cause?: unknown;
}

export function isRetryablePostgresError(error: unknown): boolean {
  let current = error;
  const visited = new Set<unknown>();

  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const candidate = current as ErrorLike;
    if (
      typeof candidate.code === 'string'
      && (
        RETRYABLE_POSTGRES_CODES.has(candidate.code)
        || RETRYABLE_NETWORK_CODES.has(candidate.code)
      )
    ) {
      return true;
    }
    current = candidate.cause;
  }

  return false;
}
