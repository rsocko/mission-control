import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '@/db/schema';
import { githubIdentityControls, githubIdentityExceptionEvents, tasks } from '@/db/schema';
import { provenSupersededGitHubTaskIds } from '@/lib/external-identities/task-transfer-reconciliation';
import type {
  GitHubHierarchyApplyResult,
  GitHubHierarchyExceptionEventRow,
  GitHubHierarchyIdentitySnapshot,
  GitHubHierarchyPersistence,
  GitHubHierarchyStableBindingRow,
  GitHubHierarchyTaskIdentityRow,
  GitHubHierarchyTaskRow,
} from './github-hierarchy';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

/**
 * SQLite adapter for the GitHub sub-issue hierarchy reconciliation port.
 *
 * The apply transaction preserves the exact legacy behaviour of the direct
 * SQLite path, including the proven-succession filtering — it calls the very
 * same `provenSupersededGitHubTaskIds` the legacy module owns so historical
 * task-transfer succession state keeps being excluded identically.
 */
export function createSqliteGitHubHierarchyRepositories(
  sqlite: SqliteDatabase,
  db: SqliteDrizzle,
): GitHubHierarchyPersistence {
  function readIdentitySnapshot(
    database: SqliteDrizzle,
    connectorInstanceId: string,
  ): GitHubHierarchyIdentitySnapshot {
    const control = database
      .select({ modeRevision: githubIdentityControls.modeRevision })
      .from(githubIdentityControls)
      .where(eq(githubIdentityControls.connectorInstanceId, connectorInstanceId))
      .limit(1)
      .get();
    return { connectorInstanceId, modeRevision: control?.modeRevision ?? 0 };
  }

  function readTaskRows(
    database: SqliteDrizzle,
    connectorInstanceId: string,
  ): GitHubHierarchyTaskRow[] {
    return database
      .select({
        id: tasks.id,
        sourceId: tasks.sourceId,
        connectorInstanceId: tasks.connectorInstanceId,
        connectorType: tasks.connectorType,
        isChecklistItem: tasks.isChecklistItem,
        parentId: tasks.parentId,
        depth: tasks.depth,
        metadata: tasks.metadata,
      })
      .from(tasks)
      .where(eq(tasks.connectorInstanceId, connectorInstanceId))
      .all();
  }

  function readExceptionEvents(
    database: SqliteDrizzle,
    connectorInstanceId: string,
  ): GitHubHierarchyExceptionEventRow[] {
    return database
      .select({
        id: githubIdentityExceptionEvents.id,
        localId: githubIdentityExceptionEvents.localId,
        action: githubIdentityExceptionEvents.action,
      })
      .from(githubIdentityExceptionEvents)
      .where(and(
        eq(githubIdentityExceptionEvents.connectorInstanceId, connectorInstanceId),
        eq(githubIdentityExceptionEvents.bindingType, 'task'),
        eq(githubIdentityExceptionEvents.category, 'terminal_inaccessible'),
      ))
      .orderBy(desc(githubIdentityExceptionEvents.id))
      .all();
  }

  return {
    async getIdentityModeSnapshot(connectorInstanceId) {
      return readIdentitySnapshot(db, connectorInstanceId);
    },

    async listConnectorTaskIdentities(connectorInstanceId) {
      const rows = db
        .select({
          id: tasks.id,
          sourceId: tasks.sourceId,
          connectorInstanceId: tasks.connectorInstanceId,
          connectorType: tasks.connectorType,
          isChecklistItem: tasks.isChecklistItem,
          metadata: tasks.metadata,
        })
        .from(tasks)
        .where(eq(tasks.connectorInstanceId, connectorInstanceId))
        .all();
      return rows as GitHubHierarchyTaskIdentityRow[];
    },

    async listTaskStableBindings(connectorInstanceId) {
      return sqlite.prepare(`
        SELECT
          binding.local_id AS localTaskId,
          entity.provider,
          entity.host_key AS hostKey,
          entity.entity_type AS entityType,
          entity.stable_id AS stableId
        FROM external_entity_bindings AS binding
        INNER JOIN external_entities AS entity
          ON entity.id = binding.external_entity_id
        WHERE binding.connector_instance_id = ?
          AND binding.binding_type = 'task'
          AND binding.state != 'retired'
      `).all(connectorInstanceId) as GitHubHierarchyStableBindingRow[];
    },

    async listTerminalInaccessibleExceptions(connectorInstanceId) {
      return sqlite.prepare(`
        SELECT id, local_id AS localId, action
        FROM github_identity_exception_events
        WHERE connector_instance_id = ?
          AND binding_type = 'task'
          AND category = 'terminal_inaccessible'
        ORDER BY id DESC
      `).all(connectorInstanceId) as GitHubHierarchyExceptionEventRow[];
    },

    async provenSupersededTaskIds(connectorInstanceId, observedEndpointTaskIds) {
      return [...provenSupersededGitHubTaskIds(
        db,
        connectorInstanceId,
        new Set(observedEndpointTaskIds),
      )];
    },

    async applyReconciliation({ connectorInstanceId, observedEndpointTaskIds, reconcile }) {
      const observed = new Set(observedEndpointTaskIds);
      return db.transaction((tx): GitHubHierarchyApplyResult => {
        const identitySnapshot = readIdentitySnapshot(tx, connectorInstanceId);
        const taskRows = readTaskRows(tx, connectorInstanceId);
        const exceptionEvents = readExceptionEvents(tx, connectorInstanceId);
        const supersededHistoricalTaskIds = provenSupersededGitHubTaskIds(
          tx,
          connectorInstanceId,
          observed,
        );
        const verdict = reconcile({
          identitySnapshot,
          tasks: taskRows,
          exceptionEvents,
          supersededHistoricalTaskIds,
        });
        if (verdict.fenced) {
          return { applied: false, updated: 0, fenced: true };
        }
        let updated = 0;
        for (const update of verdict.updates) {
          const set: Partial<typeof schema.tasks.$inferInsert> = {
            parentId: update.parentId,
            depth: update.depth,
          };
          if (update.metadata !== undefined) {
            set.metadata = JSON.stringify(update.metadata);
          }
          updated += tx.update(tasks).set(set).where(eq(tasks.id, update.taskId)).run().changes;
        }
        return { applied: true, updated, fenced: false };
      }, { behavior: 'immediate' });
    },
  };
}
