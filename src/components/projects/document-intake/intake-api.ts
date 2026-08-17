import type {
  ConnectedRepo,
  CreatedIssue,
  CreatedPhase,
  ExecuteResult,
  ExistingProject,
  Finding,
  IntakeExecutePayload,
  IntakePreviewPayload,
  PhaseDefinition,
  PreviewData,
  TaskAssignment,
} from './types';

/**
 * Network primitives behind the Document Intake Wizard.
 *
 * These are deliberately free of React so the preview/execute workflow can be
 * exercised without rendering any step component.
 */

const INTAKE_ENDPOINT = '/api/ai/intake-document';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === 'number';
}

function isFinding(value: unknown): value is Finding {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.area === 'string'
    && typeof value.issue === 'string'
    && typeof value.impact === 'string'
    && typeof value.suggestedFix === 'string'
    && typeof value.effort === 'string'
    && typeof value.priorityOrder === 'number'
    && typeof value.priorityLabel === 'string'
    && (value.linkedIssueNumbers === undefined
      || (Array.isArray(value.linkedIssueNumbers)
        && value.linkedIssueNumbers.every((issueNumber) => typeof issueNumber === 'number')));
}

function isPhaseDefinition(value: unknown): value is PhaseDefinition {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.description === 'string'
    && isNullableNumber(value.estimatedDays)
    && typeof value.sortOrder === 'number'
    && isStringArray(value.findingIds);
}

function isPriorityGroup(value: unknown): value is PreviewData['document']['priorityGroups'][number] {
  return isRecord(value)
    && typeof value.order === 'number'
    && typeof value.title === 'string'
    && typeof value.label === 'string'
    && isStringArray(value.findingIds);
}

function isPreviewData(value: unknown): value is PreviewData {
  if (!isRecord(value) || !isRecord(value.document)) return false;
  return isNullableString(value.document.title)
    && Array.isArray(value.document.findings)
    && value.document.findings.every(isFinding)
    && Array.isArray(value.document.phases)
    && value.document.phases.every(isPhaseDefinition)
    && Array.isArray(value.document.priorityGroups)
    && value.document.priorityGroups.every(isPriorityGroup)
    && typeof value.proposedProjectName === 'string'
    && Array.isArray(value.proposedPhases)
    && value.proposedPhases.every(isPhaseDefinition)
    && typeof value.proposedIssueCount === 'number'
    && isStringArray(value.proposedTags);
}

function isCreatedIssue(value: unknown): value is CreatedIssue {
  return isRecord(value)
    && typeof value.findingId === 'string'
    && typeof value.title === 'string'
    && isNullableNumber(value.issueNumber)
    && isNullableString(value.htmlUrl);
}

function isCreatedPhase(value: unknown): value is CreatedPhase {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.id === 'string'
    && isStringArray(value.findingIds)
    && typeof value.sortOrder === 'number';
}

function isTaskAssignment(value: unknown): value is TaskAssignment {
  return isRecord(value)
    && typeof value.findingId === 'string'
    && isNullableNumber(value.issueNumber)
    && isNullableString(value.taskId)
    && isNullableString(value.phaseName)
    && typeof value.status === 'string';
}

function isExecuteResult(value: unknown): value is ExecuteResult {
  return isRecord(value)
    && typeof value.dryRun === 'boolean'
    && isNullableString(value.projectId)
    && (value.appendedToExisting === undefined || typeof value.appendedToExisting === 'boolean')
    && Array.isArray(value.phases)
    && value.phases.every(isCreatedPhase)
    && Array.isArray(value.issues)
    && value.issues.every(isCreatedIssue)
    && Array.isArray(value.assignments)
    && value.assignments.every(isTaskAssignment)
    && isStringArray(value.tags)
    && isStringArray(value.errors);
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const data: unknown = await response.json().catch(() => null);
  if (isRecord(data) && typeof data.error === 'string' && data.error) return data.error;
  return `${fallback} (${response.status})`;
}

/**
 * POST to the intake-document endpoint and return the parsed JSON body.
 * Throws with the API's error message (or a fallback) for non-OK responses,
 * so request failures stay visible to callers instead of being swallowed.
 */
async function postIntake(
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  errorFallback: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(INTAKE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new Error(await readErrorMessage(response, errorFallback));
  }

  const data: unknown = await response.json();
  if (!isRecord(data)) throw new Error(errorFallback);
  return data;
}

/** Preview (or re-preview) a document. Returns null when the response has no `preview` object. */
export async function requestIntakePreview(
  payload: IntakePreviewPayload,
  signal?: AbortSignal,
): Promise<PreviewData | null> {
  const data = await postIntake({ mode: 'preview', ...payload }, signal, 'Request failed');
  if (data.preview === undefined || data.preview === null) return null;
  if (!isPreviewData(data.preview)) throw new Error('Invalid preview response');
  return data.preview;
}

/** Execute the intake: create/append the project, phases, tasks, and tags. */
export async function requestIntakeExecute(
  payload: IntakeExecutePayload,
  signal?: AbortSignal,
): Promise<ExecuteResult | null> {
  const data = await postIntake({ mode: 'execute', ...payload }, signal, 'Execution failed');
  if (data.result === undefined || data.result === null) return null;
  if (!isExecuteResult(data.result)) throw new Error('Invalid execution response');
  return data.result;
}

function isConnectedRepo(value: unknown): value is ConnectedRepo {
  return isRecord(value)
    && typeof value.connectorId === 'string'
    && typeof value.connectorName === 'string'
    && typeof value.repo === 'string'
    && typeof value.displayName === 'string';
}

/**
 * Connected GitHub repos available as execution targets.
 * Non-critical metadata: callers should treat fetch failures as an empty list.
 */
export async function fetchConnectedRepos(signal?: AbortSignal): Promise<ConnectedRepo[]> {
  const response = await fetch('/api/connectors/github-repos', { signal });
  const data: unknown = await response.json();
  const repos = isRecord(data) && Array.isArray(data.repos) ? data.repos : [];
  return repos.filter(isConnectedRepo);
}

export interface HubProjectsMetadata {
  projects: ExistingProject[];
  categories: string[];
}

/**
 * Existing hub projects, plus the distinct categories among them, for the
 * "append to existing project" picker.
 * Non-critical metadata: callers should treat fetch failures as empty lists.
 */
export async function fetchHubProjectsMetadata(signal?: AbortSignal): Promise<HubProjectsMetadata> {
  const response = await fetch('/api/hub-projects', { signal });
  const data: unknown = await response.json();
  const rawProjects = isRecord(data) && Array.isArray(data.projects) ? data.projects : [];

  const projects: ExistingProject[] = rawProjects
    .filter(isRecord)
    .filter((project): project is Record<string, unknown> & { id: string; name: string } =>
      typeof project.id === 'string' && typeof project.name === 'string')
    .map((project) => ({
      id: project.id,
      name: project.name,
      category: typeof project.category === 'string' ? project.category : null,
    }));

  const categories = [...new Set(
    projects
      .map((project) => project.category)
      .filter((category): category is string => typeof category === 'string' && category.length > 0),
  )].sort();

  return { projects, categories };
}
