import { describe, expect, it, vi } from 'vitest';

const repositoryCalls = vi.hoisted(() => ({
  finalizeIfDue: vi.fn(),
  evaluateAll: vi.fn(),
  evaluateProject: vi.fn(),
}));

vi.mock('@/db', () => {
  throw new Error('SQLite database module must not be evaluated');
});

vi.mock('@/lib/persistence/worker-runtime', () => ({
  getWorkerPersistenceRepositories: async () => ({
    execution: {
      support: {
        allowsLegacyWorkflow: () => false,
      },
    },
    planningSignals: {
      finalizeIfDue: repositoryCalls.finalizeIfDue,
    },
    projectAutomation: {
      evaluateAll: repositoryCalls.evaluateAll,
      evaluateProject: repositoryCalls.evaluateProject,
    },
  }),
}));

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

  it('acquires the project lock before opening the serializable snapshot', async () => {
    const statements: string[] = [];
    const client = {
      async query(text: string) {
        statements.push(text);
        return { rows: [] };
      },
      release: vi.fn(),
    };
    const { createPostgresProjectAutomationRepository } = await import(
      '@/db/postgres/repositories/project-automation-repository'
    );
    const repository = createPostgresProjectAutomationRepository({
      connect: async () => client,
    } as never);

    await expect(repository.evaluateProject('project-1')).resolves.toEqual({
      added: 0,
      matched: 0,
      matches: [],
    });
    const lockIndex = statements.findIndex((statement) =>
      statement.includes('pg_advisory_lock')
    );
    const beginIndex = statements.findIndex((statement) =>
      statement.includes('BEGIN ISOLATION LEVEL SERIALIZABLE')
    );
    expect(lockIndex).toBeGreaterThanOrEqual(0);
    expect(beginIndex).toBeGreaterThan(lockIndex);
    expect(statements.some((statement) => statement.includes('pg_advisory_xact_lock')))
      .toBe(false);
  });

  it('prevents shared services from bypassing the closed gates', async () => {
    const planning = await import('@/lib/planning-signals');
    const rules = await import('@/lib/rules');

    await expect(planning.finalizePlanningSignalsIfDue(
      '2026-08-20',
      new Date('2026-08-20T12:00:00.000Z'),
    )).resolves.toBeNull();
    await expect(rules.evaluateAllProjectRules()).resolves.toEqual([]);
    await expect(rules.reevaluateProject('project-1')).resolves.toEqual({
      added: 0,
      matched: 0,
      matches: [],
    });
    expect(repositoryCalls.finalizeIfDue).not.toHaveBeenCalled();
    expect(repositoryCalls.evaluateAll).not.toHaveBeenCalled();
    expect(repositoryCalls.evaluateProject).not.toHaveBeenCalled();
  });
});
