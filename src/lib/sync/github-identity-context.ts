import type {
  GitHubIdentityModeSnapshot,
  GitHubIdentityRunContext,
} from '@/lib/external-identities';
import { getGitHubIdentityModeSnapshot } from '@/lib/external-identities';

export class StaleGitHubIdentityContextError extends Error {
  readonly code = 'stale_github_identity_context';

  constructor(
    readonly connectorInstanceId: string,
    readonly frozenMode: GitHubIdentityRunContext['effectiveMode'],
    readonly frozenRevision: number,
    readonly currentMode: GitHubIdentityRunContext['effectiveMode'],
    readonly currentRevision: number,
  ) {
    super(
      `Queued GitHub identity context ${frozenMode}:${frozenRevision} is stale`
      + ` (current ${currentMode}:${currentRevision})`,
    );
    this.name = 'StaleGitHubIdentityContextError';
  }
}

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
    phase: context.effectiveMode === 'stable'
      ? 'stable_primary'
      : context.effectiveMode === 'comparison'
        ? 'comparing'
        : null,
    effectiveMode: context.effectiveMode,
    stablePrimaryEnabled: context.effectiveMode === 'stable',
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
  if (
    current.effectiveMode !== frozen.effectiveMode
    || current.modeRevision !== frozen.modeRevision
    || current.stablePrimaryEnabled !== frozen.stablePrimaryEnabled
  ) {
    throw new StaleGitHubIdentityContextError(
      connectorId,
      frozen.effectiveMode,
      frozen.modeRevision,
      current.effectiveMode,
      current.modeRevision,
    );
  }
  return current;
}

export const freezeGitHubComparisonIdentityContext = freezeGitHubIdentityContext;
