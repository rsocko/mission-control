import type {
  ProjectHierarchyCommand,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from './hierarchy-types';

export class ProjectHierarchyClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly current?: ProjectHierarchySnapshot,
  ) {
    super(message);
  }
}

type UndoRevision = {
  commandId: string;
  expectedRevision: number;
  undoEntryId?: string;
};

export class ProjectHierarchyUndoTracker {
  private entries: UndoRevision[] = [];

  push(commandId: string, expectedRevision: number) {
    this.entries.push({ commandId, expectedRevision });
  }

  attachUndoEntry(commandId: string, undoEntryId: string) {
    const entry = this.entries.find((candidate) => candidate.commandId === commandId);
    if (entry) entry.undoEntryId = undoEntryId;
  }

  validationError(commandId: string) {
    const latest = this.entries.at(-1);
    return latest?.commandId === commandId
      ? null
      : 'Undo newer project hierarchy changes first';
  }

  expectedRevision(commandId: string) {
    const validationError = this.validationError(commandId);
    if (validationError) throw new Error(validationError);
    const latest = this.entries.at(-1)!;
    return latest.expectedRevision;
  }

  complete(commandId: string, resultRevision: number) {
    this.expectedRevision(commandId);
    this.entries.pop();
    const previous = this.entries.at(-1);
    if (previous) previous.expectedRevision = resultRevision;
  }

  clear() {
    const undoEntryIds = this.entries.flatMap((entry) => (
      entry.undoEntryId ? [entry.undoEntryId] : []
    ));
    this.entries = [];
    return undoEntryIds;
  }
}

async function parseError(response: Response) {
  return await response.json().catch(() => null) as {
    error?: string;
    code?: string;
    current?: ProjectHierarchySnapshot;
  } | null;
}

export async function loadProjectHierarchy(projectId: string) {
  const response = await fetch(`/api/projects/${projectId}/hierarchy`);
  if (!response.ok) {
    const payload = await parseError(response);
    throw new ProjectHierarchyClientError(
      payload?.error ?? 'Failed to load project hierarchy',
      response.status,
      payload?.code,
      payload?.current,
    );
  }
  const payload = await response.json() as { hierarchy: ProjectHierarchySnapshot };
  return payload.hierarchy;
}

export async function executeProjectHierarchyCommand(input: {
  projectId: string;
  expectedRevision: number;
  command: ProjectHierarchyCommand;
  commandId?: string;
}) {
  const commandId = input.commandId ?? crypto.randomUUID();
  const request = {
    commandId,
    expectedRevision: input.expectedRevision,
    command: input.command,
  };
  let response: Response;
  try {
    response = await fetch(`/api/projects/${input.projectId}/hierarchy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  } catch {
    response = await fetch(`/api/projects/${input.projectId}/hierarchy`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
  }
  if (!response.ok) {
    const payload = await parseError(response);
    throw new ProjectHierarchyClientError(
      payload?.error ?? 'Failed to update project hierarchy',
      response.status,
      payload?.code,
      payload?.current,
    );
  }
  return await response.json() as ProjectHierarchyCommandResult;
}
