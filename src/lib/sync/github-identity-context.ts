import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityRunContext,
} from '@/lib/external-identities';
import { GITHUB_IDENTITY_MODE, getGitHubIdentityModeSnapshot } from '@/lib/external-identities';

export class StaleGitHubIdentityContextError extends Error {
  readonly code = 'stale_github_identity_context';

  constructor(
    readonly connectorInstanceId: string,
    readonly frozenRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Queued GitHub identity context revision ${frozenRevision} is stale`
      + ` (current ${currentRevision})`,
    );
    this.name = 'StaleGitHubIdentityContextError';
  }
}

/**
 * Freezes the identity epoch a queued job was planned against. GitHub identity
 * is permanently NodeID-first, so only the revision can go stale.
 */
export function freezeGitHubIdentityContext(
  connectorId: string,
  context: GitHubIdentityRunContext,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  if (context.connectorInstanceId !== connectorId) {
    throw new Error('Frozen GitHub identity context belongs to another connector');
  }
  return Object.freeze({
    connectorInstanceId: context.connectorInstanceId,
    effectiveMode: GITHUB_IDENTITY_MODE,
    modeRevision: context.modeRevision,
    capturedAt,
  });
}

export function validateAndFreezeGitHubIdentityContext(
  connectorId: string,
  context: GitHubIdentityRunContext,
  capturedAt = new Date().toISOString(),
): GitHubIdentityModeSnapshot {
  const frozen = freezeGitHubIdentityContext(connectorId, context, capturedAt);
  const current = getGitHubIdentityModeSnapshot(connectorId, capturedAt);
  if (current.modeRevision !== frozen.modeRevision) {
    throw new StaleGitHubIdentityContextError(
      connectorId,
      frozen.modeRevision,
      current.modeRevision,
    );
  }
  return current;
}
