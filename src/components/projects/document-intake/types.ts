/**
 * Shared types for the Document Intake Wizard.
 *
 * These are deliberately free of React so the workflow's data shapes can be
 * reused by the API layer, the `useDocumentIntake` state machine, and each
 * step component without re-declaring structural types.
 */

export interface ConnectedRepo {
  connectorId: string;
  connectorName: string;
  repo: string;
  displayName: string;
}

export interface Finding {
  id: string;
  area: string;
  issue: string;
  impact: string;
  suggestedFix: string;
  effort: string;
  priorityOrder: number;
  priorityLabel: string;
  linkedIssueNumbers?: number[];
}

export interface PhaseDefinition {
  name: string;
  description: string;
  estimatedDays: number | null;
  sortOrder: number;
  findingIds: string[];
}

export interface PreviewData {
  document: {
    title: string | null;
    findings: Finding[];
    phases: PhaseDefinition[];
    priorityGroups: Array<{ order: number; title: string; label: string; findingIds: string[] }>;
  };
  proposedProjectName: string;
  proposedPhases: PhaseDefinition[];
  proposedIssueCount: number;
  proposedTags: string[];
}

export interface CreatedIssue {
  findingId: string;
  title: string;
  issueNumber: number | null;
  htmlUrl: string | null;
}

export interface CreatedPhase {
  name: string;
  id: string;
  findingIds: string[];
  sortOrder: number;
}

export interface TaskAssignment {
  findingId: string;
  issueNumber: number | null;
  taskId: string | null;
  phaseName: string | null;
  status: string;
}

export interface ExecuteResult {
  dryRun: boolean;
  projectId: string | null;
  appendedToExisting?: boolean;
  phases: CreatedPhase[];
  issues: CreatedIssue[];
  assignments: TaskAssignment[];
  tags: string[];
  errors: string[];
}

/** Existing hub project entry, as offered by the "append to existing project" picker. */
export interface ExistingProject {
  id: string;
  name: string;
  category?: string | null;
}

export type Step = 'input' | 'preview' | 'executing' | 'done';

export type InputMode = 'paste' | 'url' | 'file';

/** Whether the intake creates a brand-new project or appends to one that exists. */
export type ProjectMode = 'new' | 'existing';

/** Body sent to `/api/ai/intake-document` for `mode: 'preview'`. */
export interface IntakePreviewPayload {
  document?: string;
  documentUrl?: string;
  projectName?: string;
}

/** Body sent to `/api/ai/intake-document` for `mode: 'execute'`. */
export interface IntakeExecutePayload {
  document?: string;
  documentUrl?: string;
  repo: string;
  projectName?: string;
  existingProjectId?: string;
  category?: string;
  skipFindingIds?: string[];
  tags?: string[];
}
