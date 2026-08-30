import type Database from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema';
import type {
  GitHubProjectIdentityFence,
  GitHubProjectPersistence,
  GitHubProjectReconciliation,
} from './github-projects';

type SqliteDatabase = Database.Database;
type SqliteDrizzle = BetterSQLite3Database<typeof schema>;

function parseObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

/**
 * SQLite adapter for the sync-managed GitHub Projects V2 reconciliation port.
 *
 * The frozen identity fence is re-checked with SQL at the start of each
 * project's transaction, replacing the async identity callback that previously
 * ran outside the better-sqlite3 write. This restores the invariant that the
 * decision currency check and the hub-project + `task_projects` writes commit
 * atomically under one fence.
 */
export function createSqliteGitHubProjectRepositories(
  sqlite: SqliteDatabase,
  _db: SqliteDrizzle, // eslint-disable-line @typescript-eslint/no-unused-vars
): GitHubProjectPersistence {
  function assertFenceCurrent(
    connectorInstanceId: string,
    fence: GitHubProjectIdentityFence,
  ): void {
    const control = sqlite
      .prepare('SELECT mode_revision AS modeRevision FROM github_identity_controls WHERE connector_instance_id = ? LIMIT 1')
      .get(connectorInstanceId) as { modeRevision: number } | undefined;
    if ((control?.modeRevision ?? 0) !== fence.modeRevision) {
      throw new Error('GitHub identity revision changed');
    }
    for (const check of fence.checks) {
      const current = sqlite
        .prepare(`
          SELECT 1
          FROM external_entity_bindings AS binding
          INNER JOIN external_entity_locators AS locator
            ON locator.external_entity_id = binding.external_entity_id
            AND locator.valid_to IS NULL
          WHERE binding.connector_instance_id = ?
            AND binding.binding_type = ?
            AND binding.local_id = ?
            AND binding.external_entity_id = ?
            AND binding.state = 'active'
            AND binding.verified_at = ?
            AND locator.locator_revision = ?
          LIMIT 1
        `)
        .get(
          connectorInstanceId,
          check.bindingType,
          check.localId,
          check.externalEntityId,
          check.bindingRevision,
          check.locatorRevision,
        );
      if (!current) {
        throw new Error('GitHub stable decision binding or locator is stale');
      }
    }
  }

  function reconcileProject(
    connectorInstanceId: string,
    now: string,
    fence: GitHubProjectIdentityFence | undefined,
    project: GitHubProjectReconciliation,
  ): void {
    const tx = sqlite.transaction(() => {
      if (fence) assertFenceCurrent(connectorInstanceId, fence);
      const projectId = `gh-project:${connectorInstanceId}:${project.number}`;
      const existing = sqlite
        .prepare('SELECT metadata FROM hub_projects WHERE id = ?')
        .get(projectId) as { metadata: unknown } | undefined;
      const existingMetadata = parseObject(existing?.metadata);
      const digest = project.resolveIdentityDigest(
        typeof existingMetadata.githubProjectIdentityDigest === 'string'
          ? existingMetadata.githubProjectIdentityDigest
          : undefined,
      );
      const metadata = JSON.stringify({
        githubProjectNumber: project.number,
        githubProjectUrl: project.url,
        githubProjectIdentityDigest: digest,
        connectorId: connectorInstanceId,
        syncManaged: true,
      });
      if (existing) {
        sqlite.prepare(`
          UPDATE hub_projects
          SET name = ?, description = ?, metadata = ?, updated_at = ?
          WHERE id = ?
        `).run(project.name, project.description, metadata, now, projectId);
      } else {
        sqlite.prepare(`
          INSERT INTO hub_projects (
            id, name, description, color, icon, source_bindings, metadata,
            created_at, updated_at
          ) VALUES (?, ?, ?, '#6e40c9', NULL, ?, ?, ?, ?)
        `).run(
          projectId,
          project.name,
          project.description,
          JSON.stringify([{
            connectorId: connectorInstanceId,
            type: 'github-project',
            projectNumber: project.number,
          }]),
          metadata,
          now,
          now,
        );
      }

      const desired = new Set<string>();
      if (project.useStableRouting) {
        const stableTaskIds = project.stableTaskIds ?? [];
        if (stableTaskIds.length > 0) {
          const rows = sqlite.prepare(`
            SELECT id FROM tasks
            WHERE connector_instance_id = ?
              AND id IN (${stableTaskIds.map(() => '?').join(', ')})
          `).all(connectorInstanceId, ...stableTaskIds) as Array<{ id: string }>;
          for (const row of rows) desired.add(row.id);
        }
      } else if (project.taskSourceIds.length > 0) {
        const rows = sqlite.prepare(`
          SELECT id FROM tasks
          WHERE connector_instance_id = ?
            AND source_id IN (${project.taskSourceIds.map(() => '?').join(', ')})
        `).all(connectorInstanceId, ...project.taskSourceIds) as Array<{ id: string }>;
        for (const row of rows) desired.add(row.id);
      }

      const existingLinks = sqlite
        .prepare('SELECT task_id AS taskId FROM task_projects WHERE project_id = ?')
        .all(projectId) as Array<{ taskId: string }>;
      for (const taskId of desired) {
        sqlite.prepare(`
          INSERT INTO task_projects (task_id, project_id)
          VALUES (?, ?)
          ON CONFLICT(task_id, project_id) DO NOTHING
        `).run(taskId, projectId);
      }
      // Stale links are pruned only from complete authoritative observations, so
      // a partial project observation never deletes existing associations.
      if (project.authoritative) {
        for (const link of existingLinks) {
          if (desired.has(link.taskId)) continue;
          sqlite.prepare('DELETE FROM task_projects WHERE task_id = ? AND project_id = ?')
            .run(link.taskId, projectId);
        }
      }
    });
    tx.immediate();
  }

  return {
    async reconcileSyncManagedProjects({ connectorInstanceId, now, identityFence, projects }) {
      for (const project of projects) {
        reconcileProject(connectorInstanceId, now, identityFence, project);
      }
    },
  };
}
