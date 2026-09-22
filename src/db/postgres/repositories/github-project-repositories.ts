import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  GitHubProjectIdentityFence,
  GitHubProjectPersistence,
  GitHubProjectReconciliation,
} from '@/db/persistence/github-projects';

type Client = Pool | PoolClient;

async function query<T extends QueryResultRow>(
  client: Client,
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query(text, [...params])).rows as T[];
}

async function transaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

function objectValue(value: unknown): Record<string, unknown> {
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
 * PostgreSQL adapter for the sync-managed GitHub Projects V2 reconciliation
 * port. Each project is reconciled in one transaction whose first act is to
 * re-check the frozen identity fence with SQL, so the decision-currency check
 * and the hub-project + `task_projects` writes commit atomically.
 */
export function createPostgresGitHubProjectRepositories(
  pool: Pool,
): GitHubProjectPersistence {
  async function assertFenceCurrent(
    client: Client,
    connectorInstanceId: string,
    fence: GitHubProjectIdentityFence,
  ): Promise<void> {
    const [control] = await query<{ modeRevision: number }>(
      client,
      `SELECT mode_revision AS "modeRevision"
       FROM github_identity_controls
       WHERE connector_instance_id = $1
       LIMIT 1`,
      [connectorInstanceId],
    );
    if ((control?.modeRevision ?? 0) !== fence.modeRevision) {
      throw new Error('GitHub identity revision changed');
    }
    for (const check of fence.checks) {
      const current = await query<{ present: number }>(
        client,
        `SELECT 1 AS present
         FROM external_entity_bindings AS binding
         INNER JOIN external_entity_locators AS locator
           ON locator.external_entity_id = binding.external_entity_id
           AND locator.valid_to IS NULL
         WHERE binding.connector_instance_id = $1
           AND binding.binding_type = $2
           AND binding.local_id = $3
           AND binding.external_entity_id = $4
           AND binding.state = 'active'
           AND binding.verified_at = $5
           AND locator.locator_revision = $6
         LIMIT 1`,
        [
          connectorInstanceId,
          check.bindingType,
          check.localId,
          check.externalEntityId,
          check.bindingRevision,
          check.locatorRevision,
        ],
      );
      if (current.length === 0) {
        throw new Error('GitHub stable decision binding or locator is stale');
      }
    }
  }

  async function reconcileProject(
    connectorInstanceId: string,
    now: string,
    fence: GitHubProjectIdentityFence | undefined,
    project: GitHubProjectReconciliation,
  ): Promise<void> {
    await transaction(pool, async (client) => {
      if (fence) await assertFenceCurrent(client, connectorInstanceId, fence);
      const projectId = `gh-project:${connectorInstanceId}:${project.number}`;
      const [existing] = await query<{ metadata: unknown }>(
        client,
        'SELECT metadata FROM hub_projects WHERE id = $1',
        [projectId],
      );
      const existingMetadata = objectValue(existing?.metadata);
      const digest = project.resolveIdentityDigest(
        typeof existingMetadata.githubProjectIdentityDigest === 'string'
          ? existingMetadata.githubProjectIdentityDigest
          : undefined,
      );
      const metadata = {
        githubProjectNumber: project.number,
        githubProjectUrl: project.url,
        githubProjectIdentityDigest: digest,
        connectorId: connectorInstanceId,
        syncManaged: true,
      };
      if (existing) {
        await client.query(
          `UPDATE hub_projects
           SET name = $1, description = $2, metadata = $3, updated_at = $4
           WHERE id = $5`,
          [project.name, project.description, metadata, now, projectId],
        );
      } else {
        await client.query(
          `INSERT INTO hub_projects (
             id, name, description, color, icon, source_bindings, metadata,
             created_at, updated_at
           ) VALUES ($1, $2, $3, '#6e40c9', NULL, $4::jsonb, $5, $6, $7)`,
          [
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
          ],
        );
      }

      const desired = new Set<string>();
      if (project.useStableRouting) {
        const stableTaskIds = [...(project.stableTaskIds ?? [])];
        if (stableTaskIds.length > 0) {
          const rows = await query<{ id: string }>(
            client,
            `SELECT id FROM tasks
             WHERE connector_instance_id = $1 AND id = ANY($2::text[])`,
            [connectorInstanceId, stableTaskIds],
          );
          for (const row of rows) desired.add(row.id);
        }
      } else if (project.taskSourceIds.length > 0) {
        const rows = await query<{ id: string }>(
          client,
          `SELECT id FROM tasks
           WHERE connector_instance_id = $1 AND source_id = ANY($2::text[])`,
          [connectorInstanceId, [...project.taskSourceIds]],
        );
        for (const row of rows) desired.add(row.id);
      }

      const existingLinks = await query<{ taskId: string }>(
        client,
        'SELECT task_id AS "taskId" FROM task_projects WHERE project_id = $1',
        [projectId],
      );
      for (const taskId of desired) {
        await client.query(
          `INSERT INTO task_projects (task_id, project_id)
           VALUES ($1, $2)
           ON CONFLICT (task_id, project_id) DO NOTHING`,
          [taskId, projectId],
        );
      }
      // Stale links are pruned only from complete authoritative observations, so
      // a partial project observation never deletes existing associations.
      if (project.authoritative) {
        for (const link of existingLinks) {
          if (desired.has(link.taskId)) continue;
          await client.query(
            'DELETE FROM task_projects WHERE task_id = $1 AND project_id = $2',
            [link.taskId, projectId],
          );
        }
      }
    });
  }

  return {
    async reconcileSyncManagedProjects({ connectorInstanceId, now, identityFence, projects }) {
      for (const project of projects) {
        await reconcileProject(connectorInstanceId, now, identityFence, project);
      }
    },
  };
}
