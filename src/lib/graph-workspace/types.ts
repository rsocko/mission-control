import type { IdeationWorkspaceDocument } from './ideation-contract';

export interface IdeationWorkspaceSummary {
  id: string;
  name: string;
  type: 'ideation';
  schemaVersion: 1;
  contentRevision: number;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdeationWorkspace extends IdeationWorkspaceSummary {
  document: IdeationWorkspaceDocument;
}

export type IdeationWorkspaceVersionReason =
  | 'created'
  | 'checkpoint'
  | 'restored'
  | 'imported'
  | 'migrated';

export interface IdeationWorkspaceVersion {
  id: string;
  workspaceId: string;
  revision: number;
  name: string;
  document: IdeationWorkspaceDocument;
  reason: IdeationWorkspaceVersionReason;
  createdAt: string;
}
