import { z } from 'zod';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';
import {
  ideationWorkspaceDocumentSchema,
  type IdeationWorkspaceDocument,
} from './ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from './repository';

const nameSchema = z.string().trim().min(1).max(200);

/**
 * Resolves the composed, backend-selected workspace repository (L16).
 *
 * The service holds a resolver rather than a constructed repository so this
 * module never evaluates a database driver at import time. That is what keeps
 * the five `/api/ideation/workspaces` routes and their shared error helper out
 * of the web/API SQLite-taint census entirely.
 */
export type IdeationWorkspaceRepositoryResolver =
  () => Promise<IdeationWorkspaceRepository>;

export class IdeationWorkspaceService {
  constructor(private readonly resolveRepository: IdeationWorkspaceRepositoryResolver) {}

  async list(includeArchived = false) {
    return (await this.resolveRepository()).list(includeArchived);
  }

  async get(id: string) {
    return (await this.resolveRepository()).get(id);
  }

  async create(input: {
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
    const repository = await this.resolveRepository();
    if (migrationSource) {
      const existing = await repository.findByMigrationSource(migrationSource);
      if (existing) return existing;
    }
    try {
      return await repository.create({
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
        ? await repository.findByMigrationSource(migrationSource)
        : null;
      if (migrated) return migrated;
      throw error;
    }
  }

  async updateContent(id: string, baseRevision: unknown, document: unknown) {
    return (await this.resolveRepository()).updateContent(
      id,
      z.number().int().positive().parse(baseRevision),
      ideationWorkspaceDocumentSchema.parse(document),
      new Date().toISOString(),
    );
  }

  async rename(id: string, name: unknown) {
    return (await this.resolveRepository()).rename(
      id,
      nameSchema.parse(name),
      new Date().toISOString(),
    );
  }

  async setArchived(id: string, archived: unknown) {
    return (await this.resolveRepository()).setArchived(
      id,
      z.boolean().parse(archived),
      new Date().toISOString(),
    );
  }

  async duplicate(id: string, name: unknown) {
    return (await this.resolveRepository()).duplicate(
      id,
      `workspace-${crypto.randomUUID()}`,
      nameSchema.parse(name),
      new Date().toISOString(),
    );
  }

  async deleteArchived(id: string) {
    return (await this.resolveRepository()).deleteArchived(id);
  }

  async listVersions(id: string, limit: unknown) {
    return (await this.resolveRepository()).listVersions(
      id,
      z.coerce.number().int().min(1).max(100).default(30).parse(limit),
    );
  }

  async getVersion(id: string, revision: unknown) {
    return (await this.resolveRepository()).getVersion(
      id,
      z.coerce.number().int().positive().parse(revision),
    );
  }

  async restore(id: string, historicalRevision: unknown, baseRevision: unknown) {
    return (await this.resolveRepository()).restore(
      id,
      z.number().int().positive().parse(historicalRevision),
      z.number().int().positive().parse(baseRevision),
      new Date().toISOString(),
    );
  }
}

export const ideationWorkspaceService = new IdeationWorkspaceService(
  async () => (await getWorkerPersistenceRepositories()).ideationWorkspaces,
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
