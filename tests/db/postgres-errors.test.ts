import { describe, expect, it } from 'vitest';
import { isRetryablePostgresError } from '@/db/postgres/errors';

describe('PostgreSQL startup error classification', () => {
  it.each(['40001', '40P01', '53300', '55P03', '57P03', '08006'])(
    'recognizes retryable PostgreSQL code %s',
    (code) => {
      expect(isRetryablePostgresError({ code })).toBe(true);
    },
  );

  it('recognizes wrapped retryable network errors', () => {
    expect(isRetryablePostgresError({
      cause: { cause: { code: 'ECONNREFUSED' } },
    })).toBe(true);
  });

  it('does not retry authentication or schema errors', () => {
    expect(isRetryablePostgresError({ code: '28P01' })).toBe(false);
    expect(isRetryablePostgresError({ code: '42P01' })).toBe(false);
  });
});
