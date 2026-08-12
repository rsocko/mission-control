import { and, eq, isNotNull } from 'drizzle-orm';
import { runTransaction } from '@/db';
import {
  externalEntityBindings,
  githubIdentityModeEvents,
} from '@/db/schema';
import type {
  GitHubIdentityTransitionRequest,
  GitHubIdentityTransitionResult,
} from './comparison-types';
import { getGitHubStablePrimaryEligibility } from './comparison-status';
import {
  getGitHubIdentityModeSnapshotInTransaction,
  transitionGitHubIdentityModeAuthoritativelyInTransaction,
} from './mode-control';

export interface GitHubStablePrimaryCommand {
  connectorInstanceId: string;
  expectedRevision: number;
  actor: string;
  reason: string;
  idempotencyKey: string;
  now?: string;
}

export function enableGitHubStablePrimary(
  command: GitHubStablePrimaryCommand,
): GitHubIdentityTransitionResult {
  return runTransaction((tx) => {
    const request: GitHubIdentityTransitionRequest = {
      ...command,
      targetPhase: 'stable_primary',
      stablePrimaryEnabled: true,
      gate: { code: 'stage_two_ready', passed: true },
    };
    const replay = tx.select({ id: githubIdentityModeEvents.id })
      .from(githubIdentityModeEvents)
      .where(and(
        eq(githubIdentityModeEvents.connectorInstanceId, command.connectorInstanceId),
        eq(githubIdentityModeEvents.idempotencyKey, command.idempotencyKey),
      ))
      .limit(1)
      .get();
    if (replay) {
      return transitionGitHubIdentityModeAuthoritativelyInTransaction(tx, request);
    }

    const now = command.now ?? new Date().toISOString();
    const current = getGitHubIdentityModeSnapshotInTransaction(
      tx,
      command.connectorInstanceId,
      now,
    );
    if (current.modeRevision !== command.expectedRevision) {
      return transitionGitHubIdentityModeAuthoritativelyInTransaction(tx, request);
    }
    const eligibility = getGitHubStablePrimaryEligibility(command.connectorInstanceId, now);
    if (!eligibility.eligible) {
      return {
        ok: false,
        code: 'gate_failed',
        message: `Stage 2 eligibility failed: ${eligibility.blockers.join(', ')}`,
        snapshot: getGitHubIdentityModeSnapshotInTransaction(
          tx,
          command.connectorInstanceId,
          now,
        ),
      };
    }

    const transitioned = transitionGitHubIdentityModeAuthoritativelyInTransaction(tx, request);
    if (transitioned.ok && transitioned.changed) {
      tx.update(externalEntityBindings).set({
        state: 'active',
        updatedAt: now,
      }).where(and(
        eq(externalEntityBindings.connectorInstanceId, command.connectorInstanceId),
        eq(externalEntityBindings.state, 'shadow'),
        isNotNull(externalEntityBindings.verifiedAt),
      )).run();
    }
    return transitioned;
  });
}

export function rollbackGitHubStablePrimary(
  command: GitHubStablePrimaryCommand,
): GitHubIdentityTransitionResult {
  return runTransaction((tx) => transitionGitHubIdentityModeAuthoritativelyInTransaction(tx, {
    ...command,
    targetPhase: 'rollback_legacy',
    stablePrimaryEnabled: false,
    gate: { code: 'rollback', passed: true },
  }));
}
