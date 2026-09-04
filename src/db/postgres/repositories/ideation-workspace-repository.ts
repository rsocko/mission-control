import { randomUUID } from 'crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ideationWorkspaceDocumentSchema } from '@/lib/graph-workspace/ideation-contract';
import {
  IdeationWorkspaceConflictError,
  shouldCheckpointIdeationRevision,
  type CreateIdeationWorkspaceInput,
  type IdeationWorkspaceRepository,
} from '@/lib/graph-workspace/repository';
import type {
  IdeationWorkspace,
  IdeationWorkspaceSummary,
  IdeationWorkspaceVersion,
  IdeationWorkspaceVersionReason,
} from '@/lib/graph-workspace/types';

/**
 * PostgreSQL adapter for the Ideation workspace port (L16).
 *
 * Concurrency notes:
 *
 * - Compare-and-swap commands (`updateContent`, `restore`) take a single
 *   `SELECT ... FOR UPDATE` row lock inside one `READ COMMITTED` transaction.
 *   Every command touches exactly one `graph_workspaces` row, so there is no
 *   multi-row anomaly for `SERIALIZABLE` to protect against and no retry loop
 *   is warranted.
 * - `deleteArchived` also runs inside one `FOR UPDATE` transaction. SQLite's
 *   read-then-delete pair is not transactional; single-threaded behaviour is
 *   identical and PostgreSQL is intentionally stronger under concurrency.
 * - `duplicate` deliberately stays a non-atomic read-then-create, matching
 *   SQLite exactly rather than silently strengthening it.
 */

interface WorkspaceRow {
  id: string;
  name: string;
  type: 'ideation';
  content_revision: number;
  current_document: unknown;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  workspace_id: string;
  revision: number;
  name: string;
  document: unknown;
  reason: IdeationWorkspaceVersionReason;
  created_at: string;
}

/**
 * SQLite orders this list by `name COLLATE NOCASE`, which folds **only** ASCII
 * `A-Z` and then compares bytes. `lower(name)` under a libc/ICU collation is
 * not equivalent: it folds non-ASCII too and reorders digits and punctuation.
 * ASCII-only `translate` plus `COLLATE "C"` reproduces SQLite exactly, and the
 * trailing `id` makes the order total in both backends.
 */
const LIST_ORDER = `
  ORDER BY (archived_at IS NOT NULL) ASC,
           updated_at DESC,
           translate(name, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') COLLATE "C" ASC,
           id COLLATE "C" ASC
`;

/**
 * Narrows the `Pool | PoolClient` union to one call signature. Invoking
 * `.query` directly on the union is not reliably callable, so every statement
 * that can run either on the pool or inside a transaction goes through here.
 */
async function query<T extends QueryResultRow>(
  client: Pool | PoolClient,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  return (await client.query<T>(text, [...values])).rows;
}

function parseDocument(value: unknown) {
  // `jsonb` hands back an already-parsed value; SQLite hands back JSON text.
  return ideationWorkspaceDocumentSchema.parse(
    typeof value === 'string' ? JSON.parse(value) : value,
  );
}

function toSummary(row: WorkspaceRow): IdeationWorkspaceSummary {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    schemaVersion: 1,
    contentRevision: row.content_revision,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toWorkspace(row: WorkspaceRow): IdeationWorkspace {
  return { ...toSummary(row), document: parseDocument(row.current_document) };
}

function toVersion(row: VersionRow): IdeationWorkspaceVersion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    name: row.name,
    document: parseDocument(row.document),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

async function withTransaction<T>(
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
      // A failed statement (for example the unique `migration_source`
      // violation the service recovers from) aborts the transaction, so the
      // rollback must succeed before the client goes back to the pool.
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    client.release();
  }
}

async function readWorkspace(
  client: Pool | PoolClient,
  id: string,
  lock = false,
): Promise<IdeationWorkspace | null> {
  const rows = await query<WorkspaceRow>(
    client,
    `SELECT * FROM graph_workspaces WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ? toWorkspace(rows[0]) : null;
}

async function readVersion(
  client: Pool | PoolClient,
  id: string,
  revision: number,
): Promise<IdeationWorkspaceVersion | null> {
  const rows = await query<VersionRow>(
    client,
    'SELECT * FROM graph_workspace_versions WHERE workspace_id = $1 AND revision = $2',
    [id, revision],
  );
  return rows[0] ? toVersion(rows[0]) : null;
}

async function insertVersion(
  client: Pool | PoolClient,
  workspaceId: string,
  revision: number,
  name: string,
  document: unknown,
  reason: IdeationWorkspaceVersionReason,
  createdAt: string,
): Promise<void> {
  await query(
    client,
    `INSERT INTO graph_workspace_versions (
       id, workspace_id, revision, name, document, reason, created_at
     ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)`,
    [randomUUID(), workspaceId, revision, name, JSON.stringify(document), reason, createdAt],
  );
}

export function createPostgresIdeationWorkspaceRepository(
  pool: Pool,
): IdeationWorkspaceRepository {
  async function createWorkspace(
    input: CreateIdeationWorkspaceInput,
  ): Promise<IdeationWorkspace> {
    return withTransaction(pool, async (client) => {
      await client.query(
        `INSERT INTO graph_workspaces (
           id, name, type, schema_version, content_revision, current_document,
           archived_at, migration_source, created_at, updated_at
         ) VALUES ($1, $2, 'ideation', 1, 1, $3::jsonb, NULL, $4, $5, $5)`,
        [
          input.id,
          input.name,
          JSON.stringify(input.document),
          input.migrationSource ?? null,
          input.now,
        ],
      );
      await insertVersion(
        client,
        input.id,
        1,
        input.name,
        input.document,
        input.reason,
        input.now,
      );
      return (await readWorkspace(client, input.id))!;
    });
  }

  return {
    async list(includeArchived: boolean): Promise<IdeationWorkspaceSummary[]> {
      const { rows } = await pool.query<WorkspaceRow>(`
        SELECT * FROM graph_workspaces
        ${includeArchived ? '' : 'WHERE archived_at IS NULL'}
        ${LIST_ORDER}
      `);
      return rows.map(toSummary);
    },

    async get(id: string): Promise<IdeationWorkspace | null> {
      return readWorkspace(pool, id);
    },

    async findByMigrationSource(source: string): Promise<IdeationWorkspace | null> {
      const { rows } = await pool.query<WorkspaceRow>(
        'SELECT * FROM graph_workspaces WHERE migration_source = $1',
        [source],
      );
      return rows[0] ? toWorkspace(rows[0]) : null;
    },

    async create(input: CreateIdeationWorkspaceInput): Promise<IdeationWorkspace> {
      return createWorkspace(input);
    },

    async updateContent(id, baseRevision, document, now) {
      return withTransaction(pool, async (client) => {
        const current = await readWorkspace(client, id, true);
        if (!current) return null;
        if (current.contentRevision !== baseRevision) {
          throw new IdeationWorkspaceConflictError(current);
        }
        const revision = current.contentRevision + 1;
        await client.query(
          `UPDATE graph_workspaces
           SET content_revision = $1, current_document = $2::jsonb, updated_at = $3
           WHERE id = $4 AND content_revision = $5`,
          [revision, JSON.stringify(document), now, id, baseRevision],
        );

        const { rows } = await client.query<{ created_at: string }>(
          `SELECT created_at FROM graph_workspace_versions
           WHERE workspace_id = $1
           ORDER BY revision DESC LIMIT 1`,
          [id],
        );
        if (shouldCheckpointIdeationRevision(now, rows[0]?.created_at ?? null)) {
          await insertVersion(client, id, revision, current.name, document, 'checkpoint', now);
        }
        return (await readWorkspace(client, id))!;
      });
    },

    async rename(id, name, now) {
      const { rows } = await pool.query<WorkspaceRow>(
        'UPDATE graph_workspaces SET name = $1, updated_at = $2 WHERE id = $3 RETURNING *',
        [name, now, id],
      );
      return rows[0] ? toWorkspace(rows[0]) : null;
    },

    async setArchived(id, archived, now) {
      const { rows } = await pool.query<WorkspaceRow>(
        `UPDATE graph_workspaces
         SET archived_at = $1, updated_at = $2
         WHERE id = $3
         RETURNING *`,
        [archived ? now : null, now, id],
      );
      return rows[0] ? toWorkspace(rows[0]) : null;
    },

    async duplicate(sourceId, id, name, now) {
      const source = await readWorkspace(pool, sourceId);
      if (!source) return null;
      return createWorkspace({ id, name, document: source.document, now, reason: 'created' });
    },

    async deleteArchived(id): Promise<'deleted' | 'not-found' | 'not-archived'> {
      return withTransaction(pool, async (client) => {
        const workspace = await readWorkspace(client, id, true);
        if (!workspace) return 'not-found';
        if (!workspace.archivedAt) return 'not-archived';
        await client.query('DELETE FROM graph_workspaces WHERE id = $1', [id]);
        return 'deleted';
      });
    },

    async listVersions(id, limit): Promise<IdeationWorkspaceVersion[]> {
      const { rows } = await pool.query<VersionRow>(
        `SELECT * FROM graph_workspace_versions
         WHERE workspace_id = $1
         ORDER BY revision DESC
         LIMIT $2`,
        [id, limit],
      );
      return rows.map(toVersion);
    },

    async getVersion(id, revision): Promise<IdeationWorkspaceVersion | null> {
      return readVersion(pool, id, revision);
    },

    async restore(id, historicalRevision, baseRevision, now) {
      return withTransaction(pool, async (client) => {
        const current = await readWorkspace(client, id, true);
        if (!current) return null;
        if (current.contentRevision !== baseRevision) {
          throw new IdeationWorkspaceConflictError(current);
        }
        const historical = await readVersion(client, id, historicalRevision);
        if (!historical) return null;
        const revision = current.contentRevision + 1;

        const { rowCount } = await client.query(
          'SELECT 1 FROM graph_workspace_versions WHERE workspace_id = $1 AND revision = $2',
          [id, current.contentRevision],
        );
        if (!rowCount) {
          await insertVersion(
            client,
            id,
            current.contentRevision,
            current.name,
            current.document,
            'checkpoint',
            now,
          );
        }
        await client.query(
          `UPDATE graph_workspaces
           SET content_revision = $1, current_document = $2::jsonb, updated_at = $3
           WHERE id = $4 AND content_revision = $5`,
          [revision, JSON.stringify(historical.document), now, id, baseRevision],
        );
        await insertVersion(
          client,
          id,
          revision,
          current.name,
          historical.document,
          'restored',
          now,
        );
        return (await readWorkspace(client, id))!;
      });
    },
  };
}
