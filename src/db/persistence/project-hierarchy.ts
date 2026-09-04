import type {
  ProjectHierarchyCommandRequest,
  ProjectHierarchyCommandResult,
  ProjectHierarchySnapshot,
} from '@/lib/projects/hierarchy-types';
import type { ProjectPhaseItem } from '@/types';

/**
 * Backend-neutral project-hierarchy command/read boundary (L15).
 *
 * The contract is operation-shaped rather than a query facade: it carries only
 * opaque string IDs, ISO timestamps, numbers, booleans, the hierarchy command
 * request/result/snapshot value types, and {@link ProjectHierarchyServiceError}.
 * No driver, transaction, SQL fragment, table row, or backend selector ever
 * crosses it.
 */

export interface ProjectHierarchyActor {
  type: 'user' | 'system' | 'ai';
  id?: string;
}

export class ProjectHierarchyServiceError extends Error {
  readonly status: 400 | 403 | 404 | 409;
  readonly code: string;
  readonly current?: ProjectHierarchySnapshot;

  constructor(
    message: string,
    status: 400 | 403 | 404 | 409,
    code: string,
    current?: ProjectHierarchySnapshot,
  ) {
    super(message);
    this.status = status;
    this.code = code;
    this.current = current;
  }
}

export interface CommittedProjectHierarchyCommand {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  result: ProjectHierarchyCommandResult;
}

export interface ApplyProjectHierarchyCommandInput {
  projectId: string;
  request: ProjectHierarchyCommandRequest;
  actor?: ProjectHierarchyActor;
}

export interface ProjectHierarchyPersistence {
  /** Current hierarchy for a project, or `null` when the project is unknown. */
  getSnapshot(projectId: string): Promise<ProjectHierarchySnapshot | null>;
  /** Durable idempotency lookup for exact replay and conflict resolution. */
  findCommittedCommand(commandId: string): Promise<CommittedProjectHierarchyCommand | null>;
  /**
   * Atomically re-checks command replay, locks and loads authoritative state,
   * applies exactly one command, advances the revision when the command
   * changed anything, writes the audit row, and returns the committed result.
   */
  applyAuthorizedCommand(
    input: ApplyProjectHierarchyCommandInput,
  ): Promise<ProjectHierarchyCommandResult>;
  /** Resolves the owning project for a phase-scoped compatibility command. */
  findPhaseProjectId(phaseId: string): Promise<string | null>;
  /** Public phase-item shape in deterministic order. */
  listPhaseItems(phaseId: string): Promise<ProjectPhaseItem[]>;
  /** Resolves the task targeted by a phase-item PATCH, or `null`. */
  findPhaseItemTask(phaseId: string, itemId: string): Promise<string | null>;
}

/**
 * PostgreSQL `jsonb` normalizes and reorders object keys and drops `undefined`
 * members, so durable command replay must compare requests structurally rather
 * than by serialized bytes. Key order, absent keys, and explicitly-`undefined`
 * keys are all equivalent; arrays stay order-sensitive.
 */
export function sameProjectHierarchyRequest(
  left: ProjectHierarchyCommandRequest,
  right: ProjectHierarchyCommandRequest,
): boolean {
  return canonicallyEqual(left, right);
}

function canonicallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    return left.length === right.length
      && left.every((value, index) => canonicallyEqual(value, right[index]));
  }
  if (
    typeof left !== 'object' || typeof right !== 'object'
    || left === null || right === null
  ) {
    return false;
  }
  const leftKeys = definedKeys(left as Record<string, unknown>);
  const rightKeys = definedKeys(right as Record<string, unknown>);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => (
    key === rightKeys[index]
    && canonicallyEqual(
      (left as Record<string, unknown>)[key],
      (right as Record<string, unknown>)[key],
    )
  ));
}

function definedKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
}

/**
 * Shared replay/conflict resolution for an already-committed command ID. Reuse
 * with a canonically equal request on the same project returns the first
 * committed result; any other reuse is a stable `409 COMMAND_ID_CONFLICT`.
 */
export function resolveCommittedProjectHierarchyCommand(
  committed: CommittedProjectHierarchyCommand,
  input: { projectId: string; request: ProjectHierarchyCommandRequest },
): ProjectHierarchyCommandResult {
  if (
    committed.projectId !== input.projectId
    || !sameProjectHierarchyRequest(committed.request, input.request)
  ) {
    throw new ProjectHierarchyServiceError(
      'Command ID has already been used for a different request',
      409,
      'COMMAND_ID_CONFLICT',
    );
  }
  return committed.result;
}
