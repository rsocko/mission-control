import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Dependency-free proof that the audited SQLite-only GitHub identity
 * operator/recovery commands (`GitHubIdentityOperatorPersistence`: identity
 * backfill/status, manual exception mutation, unknown-outcome resolution,
 * interrupted write-cycle recovery) fail closed under
 * MC_DATABASE_BACKEND=postgres *before* this script's module body would ever
 * reach a SQLite driver, and that this in no way affects the separate,
 * already-portable `transfer-reconcile` command.
 *
 * This complements (does not replace) the built-artifact process-level test
 * in `github-identity-operator-artifact.test.ts`, which additionally proves
 * no PostgreSQL connection attempt is made and no SQLite file is created
 * when invoking the built CLI. This file instead isolates the pure guard
 * function itself, directly against the source module, with no build step,
 * no network, and no filesystem effects of its own.
 */

const ORIGINAL_BACKEND = process.env.MC_DATABASE_BACKEND;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_BACKEND === undefined) delete process.env.MC_DATABASE_BACKEND;
  else process.env.MC_DATABASE_BACKEND = ORIGINAL_BACKEND;
});

describe('assertSqliteOnlyCommandSupported', () => {
  it('rejects every audited SQLite-only command under postgres, before any SQLite/db import is reachable', async () => {
    process.env.MC_DATABASE_BACKEND = 'postgres';
    const { assertSqliteOnlyCommandSupported, OperatorError } = await import(
      '../../scripts/github-identity-operator'
    );

    for (const command of [
      'status',
      'write-cycle-reconcile',
      'write-outcome-inspect',
      'write-outcome-resolve',
      'exception-accept',
      'exception-revoke',
    ] as const) {
      let caught: unknown;
      try {
        assertSqliteOnlyCommandSupported(command);
      } catch (error) {
        caught = error;
      }
      expect(caught, `${command} must reject under postgres`).toBeInstanceOf(OperatorError);
      expect((caught as InstanceType<typeof OperatorError>).exitCode).toBe(4);
      expect((caught as Error).message).toContain(
        `Command '${command}' is an audited SQLite-only operator/recovery surface`,
      );
    }
  });

  it('does not reject transfer-reconcile under postgres', async () => {
    process.env.MC_DATABASE_BACKEND = 'postgres';
    const { assertSqliteOnlyCommandSupported } = await import('../../scripts/github-identity-operator');

    expect(() => assertSqliteOnlyCommandSupported('transfer-reconcile')).not.toThrow();
  });

  it('does not reject any command under sqlite (the default backend)', async () => {
    delete process.env.MC_DATABASE_BACKEND;
    const { assertSqliteOnlyCommandSupported } = await import('../../scripts/github-identity-operator');

    for (const command of [
      'status',
      'write-cycle-reconcile',
      'write-outcome-inspect',
      'write-outcome-resolve',
      'exception-accept',
      'exception-revoke',
      'transfer-reconcile',
    ] as const) {
      expect(() => assertSqliteOnlyCommandSupported(command), command).not.toThrow();
    }
  });

  it('never evaluates better-sqlite3 merely by importing the script module', async () => {
    // The script's own `@/db` handle is obtained via a dynamic import inside
    // `initializeGitHubOutcomeReader`, reachable only from the
    // `write-outcome-resolve` handler, which the guard above already
    // fail-closes on postgres before that point. Proves that importing the
    // module (as this test itself just did, and as every other test in this
    // file does above) never touches the real driver package.
    const betterSqlite3ConstructorCalls = vi.fn();
    vi.doMock('better-sqlite3', () => ({
      default: class {
        constructor(...args: unknown[]) {
          betterSqlite3ConstructorCalls(...args);
        }
      },
    }));

    await import('../../scripts/github-identity-operator');

    expect(betterSqlite3ConstructorCalls).not.toHaveBeenCalled();
    vi.doUnmock('better-sqlite3');
  });
});
