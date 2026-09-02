import { describe, expect, it, vi } from 'vitest';

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});

describe('PostgreSQL planning and project automation boundary', () => {
  it('constructs both adapters without evaluating SQLite', async () => {
    const repositories = await import('@/db/postgres/repositories');
    expect(() => repositories.createPostgresPlanningSignalRepository({} as never))
      .not.toThrow();
    expect(() => repositories.createPostgresProjectAutomationRepository({} as never))
      .not.toThrow();
  });

  it('keeps both workflow gates closed', async () => {
    const { createPostgresConnectorExecutionRepositories } = await import(
      '@/db/postgres/repositories/connector-execution-repositories'
    );
    const support = createPostgresConnectorExecutionRepositories({} as never).support;
    expect(support.allowsLegacyWorkflow('planning-signals')).toBe(false);
    expect(support.allowsLegacyWorkflow('project-automation')).toBe(false);
  });
});
