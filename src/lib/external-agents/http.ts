import 'server-only';

import { apiError, ApiErrors } from '@/lib/api-error';
import { isTrustedMutationRequest, safeEqual } from '@/lib/api/trusted-request';
import { ExternalAgentError, isExternalAgentError } from './errors';
import { getExternalAgent, resolveAgentCredential } from './registry';

export function requireTrustedMutation(request: Request) {
  if (!isTrustedMutationRequest(request)) {
    throw new ExternalAgentError('Unauthorized', 'UNAUTHORIZED', 401);
  }
}

export async function requireAgentAuthentication(request: Request, agentId: string) {
  const agent = await getExternalAgent(agentId);
  if (!agent || !agent.enabled || agent.deletedAt) {
    throw new ExternalAgentError('External agent not found', 'NOT_FOUND', 404);
  }
  const expected = resolveAgentCredential(agent.authCredentialRef);
  if (!expected) {
    throw new ExternalAgentError(
      'Agent authentication is not configured',
      'CREDENTIAL_UNAVAILABLE',
      503,
    );
  }
  const header = request.headers.get('x-mc-agent-key');
  const authorization = request.headers.get('authorization');
  const provided = header
    ?? (authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : null);
  if (!provided || !safeEqual(provided, expected)) {
    throw new ExternalAgentError('Invalid agent credential', 'UNAUTHORIZED', 401);
  }
  return agent;
}

export function externalAgentErrorResponse(error: unknown) {
  if (isExternalAgentError(error)) {
    return apiError(error.message, error.code, error.status);
  }
  return ApiErrors.internal('External-agent operation failed', error);
}

export function publicDispatch<T>(dispatch: T): T {
  if (!dispatch || typeof dispatch !== 'object' || Array.isArray(dispatch)) return dispatch;
  const safe = { ...dispatch } as Record<string, unknown>;
  delete safe.claimTokenHash;
  return safe as T;
}
