import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityRunContext,
} from '@/lib/external-identities/stable-identity-types';
import { GITHUB_IDENTITY_MODE } from '@/lib/external-identities/stable-identity-types';
import { getGitHubIdentityRepository } from '@/lib/external-identities/worker-persistence';

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

export async function validateAndFreezeGitHubIdentityContext(
  connectorId: string,
  context: GitHubIdentityRunContext,
  capturedAt = new Date().toISOString(),
): Promise<GitHubIdentityModeSnapshot> {
  const frozen = freezeGitHubIdentityContext(connectorId, context, capturedAt);
  const identity = await getGitHubIdentityRepository();
  const current = await identity.getModeSnapshot(connectorId, capturedAt);
  if (current.modeRevision !== frozen.modeRevision) {
    throw new StaleGitHubIdentityContextError(
      connectorId,
      frozen.modeRevision,
      current.modeRevision,
    );
  }
  return current;
}
