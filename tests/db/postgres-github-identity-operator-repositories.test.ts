import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresGitHubIdentityOperatorRepositories } from '@/db/postgres/repositories/github-identity-operator-repositories';
import { UnsupportedGitHubWorkerOperationError } from '@/db/persistence/github-worker-errors';
import type { GitHubIdentityOperatorPersistence } from '@/db/persistence/github-identity-operator';

/**
 * Proves the PostgreSQL adapter for the five pre-existing, previously audited
 * GitHub worker operator/recovery surfaces (identity backfill/status, manual
 * terminal-inaccessible exception mutation, unknown write-outcome resolution,
 * interrupted write-cycle recovery — exposed as the 11-method
 * `GitHubIdentityOperatorPersistence` port) is **not** a genuine async
 * implementation: every member returns a Promise rejected with the exact,
 * pre-existing `UnsupportedGitHubWorkerOperationError` contract, before any
 * SQLite import/evaluation, transaction acquisition, remote network effect,
 * or durable mutation is attempted.
 *
 * This intentionally does not exercise the SQLite adapter
 * (`sqlite-github-identity-operator-repositories.ts`), which genuinely
 * implements these five surfaces and is covered by its own existing tests.
 * Cross-backend behavioral parity is not claimed here.
 */

type MethodName = keyof GitHubIdentityOperatorPersistence;

// Every method's real implementation ignores its arguments entirely before
// throwing, so these are placeholders that merely satisfy call arity, not
// realistic domain fixtures.
const METHOD_CALLS: Record<MethodName, [name: MethodName, reason: string, args: unknown[]]> = {
  getIdentityStatus: [
    'getIdentityStatus',
    'GitHub identity operational status reporting',
    ['connector-1', {}],
  ],
  recordIdentityException: [
    'recordIdentityException',
    'manual GitHub terminal-inaccessible exception mutation',
    [{}],
  ],
  reconcileInterruptedWriteCycle: [
    'reconcileInterruptedWriteCycle',
    'interrupted GitHub write-cycle reconciliation',
    [{}],
  ],
  inspectWriteOutcomes: [
    'inspectWriteOutcomes',
    'GitHub write-outcome inspection',
    [{ connectorInstanceId: 'connector-1' }],
  ],
  resolveWriteOutcome: [
    'resolveWriteOutcome',
    'GitHub write-outcome resolution',
    [{}, async () => ({ ok: false as const })],
  ],
  getBackfillPhase: [
    'getBackfillPhase',
    'GitHub identity backfill phase lookup',
    ['connector-1'],
  ],
  updateBackfillPhase: [
    'updateBackfillPhase',
    'GitHub identity backfill phase transition',
    [{ connectorInstanceId: 'connector-1', phase: 'discovering', now: new Date().toISOString() }],
  ],
  previewIdentityBatch: [
    'previewIdentityBatch',
    'GitHub identity backfill batch preview',
    [[]],
  ],
  getBackfillStatus: [
    'getBackfillStatus',
    'GitHub identity backfill status lookup',
    ['connector-1'],
  ],
  preflightBackfill: [
    'preflightBackfill',
    'GitHub identity backfill preflight',
    ['connector-1'],
  ],
  runBackfill: [
    'runBackfill',
    'GitHub identity backfill execution',
    [{ connectorInstanceId: 'connector-1' }],
  ],
};

const ALL_METHODS = Object.keys(METHOD_CALLS) as MethodName[];

describe('createPostgresGitHubIdentityOperatorRepositories', () => {
  it('declares exactly the 11 audited operator/recovery methods, no more, no fewer', () => {
    const operator = createPostgresGitHubIdentityOperatorRepositories();
    expect(Object.keys(operator).sort()).toEqual([...ALL_METHODS].sort());
    expect(ALL_METHODS).toHaveLength(11);
  });

  describe.each(ALL_METHODS)('%s', (methodName) => {
    const [, reason, args] = METHOD_CALLS[methodName];

    it('returns a rejected Promise (never a synchronous throw) with the exact established error contract', async () => {
      const operator = createPostgresGitHubIdentityOperatorRepositories();
      const method = operator[methodName] as (...callArgs: unknown[]) => Promise<unknown>;

      // Direct invocation must not throw synchronously: the method is
      // `async`, so even a same-tick `throw` inside its body is delivered as
      // a rejected Promise, never a thrown exception at the call site.
      let result!: Promise<unknown>;
      expect(() => {
        result = method(...args);
      }).not.toThrow();
      expect(result).toBeInstanceOf(Promise);

      await expect(result).rejects.toBeInstanceOf(UnsupportedGitHubWorkerOperationError);
      await expect(result).rejects.toMatchObject({
        name: 'UnsupportedGitHubWorkerOperationError',
        code: 'unsupported-github-worker-operation',
        reason,
        message: `PostgreSQL GitHub worker persistence does not support ${reason}`,
      });
    });

    it('also rejects when awaited directly (not just via .catch/rejects)', async () => {
      const operator = createPostgresGitHubIdentityOperatorRepositories();
      const method = operator[methodName] as (...callArgs: unknown[]) => Promise<unknown>;

      let caught: unknown;
      try {
        await method(...args);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(UnsupportedGitHubWorkerOperationError);
      expect((caught as UnsupportedGitHubWorkerOperationError).code).toBe('unsupported-github-worker-operation');
    });
  });

  it('never statically imports better-sqlite3, @/db, or any @/lib/external-identities module', () => {
    // Structural proof, independent of any mocking: this adapter file has no
    // way to reach SQLite or the library's genuine implementations at all,
    // because it does not import them. This is stronger than a runtime spy,
    // which could in principle miss a code path; there is no such path here.
    const source = readFileSync(
      join(process.cwd(), 'src/db/postgres/repositories/github-identity-operator-repositories.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from\s+['"]better-sqlite3['"]/);
    expect(source).not.toMatch(/from\s+['"]@\/db(?!\/persistence\/github-(identity-operator|worker-errors))/);
    expect(source).not.toMatch(/from\s+['"]@\/lib\/external-identities/);
  });

  describe('zero-effect proof under mocked driver and network seams', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.doUnmock('better-sqlite3');
      globalThis.fetch = originalFetch;
    });

    it('never constructs better-sqlite3 or calls fetch across all 11 methods', async () => {
      const betterSqlite3ConstructorCalls = vi.fn();
      vi.doMock('better-sqlite3', () => ({
        default: class {
          constructor(...ctorArgs: unknown[]) {
            betterSqlite3ConstructorCalls(...ctorArgs);
          }
        },
      }));
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const { createPostgresGitHubIdentityOperatorRepositories: freshFactory } = await import(
        '@/db/postgres/repositories/github-identity-operator-repositories'
      );
      // vi.resetModules() gives the re-imported adapter module its own fresh
      // copy of every module it transitively imports, including the error
      // class module. Re-import it here too so the `instanceof` check below
      // compares against the exact constructor the fresh adapter throws,
      // rather than the one captured by this file's top-level static import
      // (which resolves to a different registry entry after the reset).
      const { UnsupportedGitHubWorkerOperationError: FreshUnsupportedGitHubWorkerOperationError } =
        await import('@/db/persistence/github-worker-errors');
      const operator = freshFactory();

      for (const methodName of ALL_METHODS) {
        const [, , args] = METHOD_CALLS[methodName];
        const method = operator[methodName] as (...callArgs: unknown[]) => Promise<unknown>;
        await expect(method(...args)).rejects.toBeInstanceOf(FreshUnsupportedGitHubWorkerOperationError);
      }

      expect(betterSqlite3ConstructorCalls).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });
});
