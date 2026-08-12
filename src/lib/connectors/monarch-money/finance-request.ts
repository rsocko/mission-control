import 'server-only';

import {
  isSameOriginRequest,
  safeEqual,
} from '@/lib/api/trusted-request';

export type FinanceActorType = 'parent-admin' | 'service';

type FinanceCredentialStatus = 'none' | 'valid' | 'invalid';

function financeCredentialStatus(request: Request): FinanceCredentialStatus {
  const credentials: string[] = [];
  if (request.headers.has('x-mc-api-key')) {
    credentials.push(request.headers.get('x-mc-api-key') ?? '');
  }

  const authorization = request.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer(?:\s+(.*))?$/i);
  if (bearer) {
    credentials.push(bearer[1]?.trim() ?? '');
  }
  if (credentials.length === 0) return 'none';

  const expected = process.env.MC_API_KEY;
  if (!expected) return 'invalid';
  return credentials.every((credential) => safeEqual(credential, expected))
    ? 'valid'
    : 'invalid';
}

export function trustedFinanceMutationActor(request: Request): FinanceActorType | null {
  const credentialStatus = financeCredentialStatus(request);
  if (credentialStatus === 'valid') return 'service';
  if (credentialStatus === 'invalid') return null;
  return isSameOriginRequest(request) ? 'parent-admin' : null;
}

export function isTrustedFinanceReadRequest(request: Request): boolean {
  const credentialStatus = financeCredentialStatus(request);
  if (credentialStatus === 'valid') return true;
  if (credentialStatus === 'invalid') return false;

  if (request.headers.has('origin')) {
    return isSameOriginRequest(request);
  }
  return request.headers.get('sec-fetch-site') === 'same-origin'
    && isSameOriginRequest(request, 'referer');
}
