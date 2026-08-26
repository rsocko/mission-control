import type {
  IdeationWorkspace,
  IdeationWorkspaceSummary,
  IdeationWorkspaceVersion,
  IdeationWorkspaceVersionReason,
} from './types';
import type { IdeationWorkspaceDocument } from './ideation-contract';

export interface CreateIdeationWorkspaceInput {
  id: string;
  name: string;
  document: IdeationWorkspaceDocument;
  now: string;
  migrationSource?: string;
  reason: Extract<IdeationWorkspaceVersionReason, 'created' | 'imported' | 'migrated'>;
}

export interface IdeationWorkspaceRepository {
  list(includeArchived: boolean): Promise<IdeationWorkspaceSummary[]>;
  get(id: string): Promise<IdeationWorkspace | null>;
  findByMigrationSource(source: string): Promise<IdeationWorkspace | null>;
  create(input: CreateIdeationWorkspaceInput): Promise<IdeationWorkspace>;
  updateContent(
    id: string,
    baseRevision: number,
    document: IdeationWorkspaceDocument,
    now: string,
  ): Promise<IdeationWorkspace | null>;
  rename(id: string, name: string, now: string): Promise<IdeationWorkspace | null>;
  setArchived(
    id: string,
    archived: boolean,
    now: string,
  ): Promise<IdeationWorkspace | null>;
  duplicate(
    sourceId: string,
    id: string,
    name: string,
    now: string,
  ): Promise<IdeationWorkspace | null>;
  deleteArchived(id: string): Promise<'deleted' | 'not-found' | 'not-archived'>;
  listVersions(id: string, limit: number): Promise<IdeationWorkspaceVersion[]>;
  getVersion(id: string, revision: number): Promise<IdeationWorkspaceVersion | null>;
  restore(
    id: string,
    historicalRevision: number,
    baseRevision: number,
    now: string,
  ): Promise<IdeationWorkspace | null>;
}

export class IdeationWorkspaceConflictError extends Error {
  constructor(readonly current: IdeationWorkspace) {
    super('This workspace changed in another tab or client.');
    this.name = 'IdeationWorkspaceConflictError';
  }
}
