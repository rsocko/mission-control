import { describe, expect, it } from 'vitest';
import type {
  SynchronousTransactionRunner,
  TransactionRunner,
} from '@/db/persistence/contracts';

/**
 * These two contracts are deliberately **not** merged into one generic
 * "transaction runner" contract. `SynchronousTransactionRunner<TContext>` and
 * `TransactionRunner<TContext>` are different capabilities:
 *
 * - `SynchronousTransactionRunner<TContext>` is the portable seam every
 *   backend implements (`PersistenceBackend.transactions`). Its `work`
 *   callback is typed to return `SynchronousTransactionResult<TResult>`,
 *   which rejects a *statically known* async function at compile time. It
 *   promises only that synchronous-shaped work commits or rolls back
 *   atomically - nothing about genuine cross-await atomicity.
 * - `TransactionRunner<TContext>` (`PersistenceBackend.asyncTransactions`,
 *   currently PostgreSQL-only) promises that work may genuinely `await`
 *   inside an open transaction and still commit or roll back atomically.
 *   `better-sqlite3` cannot honor this: its `.transaction()` wrapper begins
 *   and commits within a single synchronous call, so there is no seam that
 *   could hold a SQLite transaction open across a real `await` without
 *   silently breaking atomicity. Giving SQLite a class that *implements*
 *   `TransactionRunner<TContext>` would let generically-typed callers
 *   compile fine while failing at runtime for any real async work - exactly
 *   the misleading seam this module must not provide.
 *
 * Reusing one shared harness/contract per capability lets both backends
 * prove the capability they actually have, honestly typed.
 */

export interface SynchronousTransactionRunnerContractHarness<TContext> {
  runner: SynchronousTransactionRunner<TContext>;
  /** Write `value` for `key` using the backend's transaction context. */
  write(context: TContext, key: string, value: string): void;
  /** Read the currently committed value for `key`, outside any transaction. */
  read(key: string): Promise<string | undefined>;
  /** Clear every key this contract will use before each test. */
  reset(): Promise<void>;
}

/**
 * Shared commit / rollback / no-partial-effect contract for
 * `SynchronousTransactionRunner<TContext>`, provable identically for every
 * backend regardless of whether that backend can *also* support genuine
 * async work.
 */
export function describeSynchronousTransactionRunnerContract<TContext>(
  name: string,
  createHarness: () => Promise<SynchronousTransactionRunnerContractHarness<TContext>>,
): void {
  describe(`${name} synchronous transaction runner contract`, () => {
    it('commits every effect of synchronous work and resolves with its result', async () => {
      const harness = await createHarness();
      await harness.reset();

      const result = await harness.runner.run((context) => {
        harness.write(context, 'commit-a', '1');
        harness.write(context, 'commit-b', '2');
        return 'ok';
      });

      expect(result).toBe('ok');
      await expect(harness.read('commit-a')).resolves.toBe('1');
      await expect(harness.read('commit-b')).resolves.toBe('2');
    });

    it('rolls back with no partial effect when work throws', async () => {
      const harness = await createHarness();
      await harness.reset();
      const failure = new Error('contract-forced-rollback');

      await expect(harness.runner.run((context) => {
        harness.write(context, 'rollback-a', '1');
        harness.write(context, 'rollback-b', '2');
        throw failure;
      })).rejects.toBe(failure);

      await expect(harness.read('rollback-a')).resolves.toBeUndefined();
      await expect(harness.read('rollback-b')).resolves.toBeUndefined();
    });
  });
}

/**
 * Proves that a backend's `SynchronousTransactionRunner` refuses to let a
 * genuinely-async `work` callback commit any effect. `work` here is declared
 * with a `void`-returning type (not `Promise<void>`) purely to get past the
 * runner's compile-time guard - the same escape hatch a caller would need to
 * *deliberately* use to smuggle real async work past the type system - so
 * this test exercises the runtime `isPromiseLike` guard that is the actual
 * enforcement mechanism. Only apply this to backends whose runner is
 * documented to reject async work (currently SQLite); a backend that
 * genuinely supports async transactions has no reason to reject it here.
 */
export function describeSynchronousRunnerRejectsAsyncWork<TContext>(
  name: string,
  createHarness: () => Promise<SynchronousTransactionRunnerContractHarness<TContext>>,
): void {
  describe(`${name} rejects asynchronous work before any effect commits`, () => {
    it('throws before committing when work yields instead of returning synchronously', async () => {
      const harness = await createHarness();
      await harness.reset();

      const asyncWork: (context: TContext) => void = async (context) => {
        harness.write(context, 'async-rejected', '1');
        await Promise.resolve();
      };

      await expect(harness.runner.run(asyncWork)).rejects.toThrow();
      await expect(harness.read('async-rejected')).resolves.toBeUndefined();
    });
  });
}

export interface AsyncTransactionRunnerContractHarness<TContext> {
  runner: TransactionRunner<TContext>;
  /** Write `value` for `key` using the backend's transaction context. */
  write(context: TContext, key: string, value: string): Promise<void>;
  /** Read the currently committed value for `key`, outside any transaction. */
  read(key: string): Promise<string | undefined>;
  /** Clear every key this contract will use before each test. */
  reset(): Promise<void>;
}

/**
 * Commit / rollback / no-partial-effect contract for a backend that
 * genuinely supports async work inside an open transaction (i.e. it
 * implements `TransactionRunner<TContext>`, not merely
 * `SynchronousTransactionRunner<TContext>`). Currently only PostgreSQL
 * qualifies; this contract is written generically so a future genuinely-async
 * backend can reuse it without duplicating the assertions.
 */
export function describeAsyncTransactionRunnerContract<TContext>(
  name: string,
  createHarness: () => Promise<AsyncTransactionRunnerContractHarness<TContext>>,
): void {
  describe(`${name} async transaction runner contract`, () => {
    it('commits genuinely async work atomically, holding the transaction open across an await', async () => {
      const harness = await createHarness();
      await harness.reset();

      const result = await harness.runner.run(async (context) => {
        await harness.write(context, 'async-commit-a', '1');
        await Promise.resolve();
        await harness.write(context, 'async-commit-b', '2');
        return 'ok';
      });

      expect(result).toBe('ok');
      await expect(harness.read('async-commit-a')).resolves.toBe('1');
      await expect(harness.read('async-commit-b')).resolves.toBe('2');
    });

    it('rolls back with no partial effect when awaited work throws', async () => {
      const harness = await createHarness();
      await harness.reset();
      const failure = new Error('contract-forced-async-rollback');

      await expect(harness.runner.run(async (context) => {
        await harness.write(context, 'async-rollback-a', '1');
        await Promise.resolve();
        throw failure;
      })).rejects.toBe(failure);

      await expect(harness.read('async-rollback-a')).resolves.toBeUndefined();
    });
  });
}
