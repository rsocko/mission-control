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
  list(includeArchived: boolean): IdeationWorkspaceSummary[];
  get(id: string): IdeationWorkspace | null;
  findByMigrationSource(source: string): IdeationWorkspace | null;
  create(input: CreateIdeationWorkspaceInput): IdeationWorkspace;
  updateContent(
    id: string,
    baseRevision: number,
    document: IdeationWorkspaceDocument,
    now: string,
  ): IdeationWorkspace | null;
  rename(id: string, name: string, now: string): IdeationWorkspace | null;
  setArchived(id: string, archived: boolean, now: string): IdeationWorkspace | null;
  duplicate(sourceId: string, id: string, name: string, now: string): IdeationWorkspace | null;
  deleteArchived(id: string): 'deleted' | 'not-found' | 'not-archived';
  listVersions(id: string, limit: number): IdeationWorkspaceVersion[];
  getVersion(id: string, revision: number): IdeationWorkspaceVersion | null;
  restore(
    id: string,
    historicalRevision: number,
    baseRevision: number,
    now: string,
  ): IdeationWorkspace | null;
}

export class IdeationWorkspaceConflictError extends Error {
  constructor(readonly current: IdeationWorkspace) {
    super('This workspace changed in another tab or client.');
    this.name = 'IdeationWorkspaceConflictError';
  }
}
