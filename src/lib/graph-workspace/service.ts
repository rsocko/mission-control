import { z } from 'zod';
import { persistence } from '@/lib/persistence/runtime';
import {
  ideationWorkspaceDocumentSchema,
  type IdeationWorkspaceDocument,
} from './ideation-contract';
import {
  IdeationWorkspaceConflictError,
  type IdeationWorkspaceRepository,
} from './repository';

const nameSchema = z.string().trim().min(1).max(200);

export class IdeationWorkspaceService {
  constructor(private readonly repository: IdeationWorkspaceRepository) {}

  async list(includeArchived = false) {
    return this.repository.list(includeArchived);
  }

  async get(id: string) {
    return this.repository.get(id);
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
    if (migrationSource) {
      const existing = await this.repository.findByMigrationSource(migrationSource);
      if (existing) return existing;
    }
    try {
      return await this.repository.create({
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
        ? await this.repository.findByMigrationSource(migrationSource)
        : null;
      if (migrated) return migrated;
      throw error;
    }
  }

  async updateContent(id: string, baseRevision: unknown, document: unknown) {
    return this.repository.updateContent(
      id,
      z.number().int().positive().parse(baseRevision),
      ideationWorkspaceDocumentSchema.parse(document),
      new Date().toISOString(),
    );
  }

  async rename(id: string, name: unknown) {
    return this.repository.rename(id, nameSchema.parse(name), new Date().toISOString());
  }

  async setArchived(id: string, archived: unknown) {
    return this.repository.setArchived(
      id,
      z.boolean().parse(archived),
      new Date().toISOString(),
    );
  }

  async duplicate(id: string, name: unknown) {
    return this.repository.duplicate(
      id,
      `workspace-${crypto.randomUUID()}`,
      nameSchema.parse(name),
      new Date().toISOString(),
    );
  }

  async deleteArchived(id: string) {
    return this.repository.deleteArchived(id);
  }

  async listVersions(id: string, limit: unknown) {
    return this.repository.listVersions(
      id,
      z.coerce.number().int().min(1).max(100).default(30).parse(limit),
    );
  }

  async getVersion(id: string, revision: unknown) {
    return this.repository.getVersion(id, z.coerce.number().int().positive().parse(revision));
  }

  async restore(id: string, historicalRevision: unknown, baseRevision: unknown) {
    return this.repository.restore(
      id,
      z.number().int().positive().parse(historicalRevision),
      z.number().int().positive().parse(baseRevision),
      new Date().toISOString(),
    );
  }
}

export const ideationWorkspaceService = new IdeationWorkspaceService(
  persistence.ideationWorkspaces,
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
