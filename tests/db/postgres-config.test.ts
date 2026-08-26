import { describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { resolvePostgresConfig } from '@/db/postgres/config';

describe('PostgreSQL configuration', () => {
  it('requires a complete PostgreSQL URL without exposing its value', () => {
    const secret = 'not-a-postgres-url-with-a-secret';

    expect(() => resolvePostgresConfig({
      MC_POSTGRES_URL: secret,
    })).toThrow('MC_POSTGRES_URL must be a valid PostgreSQL URL');

    try {
      resolvePostgresConfig({ MC_POSTGRES_URL: secret });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('uses bounded pool and timeout defaults', () => {
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL: 'postgres://mission-control:secret@db/mc',
      MC_POSTGRES_SSL_MODE: 'disable',
      MC_PROCESS_ROLE: 'worker',
    });

    expect(config.sslMode).toBe('disable');
    expect(config.pool).toMatchObject({
      min: 0,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      idle_in_transaction_session_timeout: 30_000,
      application_name: 'mission-control-worker',
      ssl: false,
    });
  });

  it('uses verified TLS by default and parses connection fields separately', () => {
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL:
        'postgres://mission-control:secret@db/mc?sslmode=require&application_name=ignored',
      MC_POSTGRES_SSL_MODE: 'verify-full',
    });

    expect(config.sslMode).toBe('verify-full');
    expect(config.pool.connectionString).toBeUndefined();
    expect(config.pool.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('prevents URL options from overriding pool policy', () => {
    const connectionUrl = [
      'postgres://user:',
      'secret',
      '@db/mc?ssl=0&application_name=ignored&statement_timeout=0',
    ].join('');
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL: connectionUrl,
      MC_POSTGRES_SSL_MODE: 'verify-full',
    });

    expect(config.pool).toMatchObject({
      host: 'db',
      user: 'user',
      password: 'secret',
      database: 'mc',
      application_name: 'mission-control-web',
      statement_timeout: 30_000,
      ssl: { rejectUnauthorized: true },
    });
    expect(config.pool.connectionString).toBeUndefined();
    const client = new Client(config.pool);
    expect(client.connectionParameters.ssl).not.toBe(false);
  });

  it('accepts sslmode from the connection URL for local integration tests', () => {
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL: 'postgres://mission-control:secret@localhost/mc?sslmode=disable',
    });

    expect(config.sslMode).toBe('disable');
    expect(config.pool.ssl).toBe(false);
  });

  it('normalizes libpq opportunistic TLS modes to encrypted connections', () => {
    const config = resolvePostgresConfig({
      MC_POSTGRES_URL: 'postgres://mission-control:secret@db/mc?sslmode=prefer',
    });

    expect(config.sslMode).toBe('require');
    expect(config.pool.ssl).toEqual({ rejectUnauthorized: false });
  });

  it('rejects invalid pool bounds and timeout values', () => {
    expect(() => resolvePostgresConfig({
      MC_POSTGRES_URL: 'postgres://mission-control:secret@db/mc',
      MC_POSTGRES_MIN_CONNECTIONS: '11',
      MC_POSTGRES_MAX_CONNECTIONS: '10',
    })).toThrow(
      'MC_POSTGRES_MIN_CONNECTIONS cannot exceed MC_POSTGRES_MAX_CONNECTIONS',
    );

    expect(() => resolvePostgresConfig({
      MC_POSTGRES_URL: 'postgres://mission-control:secret@db/mc',
      MC_POSTGRES_STATEMENT_TIMEOUT_MS: '0',
    })).toThrow('MC_POSTGRES_STATEMENT_TIMEOUT_MS must be a positive integer');
  });
});
