import { describe, expect, it } from 'vitest';
import { assertSafeIntegrationTestTarget } from './postgres-safety';

describe('assertSafeIntegrationTestTarget', () => {
  it('allows localhost targets with a test-marked database', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://localhost:5432/mc_test')).not.toThrow();
  });

  it('allows 127.0.0.1 targets with a test-marked database', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://127.0.0.1:5432/mc_test')).not.toThrow();
  });

  it('allows hosts/databases that are clearly named for testing', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://ci-postgres:5432/mission_control_test')).not.toThrow();
    expect(() => assertSafeIntegrationTestTarget('postgres://db.internal:5432/mc_dev')).not.toThrow();
  });

  it('rejects hosts or databases that look like production', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://prod-db.internal:5432/mc_test'))
      .toThrow(/production/i);
    expect(() => assertSafeIntegrationTestTarget('postgres://localhost:5432/mission_control_production'))
      .toThrow(/production/i);
  });

  it('rejects a localhost target whose database name is not test-marked', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://localhost:5432/mission_control'))
      .toThrow(/not clearly marked for testing/i);
    expect(() => assertSafeIntegrationTestTarget('postgres://127.0.0.1:5432/mission_control'))
      .toThrow(/not clearly marked for testing/i);
  });

  it('rejects unrecognized hosts that are neither local nor clearly test-named', () => {
    expect(() => assertSafeIntegrationTestTarget('postgres://db.example.com:5432/mission_control'))
      .toThrow(/not clearly marked for testing/i);
  });

  it('rejects a non-postgres protocol even against an otherwise test-marked database', () => {
    expect(() => assertSafeIntegrationTestTarget('http://localhost:5432/mc_test'))
      .toThrow(/postgres:\/\/ or postgresql:\/\//);
    expect(() => assertSafeIntegrationTestTarget('mysql://localhost:3306/mc_test'))
      .toThrow(/postgres:\/\/ or postgresql:\/\//);
  });

  it('accepts the postgresql:// protocol alias', () => {
    expect(() => assertSafeIntegrationTestTarget('postgresql://localhost:5432/mc_test')).not.toThrow();
  });

  it('rejects an invalid connection string', () => {
    expect(() => assertSafeIntegrationTestTarget('not-a-url')).toThrow(/valid PostgreSQL connection URL/);
  });
});
