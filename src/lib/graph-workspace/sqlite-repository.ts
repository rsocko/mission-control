import type Database from 'better-sqlite3';
import { ideationWorkspaceDocumentSchema } from './ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type CreateIdeationWorkspaceInput,
  type IdeationWorkspaceRepository,
} from './repository';
import type {
  IdeationWorkspace,
  IdeationWorkspaceSummary,
  IdeationWorkspaceVersion,
  IdeationWorkspaceVersionReason,
} from './types';

const CHECKPOINT_INTERVAL_MS = 5 * 60 * 1000;

interface WorkspaceRow {
  id: string;
  name: string;
  type: 'ideation';
  schema_version: number;
  content_revision: number;
  current_document: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface VersionRow {
  id: string;
  workspace_id: string;
  revision: number;
  name: string;
  document: string;
  reason: IdeationWorkspaceVersionReason;
  created_at: string;
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
  return {
    ...toSummary(row),
    document: ideationWorkspaceDocumentSchema.parse(JSON.parse(row.current_document)),
  };
}

function toVersion(row: VersionRow): IdeationWorkspaceVersion {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    name: row.name,
    document: ideationWorkspaceDocumentSchema.parse(JSON.parse(row.document)),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export class SqliteIdeationWorkspaceRepository implements IdeationWorkspaceRepository {
  constructor(private readonly database: Database.Database) {}

  list(includeArchived: boolean): IdeationWorkspaceSummary[] {
    const where = includeArchived ? '' : 'WHERE archived_at IS NULL';
    const rows = this.database.prepare(`
      SELECT * FROM graph_workspaces
      ${where}
      ORDER BY archived_at IS NOT NULL, updated_at DESC, name COLLATE NOCASE
    `).all() as WorkspaceRow[];
    return rows.map(toSummary);
  }

  get(id: string): IdeationWorkspace | null {
    const row = this.database.prepare(
      'SELECT * FROM graph_workspaces WHERE id = ?',
    ).get(id) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  findByMigrationSource(source: string): IdeationWorkspace | null {
    const row = this.database.prepare(
      'SELECT * FROM graph_workspaces WHERE migration_source = ?',
    ).get(source) as WorkspaceRow | undefined;
    return row ? toWorkspace(row) : null;
  }

  create(input: CreateIdeationWorkspaceInput): IdeationWorkspace {
    const document = JSON.stringify(input.document);
    this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO graph_workspaces (
          id, name, type, schema_version, content_revision, current_document,
          archived_at, migration_source, created_at, updated_at
        ) VALUES (?, ?, 'ideation', 1, 1, ?, NULL, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        document,
        input.migrationSource ?? null,
        input.now,
        input.now,
      );
      this.insertVersion(
        input.id,
        1,
        input.name,
        document,
        input.reason,
        input.now,
      );
    })();
    return this.get(input.id)!;
  }

  updateContent(
    id: string,
    baseRevision: number,
    document: IdeationWorkspace['document'],
    now: string,
  ): IdeationWorkspace | null {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      if (current.contentRevision !== baseRevision) {
        throw new IdeationWorkspaceConflictError(current);
      }
      const revision = current.contentRevision + 1;
      const serialized = JSON.stringify(document);
      const result = this.database.prepare(`
        UPDATE graph_workspaces
        SET content_revision = ?, current_document = ?, updated_at = ?
        WHERE id = ? AND content_revision = ?
      `).run(revision, serialized, now, id, baseRevision);
      if (result.changes !== 1) {
        const latest = this.get(id);
        if (!latest) return null;
        throw new IdeationWorkspaceConflictError(latest);
      }

      const latestVersion = this.database.prepare(`
        SELECT created_at FROM graph_workspace_versions
        WHERE workspace_id = ?
        ORDER BY revision DESC LIMIT 1
      `).get(id) as { created_at: string } | undefined;
      if (
        !latestVersion
        || Date.parse(now) - Date.parse(latestVersion.created_at) >= CHECKPOINT_INTERVAL_MS
      ) {
        this.insertVersion(id, revision, current.name, serialized, 'checkpoint', now);
      }
      return this.get(id)!;
    })();
  }

  rename(id: string, name: string, now: string): IdeationWorkspace | null {
    const result = this.database.prepare(
      'UPDATE graph_workspaces SET name = ?, updated_at = ? WHERE id = ?',
    ).run(name, now, id);
    return result.changes ? this.get(id) : null;
  }

  setArchived(id: string, archived: boolean, now: string): IdeationWorkspace | null {
    const result = this.database.prepare(`
      UPDATE graph_workspaces
      SET archived_at = ?, updated_at = ?
      WHERE id = ?
    `).run(archived ? now : null, now, id);
    return result.changes ? this.get(id) : null;
  }

  duplicate(
    sourceId: string,
    id: string,
    name: string,
    now: string,
  ): IdeationWorkspace | null {
    const source = this.get(sourceId);
    if (!source) return null;
    return this.create({
      id,
      name,
      document: source.document,
      now,
      reason: 'created',
    });
  }

  deleteArchived(id: string): 'deleted' | 'not-found' | 'not-archived' {
    const workspace = this.get(id);
    if (!workspace) return 'not-found';
    if (!workspace.archivedAt) return 'not-archived';
    this.database.prepare('DELETE FROM graph_workspaces WHERE id = ?').run(id);
    return 'deleted';
  }

  listVersions(id: string, limit: number): IdeationWorkspaceVersion[] {
    const rows = this.database.prepare(`
      SELECT * FROM graph_workspace_versions
      WHERE workspace_id = ?
      ORDER BY revision DESC
      LIMIT ?
    `).all(id, limit) as VersionRow[];
    return rows.map(toVersion);
  }

  getVersion(id: string, revision: number): IdeationWorkspaceVersion | null {
    const row = this.database.prepare(`
      SELECT * FROM graph_workspace_versions
      WHERE workspace_id = ? AND revision = ?
    `).get(id, revision) as VersionRow | undefined;
    return row ? toVersion(row) : null;
  }

  restore(
    id: string,
    historicalRevision: number,
    baseRevision: number,
    now: string,
  ): IdeationWorkspace | null {
    return this.database.transaction(() => {
      const current = this.get(id);
      if (!current) return null;
      if (current.contentRevision !== baseRevision) {
        throw new IdeationWorkspaceConflictError(current);
      }
      const historical = this.getVersion(id, historicalRevision);
      if (!historical) return null;
      const revision = current.contentRevision + 1;
      const document = JSON.stringify(historical.document);
      const currentWasCheckpointed = this.database.prepare(`
        SELECT 1 FROM graph_workspace_versions
        WHERE workspace_id = ? AND revision = ?
      `).get(id, current.contentRevision);
      if (!currentWasCheckpointed) {
        this.insertVersion(
          id,
          current.contentRevision,
          current.name,
          JSON.stringify(current.document),
          'checkpoint',
          now,
        );
      }
      const result = this.database.prepare(`
        UPDATE graph_workspaces
        SET content_revision = ?, current_document = ?, updated_at = ?
        WHERE id = ? AND content_revision = ?
      `).run(revision, document, now, id, baseRevision);
      if (result.changes !== 1) {
        const latest = this.get(id);
        if (!latest) return null;
        throw new IdeationWorkspaceConflictError(latest);
      }
      this.insertVersion(id, revision, current.name, document, 'restored', now);
      return this.get(id)!;
    })();
  }

  private insertVersion(
    workspaceId: string,
    revision: number,
    name: string,
    document: string,
    reason: IdeationWorkspaceVersionReason,
    createdAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO graph_workspace_versions (
        id, workspace_id, revision, name, document, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(crypto.randomUUID(), workspaceId, revision, name, document, reason, createdAt);
  }
}
