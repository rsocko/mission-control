import { z } from 'zod';
import { sqlite } from '@/db';
import {
  ideationWorkspaceDocumentSchema,
  type IdeationWorkspaceDocument,
} from './ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from './repository';
import { SqliteIdeationWorkspaceRepository } from './sqlite-repository';

const nameSchema = z.string().trim().min(1).max(200);

export class IdeationWorkspaceService {
  constructor(private readonly repository: IdeationWorkspaceRepository) {}

  list(includeArchived = false) {
    return this.repository.list(includeArchived);
  }

  get(id: string) {
    return this.repository.get(id);
  }

  create(input: {
    name: unknown;
    document: unknown;
    migrationSource?: unknown;
    import?: boolean;
  }) {
    const name = nameSchema.parse(input.name);
    const document = ideationWorkspaceDocumentSchema.parse(input.document);
    const migrationSource = input.migrationSource === undefined
      ? undefined
      : z.string().min(1).max(100).parse(input.migrationSource);
    if (migrationSource) {
      const existing = this.repository.findByMigrationSource(migrationSource);
      if (existing) return existing;
    }
    try {
      return this.repository.create({
        id: `workspace-${crypto.randomUUID()}`,
        name,
        document,
        migrationSource,
        reason: migrationSource ? 'migrated' : input.import ? 'imported' : 'created',
        now: new Date().toISOString(),
      });
    } catch (error) {
      // A concurrent browser tab may win the unique migration-source insert.
      const migrated = migrationSource
        ? this.repository.findByMigrationSource(migrationSource)
        : null;
      if (migrated) return migrated;
      throw error;
    }
  }

  updateContent(id: string, baseRevision: unknown, document: unknown) {
    return this.repository.updateContent(
      id,
      z.number().int().positive().parse(baseRevision),
      ideationWorkspaceDocumentSchema.parse(document),
      new Date().toISOString(),
    );
  }

  rename(id: string, name: unknown) {
    return this.repository.rename(id, nameSchema.parse(name), new Date().toISOString());
  }

  setArchived(id: string, archived: unknown) {
    return this.repository.setArchived(
      id,
      z.boolean().parse(archived),
      new Date().toISOString(),
    );
  }

  duplicate(id: string, name: unknown) {
    return this.repository.duplicate(
      id,
      `workspace-${crypto.randomUUID()}`,
      nameSchema.parse(name),
      new Date().toISOString(),
    );
  }

  deleteArchived(id: string) {
    return this.repository.deleteArchived(id);
  }

  listVersions(id: string, limit: unknown) {
    return this.repository.listVersions(
      id,
      z.coerce.number().int().min(1).max(100).default(30).parse(limit),
    );
  }

  getVersion(id: string, revision: unknown) {
    return this.repository.getVersion(id, z.coerce.number().int().positive().parse(revision));
  }

  restore(id: string, historicalRevision: unknown, baseRevision: unknown) {
    return this.repository.restore(
      id,
      z.number().int().positive().parse(historicalRevision),
      z.number().int().positive().parse(baseRevision),
      new Date().toISOString(),
    );
  }
}

export const ideationWorkspaceService = new IdeationWorkspaceService(
  new SqliteIdeationWorkspaceRepository(sqlite),
);

export function isWorkspaceConflict(
  error: unknown,
): error is IdeationWorkspaceConflictError {
  return error instanceof IdeationWorkspaceConflictError;
}

export function isWorkspaceValidationError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}

export type { IdeationWorkspaceDocument };
