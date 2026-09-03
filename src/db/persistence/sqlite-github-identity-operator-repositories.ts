import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import {
  getGitHubIdentityPhaseInTransaction,
  updateGitHubIdentityPhaseInTransaction,
} from '@/lib/external-identities/service';
import { recordGitHubIdentityExceptionInTransaction } from '@/lib/external-identities/identity-exceptions';
import {
  getGitHubIdentityBackfillStatusSync,
  preflightGitHubIdentityBackfillSync,
  previewIdentityBatchSync,
  runGitHubIdentityBackfillSync,
} from '@/lib/external-identities/github-backfill';
import { getGitHubIdentityStatusSync } from '@/lib/external-identities/identity-status';
import { reconcileInterruptedGitHubWriteCycleSync } from '@/lib/external-identities/write-cycle-reconciliation';
import {
  inspectGitHubWriteOutcomesSync,
  resolveGitHubWriteOutcomeSync,
} from '@/lib/external-identities/write-outcome-resolution';
import type { GitHubIdentityOperatorPersistence } from './github-identity-operator';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

/**
 * SQLite adapter for the five pre-existing, previously audited GitHub worker
 * operator/recovery surfaces (see `github-worker-errors.ts` and
 * `github-identity-operator.ts`). Every member here genuinely reuses the exact
 * pre-existing query/mutation logic verbatim via the sibling `*Sync` functions
 * in `src/lib/external-identities`; only the database handle sourcing changed
 * from a module-level singleton import to these injected `sqlite`/`db`
 * parameters. This factory is only ever called from SQLite composition
 * (`worker-runtime.ts`); the PostgreSQL adapter
 * (`github-identity-operator-repositories.ts`) fails closed instead of
 * implementing any of this.
 */
export function createSqliteGitHubIdentityOperatorRepositories(
  sqlite: SqliteDatabase,
  db: SqliteDrizzle,
): GitHubIdentityOperatorPersistence {
  const deps = { sqlite, db };

  return {
    async getIdentityStatus(connectorInstanceId, options) {
      return getGitHubIdentityStatusSync(deps, connectorInstanceId, options);
    },

    async recordIdentityException(request) {
      return db.transaction(
        (tx) => recordGitHubIdentityExceptionInTransaction(tx, request),
        { behavior: 'immediate' },
      );
    },

    async reconcileInterruptedWriteCycle(command) {
      return reconcileInterruptedGitHubWriteCycleSync(deps, command);
    },

    async inspectWriteOutcomes(options) {
      return inspectGitHubWriteOutcomesSync(deps, options);
    },

    async resolveWriteOutcome(command, reader) {
      return resolveGitHubWriteOutcomeSync(deps, command, reader);
    },

    async getBackfillPhase(connectorInstanceId) {
      return getGitHubIdentityPhaseInTransaction(db, connectorInstanceId);
    },

    async updateBackfillPhase({ connectorInstanceId, phase, now }) {
      db.transaction(
        (tx) => updateGitHubIdentityPhaseInTransaction(tx, connectorInstanceId, phase, now),
        { behavior: 'immediate' },
      );
    },

    async previewIdentityBatch(writes) {
      return previewIdentityBatchSync(db, [...writes]);
    },

    async getBackfillStatus(connectorInstanceId) {
      return getGitHubIdentityBackfillStatusSync(deps, connectorInstanceId);
    },

    async preflightBackfill(connectorInstanceId, persistCollisions) {
      return preflightGitHubIdentityBackfillSync(deps, connectorInstanceId, persistCollisions);
    },

    async runBackfill(options) {
      return runGitHubIdentityBackfillSync(deps, options);
    },
  };
}
